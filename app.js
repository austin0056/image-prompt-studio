const $ = (id) => document.getElementById(id);
const message = $('message');
const queue = [];
// Each semantic slot keeps its own ordered list. Keeping the lists separate is
// important: the provider receives image files in order, while the role map
// tells the prompt which images are product, action, or atmosphere references.
const selectedReferences = [[], [], []];
const referenceRoles = ['产品细节', '动作指导', '整体氛围'];
const referenceRoleKeys = ['product', 'action', 'atmosphere'];
const referenceDescriptions = [
  '可上传多个角度；锁定产品身份、结构、比例与关键细节。',
  '可上传多个动作或模特姿态；约束手部接触、受力和真实物理关系。',
  '可上传多个氛围样片；只参考镜头、光线、色调与画面风格。'
];
const maxReferencesPerRole = 5;
const queueStorageKey = 'image-prompt-queue-v2';
const maxClientConcurrency = 4;
let nextJobId = 1;
let processing = false;

function setMessage(text, tone = 'neutral') {
  message.textContent = text;
  message.dataset.tone = tone;
}
function setBusy(button, busy, label) {
  button.disabled = busy;
  if (busy) {
    button.dataset.idleLabel ??= button.textContent;
    button.textContent = label;
  } else if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
}
function showError(error) { setMessage(error?.message || String(error), 'error'); }

function isValidReference(file) {
  if (!file) return false;
  const name = String(file.name || '').toLowerCase();
  return ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/mpo'].includes(file.type?.toLowerCase())
    || /\.(png|jpe?g|webp|mpo)$/.test(name);
}

function referenceKey(file) {
  return `${file.name}:${file.size}:${file.lastModified || 0}`;
}

function renderReferencePreviews() {
  const preview = $('referencePreview');
  if (!preview) return;
  preview.querySelectorAll('img').forEach((image) => {
    if (image.src.startsWith('blob:')) URL.revokeObjectURL(image.src);
  });
  preview.replaceChildren();
  selectedReferences.forEach((files, index) => {
    const item = document.createElement('article');
    item.className = `referencePreviewItem${files.length ? ' is-filled' : ' is-empty'}${index === 0 ? ' is-required' : ''}`;
    item.dataset.slot = String(index);
    item.dataset.count = String(files.length);
    item.addEventListener('dragover', (event) => { event.preventDefault(); item.classList.add('dragging'); });
    item.addEventListener('dragleave', () => item.classList.remove('dragging'));
    item.addEventListener('drop', (event) => {
      event.preventDefault(); item.classList.remove('dragging'); addReferencesToRole(index, [...(event.dataTransfer.files || [])]);
    });
    const heading = document.createElement('div');
    heading.className = 'referencePreviewHeading';
    heading.innerHTML = `<span class="referenceIndex">0${index + 1}</span><span class="referenceHeadingCopy"><strong>${referenceRoles[index]}</strong><small>${index === 0 ? '至少上传 1 张产品图' : '可选，按语义单独上传'}</small></span><span class="referenceSlotCount">${files.length} / ${maxReferencesPerRole}</span>`;
    item.append(heading);
    const description = document.createElement('p');
    description.className = 'referenceDescription';
    description.textContent = referenceDescriptions[index];
    item.append(description);
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true; input.className = 'referenceSlotInput';
    input.accept = 'image/png,image/jpeg,image/webp,image/mpo,.mpo';
    input.addEventListener('change', (event) => { addReferencesToRole(index, [...(event.target.files || [])]); event.target.value = ''; });
    item.append(input);
    const media = document.createElement('div');
    media.className = 'referenceMedia referenceMediaGrid';
    files.forEach((file, fileIndex) => {
      const imageWrap = document.createElement('div'); imageWrap.className = 'referenceThumb';
      const image = document.createElement('img'); image.src = URL.createObjectURL(file); image.alt = `${referenceRoles[index]}参考图 ${fileIndex + 1}`;
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'referenceRemove'; remove.setAttribute('aria-label', `删除${referenceRoles[index]}参考图 ${fileIndex + 1}`); remove.textContent = '×';
      remove.addEventListener('click', (event) => { event.stopPropagation(); selectedReferences[index].splice(fileIndex, 1); renderReferencePreviews(); });
      imageWrap.append(image, remove); media.append(imageWrap);
    });
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'referenceEmpty referenceAdd';
    const atLimit = files.length >= maxReferencesPerRole;
    add.disabled = atLimit;
    add.classList.toggle('is-limit', atLimit);
    add.innerHTML = `<span class="uploadGlyph">${atLimit ? '✓' : '＋'}</span><span class="referenceAddCopy"><strong>${atLimit ? '已达上传上限' : files.length ? '继续添加' : '拖放或选择图片'}</strong><small>${atLimit ? '最多 5 张参考图' : `最多 ${maxReferencesPerRole} 张 · JPG / PNG / WebP / MPO`}</small></span>`;
    add.addEventListener('click', () => input.click());
    media.append(add);
    item.append(media);
    preview.append(item);
  });
  $('referencePreviewWrap')?.classList.remove('hidden');
  if ($('fileName')) $('fileName').textContent = `${selectedReferences.reduce((count, files) => count + files.length, 0)} / ${maxReferencesPerRole * 3}`;
}

