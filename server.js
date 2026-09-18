import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const app = Fastify({ logger: true });
await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
await app.register(fastifyStatic, { root, prefix: '/' });

const json = async (response) => {
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(body?.error?.message || body?.message || `HTTP ${response.status}`);
  return body;
};

app.get('/api/health', async () => ({ ok: true }));

app.post('/api/refine', async (request, reply) => {
  const body = request.body || {};
  const apiKey = String(body.apiKey || process.env.REFINE_API_KEY || '').trim();
  const prompt = String(body.prompt || '').trim();
  if (!apiKey || !prompt) return reply.code(400).send({ error: '请填写润色 API Key 和原始提示词' });
  const instruction = `You are an expert image prompt editor. Rewrite the user's prompt into a precise, vivid prompt for an image generation model. Preserve the user's intent. Add useful details about subject, composition, lighting, camera, materials, style, color, and constraints only when they help. Do not explain your changes. Return only the final prompt, in the same language as the user when practical.\n\nUser prompt:\n${prompt}`;
  const response = await fetch('https://sub1.happycoding.online/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.REFINE_MODEL || 'gpt-5.6-sol', messages: [{ role: 'user', content: instruction }], temperature: 0.7 })
  });
  const data = await json(response);
  const refined = data?.choices?.[0]?.message?.content?.trim() || '';
  if (!refined) return reply.code(502).send({ error: '润色接口没有返回文本' });
  return { refined };
});

app.post('/api/generate', async (request, reply) => {
  const parts = request.parts();
  const fields = {}; let image;
  for await (const part of parts) {
    if (part.type === 'file') image = { buffer: await part.toBuffer(), filename: part.filename, mimetype: part.mimetype };
    else fields[part.fieldname] = part.value;
  }
  const apiKey = String(fields.apiKey || process.env.IMAGE_API_KEY || '').trim();
  const prompt = String(fields.prompt || '').trim();
  const model = 'gpt-image-2.5-sunburst';
  if (!apiKey || !prompt) return reply.code(400).send({ error: '请填写生图 API Key 和提示词' });
  const form = new FormData();
  form.append('model', model); form.append('prompt', prompt); form.append('n', '1'); form.append('size', String(fields.size || '1024x1024'));
  if (image) form.append('image', new Blob([image.buffer], { type: image.mimetype }), image.filename || 'reference.png');
  const imageApiBase = process.env.IMAGE_API_BASE_URL || 'https://api.duolapi.cn';
  const endpoint = image ? `${imageApiBase}/v1/images/edits` : `${imageApiBase}/v1/images/generations`;
  let data;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: image
        ? { Authorization: `Bearer ${apiKey}` }
        : { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: image ? form : JSON.stringify({ model, prompt, n: 1, size: String(fields.size || '1024x1024') })
    });
    data = await json(response);
  } catch (error) {
    request.log.warn({ err: error }, 'Image provider request failed');
    const message = error.message.includes('No available channel for model')
      ? '当前 API 分组没有可用的 gpt-image-2.5-sunburst 图片生成通道，请检查 API 分组配置后重试。'
      : `生图服务暂时不可用：${error.message}`;
    return reply.code(502).send({ error: message });
  }
  const item = data?.data?.[0];
  if (!item?.url && !item?.b64_json) return reply.code(502).send({ error: '生图接口没有返回图片' });
  return { ...item, endpoint: image ? 'edits' : 'generations' };
});

app.get('/', async (_, reply) => reply.sendFile('index.html'));
const port = Number(process.env.PORT || 4173);
app.listen({ port, host: '0.0.0.0' }).then(() => console.log(`Image panel listening on port ${port}`));
