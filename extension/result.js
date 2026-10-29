/*
 * PageShot — страница результата: склейка кадров и сохранение.
 *
 * Геометрия (всё в CSS-пикселях страницы):
 *   viewport — размер окна в момент съёмки;
 *   crop     — прямоугольник внутри кадра, который относится к прокручиваемой
 *              области (для окна = весь кадр, для внутреннего блока = его рамка);
 *   frames   — фактические позиции прокрутки (x, y) для каждого кадра;
 *   total    — полный размер прокручиваемого содержимого.
 * Масштаб s0 = ширина кадра в пикселях / viewport.w (на Retina ≈ 2).
 * Кадр i рисуется в точку (x·s, y·s) итогового изображения, s — выбранный масштаб.
 *
 * Склеенные части хранятся как PNG (это же и превью). Если выбран WebP или JPEG,
 * части перекодируются в фоне — так заранее виден размер файла, а «Сохранить»
 * отдаёт уже готовое.
 */
'use strict';

const MAX_DIM = 32000;  // предел стороны canvas с запасом (Chrome: 32767)
const WEBP_MAX = 16383; // предел стороны в самом формате WebP
const MAX_AREA = 100e6; // пикселей на одну часть — щадим память Safari
const FRAME_LIMIT_NOTE = 120;

const FORMATS = {
  png: { label: 'PNG', ext: 'png' },
  webp: { label: 'WebP', ext: 'webp' },
  jpeg: { label: 'JPEG', ext: 'jpg' },
};
const DEFAULT_EXPORT = { fmt: 'png', quality: 85 };
const STALE = new Error('stale'); // настройки сменились, пока кодировали

const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const state = {
  job: null, s0: 1, scale: 1, parts: [], busy: false, saving: false, L: null,
  fmt: DEFAULT_EXPORT.fmt, quality: DEFAULT_EXPORT.quality,
  gen: 0,     // номер склейки: после пересклейки старые файлы не годятся
  enc: null,  // последнее перекодирование: { key, promise, size, error }
};

/* ───────────── IndexedDB (та же база, что у фона) ───────────── */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pageshot', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('frames')) db.createObjectStore('frames');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbP = null;
async function idbGet(store, key) {
  dbP = dbP || openDB();
  const db = await dbP;
  return new Promise((resolve, reject) => {
    const r = db.transaction(store, 'readonly').objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const frameKey = (jobId, i) => `${jobId}:${String(i).padStart(4, '0')}`;

// Кадры нужны, только пока открыта эта вкладка (для пересклейки при смене масштаба).
// Закрыл вкладку — удаляем, чтобы снимки не копились на диске.
async function deleteJob(id) {
  dbP = dbP || openDB();
  const db = await dbP;
  return new Promise((resolve) => {
    const t = db.transaction(['jobs', 'frames'], 'readwrite');
    t.objectStore('jobs').delete(id);
    t.objectStore('frames').delete(IDBKeyRange.bound(`${id}:`, `${id}:￿`));
    t.oncomplete = t.onerror = t.onabort = () => resolve();
  });
}

/* ───────────── изображения ───────────── */

function loadImg(src, revokeAfter = false) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { if (revokeAfter) URL.revokeObjectURL(src); resolve(img); };
    img.onerror = () => { if (revokeAfter) URL.revokeObjectURL(src); reject(new Error('Не удалось прочитать изображение')); };
    img.src = src;
  });
}

async function loadFrame(index) {
  const data = await idbGet('frames', frameKey(state.job.id, index));
  if (!data) throw new Error(`Кадр ${index + 1} не найден в хранилище`);
  if (data instanceof Blob) {
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(data); } catch { /* запасной путь ниже */ }
    }
    return loadImg(URL.createObjectURL(data), true);
  }
  return loadImg(data);
}

const imW = (im) => im.naturalWidth || im.width;
const imH = (im) => im.naturalHeight || im.height;
const release = (im) => { if (im && typeof im.close === 'function') im.close(); };