function addReferencesToRole(index, files) {
  const valid = files.filter(isValidReference);
  if (valid.length !== files.length) showError(new Error('参考图只支持 JPG、PNG、WebP 或 MPO。'));
  const current = selectedReferences[index];
  const existing = new Set(current.map(referenceKey));
  const available = Math.max(0, maxReferencesPerRole - current.length);
  let skipped = 0;
  const additions = valid.filter((file) => {
    const key = referenceKey(file);
    if (existing.has(key)) { skipped += 1; return false; }
    existing.add(key); return true;
  }).slice(0, available);
  skipped += Math.max(0, valid.length - additions.length - skipped);
  if (skipped) showError(new Error(`${referenceRoles[index]}最多支持 ${maxReferencesPerRole} 张不重复参考图。`));
  current.push(...additions);
  if (additions.length) { renderReferencePreviews(); setMessage(`${referenceRoles[index]}已添加 ${additions.length} 张参考图。`, 'success'); }
}

const referenceInput = $('reference');
referenceInput?.addEventListener('change', (event) => {
  const files = [...(event.target.files || [])]; event.target.value = '';
  addReferencesToRole(0, files);
});
const referenceDropzone = referenceInput?.closest('.upload');
referenceDropzone?.addEventListener('dragover', (event) => { event.preventDefault(); referenceDropzone.classList.add('dragging'); });
referenceDropzone?.addEventListener('dragleave', () => referenceDropzone.classList.remove('dragging'));
referenceDropzone?.addEventListener('drop', (event) => {
  event.preventDefault(); referenceDropzone.classList.remove('dragging');
  const files = [...(event.dataTransfer.files || [])];
  addReferencesToRole(0, files);
});

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

