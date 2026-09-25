import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
await app.register(multipart, {
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 15,
    // 15 images produce 30 multipart fields (role + file), plus prompt and
    // generation settings.
    fields: 40,
    parts: 64,
    fieldSize: 256 * 1024
  }
});
await app.register(fastifyStatic, {
  root,
  prefix: '/',
  index: false,
  // Keep source files, test images, and deployment artifacts off the public path.
  allowedPath: filePath => ['index.html', 'app.js', 'styles.css'].includes(path.basename(filePath))
});

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error }, 'Unhandled request error');
  if (reply.sent) return;
  const statusCode = error.name === 'TimeoutError' || error.name === 'AbortError' ? 504 : Number(error.statusCode) >= 400 && Number(error.statusCode) < 500 ? Number(error.statusCode) : 500;
  reply.code(statusCode).send({ error: statusCode === 504 ? 'Upstream request timed out. Please retry.' : 'Request failed.' });
});

// Apply backpressure before multipart starts buffering large reference files.
app.addHook('onRequest', async request => {
  if (request.url.split('?')[0] !== '/api/generate') return;
  const release = await acquireGenerationSlot();
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };
  request.generationRelease = releaseOnce;
  request.raw.once('aborted', releaseOnce);
});

app.addHook('onResponse', async request => {
  request.generationRelease?.();
});

const UPSTREAM_TIMEOUT_MS = Math.max(10_000, Number(process.env.UPSTREAM_TIMEOUT_MS || 120_000));
const MAX_PROMPT_CHARS = Math.max(1_000, Number(process.env.MAX_PROMPT_CHARS || 20_000));
const ALLOWED_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536', '2048x2048', '4096x4096']);
const MAX_UPSTREAM_CONCURRENCY = Math.max(1, Number(process.env.UPSTREAM_CONCURRENCY || 8));
const MAX_UPSTREAM_WAITERS = Math.max(1, Number(process.env.MAX_UPSTREAM_WAITERS || 64));
const MAX_GENERATION_CONCURRENCY = Math.max(1, Number(process.env.GENERATION_CONCURRENCY || MAX_UPSTREAM_CONCURRENCY));
const MAX_GENERATION_WAITERS = Math.max(1, Number(process.env.MAX_GENERATION_WAITERS || 64));
let activeUpstreamRequests = 0;
const upstreamWaiters = [];
let activeGenerationRequests = 0;
const generationWaiters = [];

class UpstreamBusyError extends Error {
  constructor() {
    super('The image service is busy. Please retry shortly.');
    this.name = 'UpstreamBusyError';
    this.statusCode = 429;
  }
}

async function withUpstreamSlot(task) {
  if (activeUpstreamRequests >= MAX_UPSTREAM_CONCURRENCY) {
    if (upstreamWaiters.length >= MAX_UPSTREAM_WAITERS) throw new UpstreamBusyError();
    await new Promise(resolve => upstreamWaiters.push(resolve));
  }
  activeUpstreamRequests += 1;
  try {
    return await task();
  } finally {
    activeUpstreamRequests -= 1;
    upstreamWaiters.shift()?.();
  }
}

async function acquireGenerationSlot() {
  if (activeGenerationRequests >= MAX_GENERATION_CONCURRENCY) {
    if (generationWaiters.length >= MAX_GENERATION_WAITERS) throw new UpstreamBusyError();
    await new Promise(resolve => generationWaiters.push(resolve));
  }
  activeGenerationRequests += 1;
  return () => {
    if (activeGenerationRequests > 0) activeGenerationRequests -= 1;
    generationWaiters.shift()?.();
  };
}

function upstreamSignal() {
  return AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
}

class UpstreamResponseError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'UpstreamResponseError';
    this.statusCode = statusCode;
  }
}

const json = async (response) => {
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > 50 * 1024 * 1024) throw new UpstreamResponseError('Upstream response is too large.', 502);
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!response.ok) throw new UpstreamResponseError(body?.error?.message || body?.message || `HTTP ${response.status}`, response.status);
  return body;
};

function isMpo(image) {
  const name = String(image.filename || '').toLowerCase();
  return name.endsWith('.mpo') || String(image.mimetype || '').toLowerCase() === 'image/mpo'
    || image.buffer.subarray(0, Math.min(image.buffer.length, 128 * 1024)).includes(Buffer.from('MPF\0'));
}

function extractFirstJpeg(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  for (let i = 2; i < buffer.length - 1; i += 1) {
    if (buffer[i] === 0xff && buffer[i + 1] === 0xd9) return buffer.subarray(0, i + 2);
  }
  return null;
}