// drawImage с обрезкой исходного прямоугольника по границам кадра:
// старые версии Safari ничего не рисуют, если он выходит за картинку.
function drawClamped(ctx, im, sx, sy, sw, sh, dx, dy, dw, dh) {
  const kx = dw / sw;
  const ky = dh / sh;
  const x0 = Math.max(0, sx);
  const y0 = Math.max(0, sy);
  const x1 = Math.min(imW(im), sx + sw);
  const y1 = Math.min(imH(im), sy + sh);
  if (x1 <= x0 || y1 <= y0) return;
  ctx.drawImage(im, x0, y0, x1 - x0, y1 - y0,
    dx + (x0 - sx) * kx, dy + (y0 - sy) * ky, (x1 - x0) * kx, (y1 - y0) * ky);
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(
      'Браузер не смог закодировать изображение — оно слишком большое. Попробуй масштаб ×1.'))), type, quality);
  });
}

/* ───────────── склейка ───────────── */

function layout(scale, fmt = state.fmt) {
  const { total } = state.job;
  const outW = Math.max(1, Math.round(total.w * scale));
  const outH = Math.max(1, Math.round(total.h * scale));
  const maxH = fmt === 'webp' ? WEBP_MAX : MAX_DIM;
  const partH = Math.max(1, Math.min(maxH, Math.floor(MAX_AREA / outW)));
  return { outW, outH, partH, count: Math.ceil(outH / partH) };
}

async function render() {
  const { job, s0 } = state;
  const s = state.scale;
  const { crop } = job;
  state.busy = true;
  state.gen++;
  state.enc = null;
  setActionsEnabled(false);
  clearParts();
  showStatus(`Склеиваю ${plural(job.frames.length, 'кадр', 'кадра', 'кадров')}…`);

  const L = layout(s);
  try {
    for (let p = 0; p < L.count; p++) {
      const y0 = p * L.partH;
      const h = Math.min(L.partH, L.outH - y0);
      if (L.count > 1) showStatus(`Склеиваю часть ${p + 1} из ${L.count}…`);

      const canvas = document.createElement('canvas');
      canvas.width = L.outW;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Не удалось создать холст такого размера. Попробуй масштаб ×1.');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, L.outW, h);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      for (const f of job.frames) {
        const top = Math.round(f.y * s);
        const bottom = Math.round((f.y + crop.h) * s);
        const left = Math.round(f.x * s);
        const right = Math.round((f.x + crop.w) * s);
        const dy = top - y0;
        if (dy >= h || bottom - y0 <= 0) continue;
        const im = await loadFrame(f.index);
        try {
          drawClamped(ctx, im, crop.x * s0, crop.y * s0, crop.w * s0, crop.h * s0,
            left, dy, right - left, bottom - top);
        } finally {
          release(im);
        }
      }

      showStatus(L.count > 1 ? `Сохраняю часть ${p + 1} из ${L.count} в PNG…` : 'Сохраняю в PNG…');
      const png = await toBlob(canvas, 'image/png');
      canvas.width = 0; // освобождаем память холста
      canvas.height = 0;
      addPart({ index: p, count: L.count, w: L.outW, h, png, url: URL.createObjectURL(png) });
    }
    hideStatus();
    state.L = L;
    updateNotice(L);
  } catch (e) {
    clearParts();
    showError('Не получилось склеить снимок', (e && e.message) || String(e), [
      'Попробуй масштаб ×1 — изображение станет в 4 раза меньше по площади.',
      'Очень длинные страницы лучше снимать частями.',
    ], true);
  } finally {
    state.busy = false;
    setActionsEnabled(true);
    estimate();
  }
}

/* ───────────── форматы: PNG / WebP / JPEG ───────────── */

const encKey = () => `${state.gen}:${state.fmt}:${state.fmt === 'png' ? '' : state.quality}`;

// Части в выбранном формате. Одновременно идёт только одно перекодирование
// (каждое держит в памяти холст размером с часть); результат последнего
// запоминаем — его размер показываем, его же и сохраняем.
let encodeChain = Promise.resolve();
function encoded() {
  const key = encKey();
  if (state.enc && state.enc.key === key) return state.enc.promise;
  const { fmt, quality } = state;
  const parts = state.parts.slice();
  const enc = { key, size: null, error: null };
  enc.promise = encodeChain.catch(() => {}).then(() =>
    encodeParts(parts, fmt, quality, () => encKey() !== key));
  encodeChain = enc.promise;
  enc.promise.then(
    (blobs) => { enc.size = blobs.reduce((a, b) => a + b.size, 0); updateDims(); },
    (e) => {
      if (e === STALE) { if (state.enc === enc) state.enc = null; return; }
      enc.error = errText(e);
      updateDims();
    },
  );
  state.enc = enc;
  return enc.promise;
}