$('refine')?.addEventListener('click', async () => {
  const prompt = $('prompt').value.trim();
  if (!prompt) return showError(new Error('请先填写原始提示词。'));
  const button = $('refine'); setBusy(button, true, '润色中…'); setMessage('正在整理提示词…');
  try {
    const response = await fetch('/api/refine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) });
    const data = await readJson(response); $('prompt').value = data.refined || prompt; setMessage('提示词已更新，可以继续调整或生成。', 'success');
  } catch (error) { showError(error); } finally { setBusy(button, false); }
});

function persistQueue() {
  try {
    const saved = queue.filter((job) => ['done', 'failed'].includes(job.status)).map((job) => ({
      id: job.id, status: job.status, prompt: job.prompt, model: job.model, size: job.size,
      quality: job.quality || 'max', visualStyle: job.visualStyle || 'photography',
      renderMaterial: job.renderMaterial || 'auto', source: job.source || null,
      error: job.error || '', createdAt: job.createdAt
    }));
    localStorage.setItem(queueStorageKey, JSON.stringify(saved.slice(-100)));
  } catch (error) { console.warn('Unable to persist queue history', error); }
}
function restoreQueue() {
  try {
    const saved = JSON.parse(localStorage.getItem(queueStorageKey) || '[]');
    if (!Array.isArray(saved)) return;
    saved.forEach((job) => {
      if (!job?.prompt || !['done', 'failed'].includes(job.status)) return;
      queue.push({ ...job, references: [] }); nextJobId = Math.max(nextJobId, Number(job.id || 0) + 1);
    });
  } catch (error) { console.warn('Unable to restore queue history', error); }
}
const queueLabels = { queued: '排队中', running: '生成中', done: '已完成', failed: '失败' };
function openPreview(job) {
  if (!job.source) return;
  $('previewImage').src = job.source; $('previewDownload').href = job.source; $('previewPrompt').textContent = job.prompt; $('previewModal').classList.remove('hidden');
}
function deleteJob(job) {
  const index = queue.findIndex((item) => item.id === job.id); if (index < 0) return;
  queue.splice(index, 1); $('previewModal')?.classList.add('hidden'); renderQueue();
}
function rerunJob(job) {
  $('prompt').value = job.prompt;
  if ([...$('model').options].some((option) => option.value === job.model)) $('model').value = job.model;
  if ([...$('size').options].some((option) => option.value === job.size)) $('size').value = job.size;
  if ($('quality') && [...$('quality').options].some((option) => option.value === job.quality)) $('quality').value = job.quality;
  const visualStyle = job.visualStyle || 'photography';
  const renderMaterial = job.renderMaterial || 'auto';
  if ($('visualStyle') && [...$('visualStyle').options].some((option) => option.value === visualStyle)) $('visualStyle').value = visualStyle;
  if ($('renderMaterial') && [...$('renderMaterial').options].some((option) => option.value === renderMaterial)) $('renderMaterial').value = renderMaterial;
  if (Array.isArray(job.references)) {
    if (Array.isArray(job.references[0])) {
      job.references.forEach((files, index) => { selectedReferences[index] = files.filter(Boolean); });
    } else {
      // Backward compatibility for jobs created before role groups existed.
      selectedReferences[0] = job.references.filter(Boolean);
    }
    renderReferencePreviews();
  }
  $('prompt').focus(); setMessage('已回填原提示词和参数，请确认后点击生成。');
}

function renderQueue() {
  persistQueue(); const list = $('queueList'); if (!list) return;
  const active = queue.filter((job) => ['queued', 'running'].includes(job.status)).length;
  const done = queue.filter((job) => job.status === 'done').length; const failed = queue.filter((job) => job.status === 'failed').length;
  $('queueSummary').textContent = queue.length ? `${queue.length} 个任务 · ${active} 个进行中` : '暂无任务';
  if (!queue.length) {
    list.innerHTML = '<div class="queueEmpty"><span class="emptyMark">○</span><strong>还没有生成任务</strong><span>提交提示词后，结果会按完成顺序出现在这里</span></div>'; return;
  }
  list.replaceChildren();
  [...queue].reverse().forEach((job) => {
    const item = document.createElement('article'); item.className = 'queueItem'; item.dataset.status = job.status;
    const thumb = document.createElement('button'); thumb.type = 'button'; thumb.className = 'queueThumb'; thumb.setAttribute('aria-label', job.source ? '打开预览' : queueLabels[job.status]);
    if (job.source) { const image = document.createElement('img'); image.src = job.source; image.alt = '生成结果缩略图'; thumb.append(image); thumb.addEventListener('click', () => openPreview(job)); }
    else thumb.innerHTML = job.status === 'running' ? '<span class="spinner"></span>' : '<span class="thumbPlaceholder">✦</span>';
    const info = document.createElement('div'); info.className = 'queueBody';
    const meta = document.createElement('div'); meta.className = 'queueMeta';
    const modeLabel = job.visualStyle === 'render' ? '3D 渲染' : '摄影';
    meta.textContent = `${job.model} · ${job.size} · ${modeLabel}`;
    const time = document.createElement('time'); time.className = 'queueTime'; time.textContent = job.status === 'running' ? `${Math.max(1, Math.round((Date.now() - (job.startedAt || Date.now())) / 1000))}s` : (job.createdAt ? new Date(job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
    info.append(meta, time);
    const status = document.createElement('span'); status.className = 'queueStatus'; status.textContent = job.error || queueLabels[job.status];
    const actions = document.createElement('div'); actions.className = 'queueActions';
    if (job.source) {
      const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'queueAction'; preview.textContent = '预览'; preview.addEventListener('click', () => openPreview(job));
      const download = document.createElement('a'); download.className = 'queueAction'; download.textContent = '下载'; download.href = job.source; download.download = `generated-${job.id}.png`; actions.append(preview, download);
    }
    if (['done', 'failed'].includes(job.status)) {
      const rerun = document.createElement('button'); rerun.type = 'button'; rerun.className = 'queueAction rerun'; rerun.textContent = '再生成'; rerun.addEventListener('click', () => rerunJob(job));
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'queueAction queueDelete'; remove.textContent = '删除'; remove.addEventListener('click', () => deleteJob(job)); actions.append(rerun, remove);
    }
    const dot = document.createElement('i'); dot.className = 'queueDot'; item.append(thumb, dot, info, status, actions); list.append(item);
  });
  if (!active) $('queueSummary').textContent = `${queue.length} 个任务 · 已完成 ${done} · 失败 ${failed}`;
}

async function runJob(job) {
  const groups = Array.isArray(job.references) && Array.isArray(job.references[0])
    ? job.references
    : [Array.isArray(job.references) ? job.references.filter(Boolean) : [], [], []];
  const renderMode = job.visualStyle === 'render';
  // Auto follows the chosen presentation: photography preserves the source
  // material, while 3D rendering is free to rebuild it for a refined CG look.
  const premiumMaterial = job.renderMaterial === 'premium'
    || (job.renderMaterial !== 'preserve' && renderMode);
  const roleRules = [
    renderMode && premiumMaterial
      ? '产品细节参考优先级最高：锁定产品身份、外形轮廓、结构、比例、接口和关键细节；这是 3D 渲染表现，可以重建材质、纹理、表面微结构与光学响应，不要被参考照片的噪点、反光或拍摄瑕疵限制。'
      : renderMode
        ? '产品细节参考优先级最高：锁定产品身份、外形轮廓、结构、比例、材质颜色、接口和关键细节；转为 3D 渲染时忠实呈现这些产品属性，不要改变关键部件。'
      : '产品细节参考优先级最高：保持产品身份、外形、结构、比例、材质、颜色与关键细节一致。可以根据提示词改变场景和表现方式，但不能误读或替换产品。',
    '动作指导参考只用于动作、姿态、手部与产品接触、受力方向和真实物理关系；有模特就参考模特姿态，没有模特就只参考动作本身。不要把动作图里的产品、模特脸或背景当作产品细节。',
    '整体氛围参考只用于镜头角度、构图、景深、光线、色调、滤镜和整体画面气质；不要复制其中的模特、动作或其他物体，也不要让它改变产品身份。'
  ];
  const visualRule = renderMode
    ? `\n\n画面表现：高级 3D 产品渲染。${premiumMaterial ? '不要机械复制摄影参考的材质；基于产品结构重建细腻的 PBR 材质、微表面纹理、真实粗糙度变化、精确边缘高光、柔和反射与高级灯光，呈现干净、细腻、可信的 CG 质感。' : '忠实保留产品参考中的核心材质和颜色，以细腻的微表面纹理、准确的材质响应、边缘高光、光泽层次与高级灯光呈现可信的 CG 质感。'} 不得改变产品身份、结构或关键部件。`
    : `\n\n画面表现：真实摄影。${premiumMaterial ? '保留产品身份和核心材质，同时用细腻的真实纹理、自然光泽与高级摄影布光呈现质感。' : '尊重参考图中的真实材质、颜色、纹理和拍摄细节，避免把产品渲染成塑料或不真实的 CG 外观。'}`;
  const roleHint = groups.some((files) => files.length)
    ? `\n\n参考图使用规则：\n${groups.map((files, index) => files.length ? `${referenceRoles[index]}（${files.length}张）：${roleRules[index]}` : '').filter(Boolean).join('\n')}${visualRule}`
    : visualRule;
  const form = new FormData();
  form.append('prompt', job.prompt + roleHint); form.append('model', job.model); form.append('quality', job.quality || 'max'); form.append('size', job.size);
  groups.forEach((files, roleIndex) => files.forEach((reference) => {
    // Send the role immediately before its file so the multipart parser can
    // associate each uploaded image without relying on array positions.
    form.append('referenceRole', referenceRoleKeys[roleIndex]);
    form.append('image', reference, reference.name);
  }));
  const data = await readJson(await fetch('/api/generate', { method: 'POST', body: form }));
  job.source = data.url || (data.b64_json ? `data:image/png;base64,${data.b64_json}` : null);
  if (!job.source) throw new Error('生图接口没有返回图片。');
}

async function startWorker() {
  while (true) {
    const job = queue.find((item) => item.status === 'queued'); if (!job) return;
    job.status = 'running'; job.startedAt = Date.now(); renderQueue();
    try { await runJob(job); job.status = 'done'; job.error = ''; }
    catch (error) { job.status = 'failed'; job.error = error?.message || '生图失败'; }
    finally { renderQueue(); }
  }
}
function processQueue() {
  if (processing) return;
  processing = true;
  const count = Math.min(maxClientConcurrency, queue.filter((job) => job.status === 'queued').length);
  Promise.all(Array.from({ length: count }, startWorker)).finally(() => {
    processing = false; renderQueue();
    const failed = queue.filter((job) => job.status === 'failed');
    if (failed.length) setMessage('部分任务生成失败，请查看失败原因后重试。', 'error');
    else if (!queue.some((job) => ['queued', 'running'].includes(job.status))) setMessage('生成完成，结果已保存到历史记录。', 'success');
  });
}

$('generate')?.addEventListener('click', () => {
  const prompt = $('prompt').value.trim(); if (!prompt) return showError(new Error('请填写提示词。'));
  if (!selectedReferences[0].length) return showError(new Error('请先上传至少 1 张产品细节参考图。'));
  const quantity = Math.min(8, Math.max(1, Number($('quantity').value || 1)));
  const references = selectedReferences.map((files) => [...files]);
  const settings = {
    model: $('model').value,
    size: $('size').value,
    quality: $('quality')?.value || 'max',
    visualStyle: $('visualStyle')?.value || 'photography',
    renderMaterial: $('renderMaterial')?.value || 'auto'
  };
  for (let index = 0; index < quantity; index += 1) queue.push({ id: nextJobId++, status: 'queued', prompt, ...settings, references: references.map((files) => [...files]), createdAt: Date.now(), source: null, error: '' });
  renderQueue(); setMessage(`已加入 ${quantity} 个任务，最多同时处理 ${maxClientConcurrency} 个。`); processQueue();
});
$('clearQueue')?.addEventListener('click', () => { for (let index = queue.length - 1; index >= 0; index -= 1) if (['done', 'failed'].includes(queue[index].status)) queue.splice(index, 1); renderQueue(); });
$('closePreview')?.addEventListener('click', () => $('previewModal').classList.add('hidden'));
$('previewModal')?.addEventListener('click', (event) => { if (event.target.id === 'previewModal') event.currentTarget.classList.add('hidden'); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') $('previewModal')?.classList.add('hidden'); });
setInterval(() => { if (queue.some((job) => job.status === 'running')) renderQueue(); }, 1000);
$('prompt')?.addEventListener('input', () => {
  if ($('promptCount')) $('promptCount').textContent = `${$('prompt').value.length} 字`;
});
restoreQueue(); renderReferencePreviews(); renderQueue();