const referenceMaxBytes = 4 * 1024 * 1024;
const referenceMaxDimensions = [2048, 1600, 1280, 1024];
const referenceQualities = [82, 72, 62, 52];

async function compressReference(source) {
  let best;
  for (const maxDimension of referenceMaxDimensions) {
    for (const quality of referenceQualities) {
      const output = await sharp(source, { page: 0 })
        .rotate()
        .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      best = output;
      if (output.length <= referenceMaxBytes) return output;
    }
  }
  return best;
}

async function convertWebpToPng(source) {
  let best;
  for (const maxDimension of referenceMaxDimensions) {
    const output = await sharp(source, { page: 0 })
      .rotate()
      .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true, effort: 10 })
      .toBuffer();
    best = output;
    if (output.length <= referenceMaxBytes) return output;
  }
  return best;
}

app.get('/api/health', async () => ({ ok: true }));

app.post('/api/refine', async (request, reply) => {
  const body = request.body || {};
  // Provider credentials stay on the server. Never accept a key from the browser.
  const apiKey = String(process.env.REFINE_API_KEY || '').trim();
  const prompt = String(body.prompt || '').trim();
  if (!apiKey) return reply.code(503).send({ error: 'Prompt refinement is not configured on the server.' });
  if (prompt.length > MAX_PROMPT_CHARS) return reply.code(413).send({ error: `Prompt is limited to ${MAX_PROMPT_CHARS} characters.` });
  if (!prompt) return reply.code(400).send({ error: 'Please enter a prompt.' });
  const instruction = `You are an expert image prompt editor. Rewrite the user's prompt into a precise, vivid prompt for an image generation model. Preserve the user's intent. Add useful details about subject, composition, lighting, camera, materials, style, color, and constraints only when they help. Do not explain your changes. Return only the final prompt, in the same language as the user when practical.\n\nUser prompt:\n${prompt}`;
  const data = await withUpstreamSlot(async () => {
    const response = await fetch('https://sub1.happycoding.online/v1/chat/completions', {
      method: 'POST', signal: upstreamSignal(), headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ model: process.env.REFINE_MODEL || 'gpt-5.6-sol', messages: [{ role: 'user', content: instruction }], temperature: 0.7 })
    });
    return json(response);
  });
  const refined = data?.choices?.[0]?.message?.content?.trim() || '';
  if (!refined) return reply.code(502).send({ error: '润色接口没有返回文本' });
  return { refined };
});