async function encodeParts(parts, fmt, quality, isStale) {
  if (fmt === 'png') return parts.map((p) => p.png);
  const wasm = fmt === 'webp' && !(await nativeWebp()) ? webpWorker() : null;
  try {
    const out = [];
    for (const part of parts) {
      if (isStale()) throw STALE;
      out.push(await encodePart(part, fmt, quality, wasm));
    }
    return out;
  } finally {
    if (wasm) wasm.close(); // освобождаем память WASM
  }
}

async function encodePart(part, fmt, quality, wasm) {
  if (fmt === 'webp' && (part.w > WEBP_MAX || part.h > WEBP_MAX)) {
    throw new Error(`WebP не бывает больше ${fmtPx(WEBP_MAX)} px по стороне. Выбери масштаб ×1, PNG или JPEG.`);
  }
  const img = await loadImg(part.url);
  const c = document.createElement('canvas');
  c.width = part.w;
  c.height = part.h;
  try {
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Не удалось создать холст такого размера. Попробуй масштаб ×1.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0);
    if (fmt === 'jpeg') return await toBlob(c, 'image/jpeg', quality / 100);
    if (!wasm) return await toBlob(c, 'image/webp', quality / 100);
    const pixels = ctx.getImageData(0, 0, c.width, c.height);
    c.width = 0;
    c.height = 0;
    return await wasm.encode(pixels, quality);
  } finally {
    c.width = 0;
    c.height = 0;
  }
}

// Умеет ли браузер WebP сам. Safari — нет: toBlob молча отдаёт PNG.
let nativeWebpP = null;
function nativeWebp() {
  if (!nativeWebpP) {
    nativeWebpP = new Promise((resolve) => {
      const c = document.createElement('canvas');
      c.width = 2;
      c.height = 2;
      c.toBlob((b) => resolve(!!b && b.type === 'image/webp'), 'image/webp', 0.8);
    });
  }
  return nativeWebpP;
}

// libwebp в WebAssembly, в отдельном потоке (webp-worker.js)
function webpWorker() {
  const worker = new Worker('webp-worker.js', { type: 'module' });
  const waiting = new Map();
  let seq = 0;
  const failAll = (msg) => {
    for (const w of waiting.values()) w.reject(new Error(msg));
    waiting.clear();
  };
  worker.onmessage = ({ data }) => {
    const w = waiting.get(data.id);
    if (!w) return;
    waiting.delete(data.id);
    if (data.error) w.reject(new Error(`Кодировщик WebP: ${data.error}`));
    else w.resolve(new Blob([data.buffer], { type: 'image/webp' }));
  };
  worker.onerror = (e) => {
    e.preventDefault();
    failAll(`Не удалось запустить кодировщик WebP${e.message ? `: ${e.message}` : ''}`);
  };
  return {
    encode: (pixels, quality) => new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve, reject });
      worker.postMessage(
        { id, width: pixels.width, height: pixels.height, buffer: pixels.data.buffer, quality },
        [pixels.data.buffer]);
    }),
    close: () => { worker.terminate(); failAll('Кодирование прервано'); },
  };
}

// Пересчитать размер файла в выбранном формате (с задержкой — пока тянут ползунок)
let estimateTimer = 0;
function estimate(delay = 0) {
  clearTimeout(estimateTimer);
  updateDims();
  if (state.fmt === 'png' || state.busy || !state.parts.length) return;
  estimateTimer = setTimeout(() => { encoded().catch(() => {}); }, delay);
}

function setupFormat() {
  for (const b of $('format').querySelectorAll('button')) {
    b.addEventListener('click', () => setFormat(b.dataset.fmt));
  }
  const q = $('quality');
  q.addEventListener('input', () => setQuality(Number(q.value), 600));
  q.addEventListener('change', () => setQuality(Number(q.value), 0));
  markFormat();
}

function markFormat() {
  for (const b of $('format').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.fmt === state.fmt));
  }
  moveLens($('format'));
  $('qualityBox').hidden = state.fmt === 'png';
  $('quality').value = String(state.quality);
  $('qualityVal').textContent = String(state.quality);
}

function setFormat(fmt) {
  if (state.busy || !FORMATS[fmt] || fmt === state.fmt) return;
  const before = layout(state.scale);
  state.fmt = fmt;
  markFormat();
  savePrefs();
  const L = layout(state.scale);
  if (L.partH !== before.partH && (L.count > 1 || before.count > 1)) {
    render(); // WebP режется на части по 16 383 px — нужна пересклейка
  } else {
    if (state.L) updateNotice(state.L);
    estimate();
  }
}

function setQuality(v, delay) {
  if (!Number.isFinite(v)) return;
  state.quality = v;
  $('qualityVal').textContent = String(v);
  savePrefs();
  estimate(delay);
}

async function loadPrefs() {
  try {
    const { exportOpts } = await api.storage.local.get('exportOpts');
    const p = { ...DEFAULT_EXPORT, ...(exportOpts || {}) };
    if (FORMATS[p.fmt]) state.fmt = p.fmt;
    if (Number.isFinite(p.quality)) state.quality = Math.max(30, Math.min(100, Math.round(p.quality)));
  } catch { /* настройки по умолчанию */ }
}

function savePrefs() {
  try {
    const p = api.storage.local.set({ exportOpts: { fmt: state.fmt, quality: state.quality } });
    if (p && p.catch) p.catch(() => {});
  } catch { /* ignore */ }
}

/* ───────────── DOM ───────────── */

function addPart(part) {
  state.parts.push(part);
  const wrap = document.createElement('section');
  wrap.className = 'part';

  if (part.count > 1) {
    const head = document.createElement('div');
    head.className = 'part-head';
    head.append(`Часть ${part.index + 1} из ${part.count} · ${fmtPx(part.w)} × ${fmtPx(part.h)} px`);
    const b1 = button('Сохранить', () => save(part.index));
    const b2 = button('Копировать', () => copy(part));
    head.append(b1, b2);
    wrap.append(head);
  }

  const scroll = document.createElement('div');
  scroll.className = 'part-scroll';
  const img = document.createElement('img');
  img.src = part.url;
  img.alt = `Снимок страницы${part.count > 1 ? `, часть ${part.index + 1}` : ''}`;
  img.title = 'Нажми, чтобы переключить масштаб';
  img.addEventListener('click', () => {
    const actual = img.classList.toggle('actual');
    img.style.width = actual ? `${Math.round(part.w / (window.devicePixelRatio || 1))}px` : '';
  });
  scroll.append(img);
  wrap.append(scroll);
  $('parts').append(wrap);
}