app.post('/api/generate', async (request, reply) => {
  const parts = request.parts();
  const fields = {}; const images = [];
  let currentReferenceRole = '';
  let totalReferenceBytes = 0;
  const roleCounts = { product: 0, action: 0, atmosphere: 0 };
  const MAX_REFERENCES_TOTAL = 15;
  const MAX_REFERENCES_PER_ROLE = 5;
  const MAX_REFERENCES_BYTES = 60 * 1024 * 1024;
  try {
    for await (const part of parts) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        totalReferenceBytes += buffer.length;
        if (totalReferenceBytes > MAX_REFERENCES_BYTES) throw Object.assign(new Error('Reference images exceed the total upload limit.'), { code: 'FST_REQ_FILE_TOO_LARGE' });
        const role = ['product', 'action', 'atmosphere'].includes(currentReferenceRole) ? currentReferenceRole : 'product';
        roleCounts[role] += 1;
        if (roleCounts[role] > MAX_REFERENCES_PER_ROLE || images.length >= MAX_REFERENCES_TOTAL) {
          throw Object.assign(new Error('Too many reference images for one request.'), { code: 'FST_REQ_PARTS_LIMIT' });
        }
        images.push({ buffer, filename: part.filename, mimetype: part.mimetype, role });
      } else {
        if (part.fieldname === 'referenceRole') currentReferenceRole = String(part.value || '').trim().toLowerCase();
        fields[part.fieldname] = part.value;
      }
    }
  } catch (error) {
    request.log.warn({ err: error }, 'Multipart request rejected');
    const statusCode = error.code === 'FST_REQ_FILE_TOO_LARGE' || error.code === 'FST_REQ_PARTS_LIMIT' ? 413 : 400;
    return reply.code(statusCode).send({ error: statusCode === 413 ? 'Reference images or form data exceed the upload limit.' : 'Invalid multipart request.' });
  }
  if (images.length < 1 || roleCounts.product < 1) return reply.code(400).send({ error: '请至少上传 1 张产品细节参考图。' });
  if (images.length > MAX_REFERENCES_TOTAL) return reply.code(400).send({ error: `最多支持 ${MAX_REFERENCES_TOTAL} 张参考图，每个模块最多 ${MAX_REFERENCES_PER_ROLE} 张。` });
  for (let index = 0; index < images.length; index += 1) {
    let image = images[index];
    const filename = String(image.filename || '').toLowerCase();
    const supported = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/mpo'].includes(String(image.mimetype || '').toLowerCase())
      || /\.(png|jpe?g|webp|mpo)$/.test(filename);
    if (!supported) return reply.code(400).send({ error: '参考图格式不支持。请将 MPO、HEIC 或 Live Photo 导出为单张 PNG、JPG 或 WebP 后再上传。' });
    try {
      let source = image.buffer;
      try {
        const isWebp = String(image.mimetype || '').toLowerCase() === 'image/webp' || /\.webp$/i.test(filename);
        const converted = isWebp ? await convertWebpToPng(source) : await compressReference(source);
        images[index] = { ...image, buffer: converted, filename: `reference-${index + 1}.${isWebp ? 'png' : 'jpg'}`, mimetype: isWebp ? 'image/png' : 'image/jpeg' };
      } catch (directError) {
        const firstFrame = extractFirstJpeg(source);
        if (!firstFrame) throw directError;
        const compressed = await compressReference(firstFrame);
        images[index] = { ...image, buffer: compressed, filename: `reference-${index + 1}.jpg`, mimetype: 'image/jpeg' };
      }
    } catch (error) {
      request.log.warn({ err: error }, 'Reference image conversion failed');
      return reply.code(400).send({ error: isMpo(image) ? `第 ${index + 1} 张 MPO 参考图无法读取，请换一张普通单帧 JPG 或 PNG。` : `第 ${index + 1} 张参考图无法读取，请重新导出为普通 JPG 或 PNG 后再上传。` });
    }
  }
  // Provider credentials stay on the server. Never accept a key from the browser.
  const apiKey = String(process.env.IMAGE_API_KEY || '').trim();
  const prompt = String(fields.prompt || '').trim();
  const model = 'gpt-image-2.5-sunburst';
  if (!apiKey) return reply.code(503).send({ error: 'Image generation is not configured on the server.' });
  if (prompt.length > MAX_PROMPT_CHARS) return reply.code(413).send({ error: `Prompt is limited to ${MAX_PROMPT_CHARS} characters.` });
  const size = String(fields.size || '1024x1024');
  if (!ALLOWED_SIZES.has(size)) return reply.code(400).send({ error: 'Unsupported image size.' });
  if (!prompt) return reply.code(400).send({ error: 'Please enter a prompt.' });
  const form = new FormData();
  form.append('model', model); form.append('prompt', prompt); form.append('n', '1'); form.append('quality', 'max'); form.append('size', size);
  for (const image of images) form.append('image[]', new Blob([image.buffer], { type: image.mimetype }), image.filename);
  const imageApiBase = String(process.env.IMAGE_API_BASE_URL || 'https://api.duolapi.cn').replace(/\/+$/, '');
  const endpoint = images.length ? `${imageApiBase}/v1/images/edits` : `${imageApiBase}/v1/images/generations`;
  let data;
  try {
    data = await withUpstreamSlot(async () => {
      const response = await fetch(endpoint, {
        method: 'POST', signal: upstreamSignal(),
        headers: images.length
          ? { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
          : { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: images.length ? form : JSON.stringify({ model, prompt, n: 1, quality: 'max', size })
      });
      return json(response);
    });
  } catch (error) {
    request.log.warn({ err: error }, 'Image provider request failed');
    const statusCode = error.statusCode === 429 ? 429 : error.name === 'TimeoutError' || error.name === 'AbortError' ? 504 : 502;
    const message = String(error.message || '').includes('No available channel for model')
      ? '当前 API 分组没有可用的 gpt-image-2.5-sunburst 图片生成通道，请检查 API 分组配置后重试。'
      : `生图服务暂时不可用：${error.message}`;
    return reply.code(statusCode).send({ error: message });
  }
  const item = data?.data?.[0];
  if (!item?.url && !item?.b64_json) return reply.code(502).send({ error: '生图接口没有返回图片' });
  return { ...item, endpoint: images.length ? 'edits' : 'generations' };
});

app.get('/', async (_, reply) => reply.sendFile('index.html'));
const port = Number(process.env.PORT || 4173);
app.listen({ port, host: '0.0.0.0' }).then(() => console.log(`Image panel listening on port ${port}`));