function button(text, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'glass btn small';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function clearParts() {
  for (const p of state.parts) URL.revokeObjectURL(p.url);
  state.parts = [];
  $('parts').replaceChildren();
}

function showStatus(text) {
  $('statusText').textContent = text;
  $('status').hidden = false;
}
function hideStatus() { $('status').hidden = true; }

function setActionsEnabled(on) {
  for (const id of ['save', 'copy']) $(id).disabled = !on;
  for (const b of $('scale').querySelectorAll('button')) b.disabled = !on;
  for (const b of $('format').querySelectorAll('button')) b.disabled = !on;
  if (on && state.parts.length > 1) $('copy').disabled = true;
}

function updateDims() {
  const L = state.L;
  if (!L || !state.parts.length) return;
  const png = state.parts.reduce((a, p) => a + p.png.size, 0);
  const frames = plural(state.job.frames.length, 'кадр', 'кадра', 'кадров');
  const f = FORMATS[state.fmt];
  let size = `PNG ${fmtBytes(png)}`;
  if (state.fmt !== 'png') {
    const e = state.enc && state.enc.key === encKey() ? state.enc : null;
    if (e && e.size != null) size = `${f.label} ${fmtBytes(e.size)} (PNG ${fmtBytes(png)})`;
    else if (e && e.error) size = `${f.label}: не удалось закодировать`;
    else size = `${f.label}: считаю размер…`;
  }
  $('dims').textContent = `${fmtPx(L.outW)} × ${fmtPx(L.outH)} px · ${frames} · ${size}`;
  const many = L.count > 1;
  if (!state.saving) $('save').textContent = many ? `Сохранить все ${f.label}` : `Сохранить ${f.label}`;
  $('copy').title = many ? 'Копирование доступно для каждой части отдельно' : 'В буфер обмена всегда копируется PNG';
}

function updateNotice(L) {
  const box = $('notice');
  box.replaceChildren();
  const add = (text) => { const p = document.createElement('p'); p.textContent = text; box.append(p); };

  if (state.job.truncated) {
    add(`Страница очень длинная — сняты первые ${FRAME_LIMIT_NOTE} экранов (защита от бесконечной ленты).`);
  }
  if (state.job.mode === 'element') {
    add(`Снят только выбранный элемент${state.job.target ? ` — ${state.job.target}` : ''}.`);
  } else if (state.job.scroller === 'element') {
    add('Прокручивалось не окно, а блок внутри страницы, — в снимке его содержимое целиком.');
  }
  if (L.count > 1 && state.fmt === 'webp' && layout(state.scale, 'png').count < L.count) {
    add(`WebP не бывает выше ${fmtPx(WEBP_MAX)} px — снимок разбит на ${plural(L.count, 'часть', 'части', 'частей')}. В PNG и JPEG частей меньше.`);
  } else if (L.count > 1) {
    add(`Изображение слишком большое для одного файла — разбито на ${plural(L.count, 'часть', 'части', 'частей')}.`);
    if (state.scale > 1.01 && layout(1).count === 1) {
      box.append(button('Сделать одним файлом (×1)', () => setScale(1)));
    }
  }
  box.hidden = !box.childNodes.length;
}

function setupScale() {
  const seg = $('scale');
  seg.replaceChildren();
  const s0 = state.s0;
  if (s0 < 1.2) { seg.hidden = true; return; }
  const opts = [
    { v: s0, label: `Retina ×${+s0.toFixed(2)}` },
    { v: 1, label: '×1' },
  ];
  for (const o of opts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = o.label;
    b.dataset.v = String(o.v);
    b.addEventListener('click', () => setScale(o.v));
    seg.append(b);
  }
  seg.hidden = false;
  markScale();
}

function markScale() {
  for (const b of $('scale').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(Math.abs(Number(b.dataset.v) - state.scale) < 1e-6));
  }
  moveLens($('scale'));
}

// «Линза» под выбранной кнопкой капсулы: отдельный элемент, который при смене
// выбора переезжает и меняет ширину (анимация — в CSS), как в macOS.
function moveLens(seg, animate = true) {
  const on = seg.querySelector('button[aria-pressed="true"]');
  let lens = seg.querySelector('.seg-lens');
  if (!lens) {
    lens = document.createElement('div');
    lens.className = 'seg-lens';
    lens.setAttribute('aria-hidden', 'true');
    seg.prepend(lens);
    seg.classList.add('has-lens');
    animate = false; // первое появление — сразу на месте
  }
  if (!on || seg.hidden) { lens.style.opacity = '0'; return; }
  if (!animate) lens.classList.add('instant');
  Object.assign(lens.style, {
    opacity: '1',
    width: `${on.offsetWidth}px`,
    height: `${on.offsetHeight}px`,
    transform: `translate(${on.offsetLeft}px, ${on.offsetTop}px)`,
  });
  if (!animate) {
    void lens.offsetWidth; // применить позицию до возврата анимации
    lens.classList.remove('instant');
  }
}

// ширина кнопок может поменяться (шрифт догрузился, окно сузилось и капсулы
// перенеслись) — ставим линзы на место без анимации
function relayoutLenses() {
  for (const seg of document.querySelectorAll('.seg.has-lens')) moveLens(seg, false);
}
window.addEventListener('resize', relayoutLenses);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayoutLenses);

function setScale(v) {
  if (state.busy || Math.abs(v - state.scale) < 1e-6) return;
  state.scale = v;
  markScale();
  render();
}

function showError(title, text, hints, keepHeader = false) {
  hideStatus();
  $('errTitle').textContent = title;
  $('errText').textContent = text || '';
  const ul = $('errHints');
  ul.replaceChildren();
  for (const h of hints || []) { const li = document.createElement('li'); li.textContent = h; ul.append(li); }
  $('error').hidden = false;
  if (!keepHeader) $('actions').hidden = true;
}

let toastTimer = 0;
function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('bad', bad);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ───────────── сохранение ───────────── */

function baseName() {
  const job = state.job;
  let host = 'page';
  try { host = new URL(job.url).hostname.replace(/^www\./, '') || 'page'; } catch { /* ignore */ }
  const d = new Date(job.created || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `${host}_${stamp}`.replace(/[^\w.-]+/g, '_');
}

function fileName(part, ext) {
  const suffix = part.count > 1 ? `_part${part.index + 1}of${part.count}` : '';
  return `${baseName()}${suffix}.${ext}`;
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// index — номер части; без него сохраняются все части
async function save(index = null) {
  if (state.saving || state.busy) return;
  const f = FORMATS[state.fmt];
  const btn = $('save');
  state.saving = true;
  try {
    if (state.enc && state.enc.error) state.enc = null; // ошибка могла быть разовой — пробуем снова
    if (state.fmt !== 'png') {
      btn.disabled = true;
      btn.textContent = `Кодирую ${f.label}…`;
    }
    let blobs = null;
    while (!blobs) {
      try {
        blobs = await encoded();
      } catch (e) {
        if (e !== STALE) throw e; // пока кодировали, сменили формат или качество — заново
      }
    }
    const parts = index == null ? state.parts : [state.parts[index]];
    for (const part of parts) {
      const name = fileName(part, f.ext);
      download(blobs[part.index], name);
      toast(`Сохранено: ${name} · ${fmtBytes(blobs[part.index].size)}`);
      if (parts.length > 1) await new Promise((r) => setTimeout(r, 500));
    }
  } catch (e) {
    toast(`Не удалось сохранить: ${errText(e)}`, true);
  } finally {
    state.saving = false;
    btn.disabled = state.busy;
    updateDims();
  }
}

async function copy(part) {
  try {
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') throw new Error('буфер обмена недоступен');
    // Safari требует передать Promise прямо в обработчике клика
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': Promise.resolve(part.png) })]);
    toast('Скопировано в буфер обмена');
  } catch (e) {
    toast(`Не удалось скопировать: ${(e && e.message) || e}`, true);
  }
}

/* ───────────── форматирование ───────────── */

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}
const fmtPx = (n) => n.toLocaleString('ru-RU');
const errText = (e) => (e && e.message) || String(e);
function fmtBytes(b) {
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} КБ`;
  return `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

function errorHints(err) {
  const e = String(err).toLowerCase();
  if (e.includes('esc') || e.includes('отмен')) return ['Запусти съёмку заново из меню расширения.'];
  if (e.includes('активн')) return ['Во время съёмки не переключай вкладки и не сворачивай окно.'];
  return [
    'Служебные страницы Safari (стартовая, настройки, App Store, страницы других расширений) снимать нельзя.',
    'Проверь доступ: Safari → Настройки → Расширения → PageShot → «Изменить веб-сайты…» → разреши этот сайт или все сайты.',
    'Если страница ещё грузится — дождись загрузки и попробуй снова.',
  ];
}

/* ───────────── запуск ───────────── */

async function main() {
  const jobId = decodeURIComponent(location.hash.slice(1));
  let job = null;
  try { job = jobId ? await idbGet('jobs', jobId) : null; } catch { /* ignore */ }

  if (!job) {
    showError('Снимок не найден', '', [
      'Кадры удаляются, когда закрываешь вкладку со снимком, — сделай новый из меню расширения.',
    ]);
    return;
  }

  window.addEventListener('pagehide', (e) => { if (!e.persisted) deleteJob(job.id); });

  $('title').textContent = job.title || 'Без названия';
  document.title = `PageShot — ${job.title || 'снимок'}`;
  if (job.url) { $('url').textContent = job.url; $('url').href = job.url; }

  if (job.error) {
    showError('Не получилось сделать снимок', job.error, errorHints(job.error));
    return;
  }

  state.job = job;
  try {
    const first = await loadFrame(0);
    const w = imW(first);
    const h = imH(first);
    release(first);
    if (job.mode === 'visible' || !job.crop || !job.viewport) {
      job.viewport = { w, h };
      job.crop = { x: 0, y: 0, w, h };
      job.total = { w, h };
      state.s0 = 1;
    } else {
      state.s0 = w / job.viewport.w;
    }
  } catch (e) {
    showError('Не удалось прочитать кадры', (e && e.message) || String(e), ['Сделай снимок заново.']);
    return;
  }

  state.scale = state.s0;
  await loadPrefs();
  $('actions').hidden = false;
  setupScale();
  setupFormat();

  $('save').addEventListener('click', () => save());
  $('copy').addEventListener('click', () => { if (state.parts[0]) copy(state.parts[0]); });

  await render();
}

main();
