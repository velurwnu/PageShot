/*
 * PageShot — фоновый скрипт (service worker).
 *
 * Схема работы:
 *   popup / горячая клавиша → startCapture()
 *     «видимая область»: один captureVisibleTab → результат
 *     «вся страница»:    внедряем agent.js в страницу; агент сам прокручивает
 *                        страницу и на каждом шаге присылает сюда сообщение
 *                        'frame', мы делаем captureVisibleTab и кладём кадр
 *                        в IndexedDB. В конце агент шлёт 'finish' с геометрией.
 *     «элемент»:         тот же агент, но сначала даёт выбрать элемент мышью
 *                        и прокручивает только его (Esc при выборе → 'cancel').
 *   → открываем result.html#<jobId>, там кадры склеиваются на canvas.
 *
 * Кадры хранятся в IndexedDB, а не в памяти: Safari может выгрузить
 * service worker между кадрами, и ничего не потеряется — каждое сообщение
 * от агента самодостаточно.
 */
'use strict';

const api = globalThis.browser ?? globalThis.chrome;

const DEFAULT_OPTS = { lazy: true, hideFixed: false };
const KEEP_JOBS = 4;          // сколько последних снимков держать в базе
const POPUP_CLOSE_DELAY = 200; // мс: даём попапу закрыться до первого кадра

// Задания «вся страница», ждущие, пока агент загрузится и спросит параметры.
const pending = new Map(); // tabId -> opts
const MODES = ['full', 'visible', 'element'];
const COMMAND_MODES = { 'capture-full': 'full', 'capture-visible': 'visible', 'capture-element': 'element' };

/* ───────────── IndexedDB ───────────── */

const DB_NAME = 'pageshot';
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('frames')) db.createObjectStore('frames');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((e) => { dbPromise = null; throw e; });
  }
  return dbPromise;
}

async function withStore(name, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(name, mode);
    let out;
    const r = fn(t.objectStore(name));
    if (r && typeof r === 'object' && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
    else out = r;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('IndexedDB: транзакция прервана'));
  });
}

const frameKey = (jobId, i) => `${jobId}:${String(i).padStart(4, '0')}`;

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] || 'image/png';
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function putFrame(jobId, index, dataUrl) {
  const key = frameKey(jobId, index);
  try {
    // Blob компактнее data-URL на ~25%
    await withStore('frames', 'readwrite', (s) => s.put(dataUrlToBlob(dataUrl), key));
  } catch {
    // запасной вариант, если Blob в IndexedDB не поддержан
    await withStore('frames', 'readwrite', (s) => s.put(dataUrl, key));
  }
}

const saveJob = (job) => withStore('jobs', 'readwrite', (s) => s.put(job));

async function purgeOldJobs() {
  const jobs = (await withStore('jobs', 'readonly', (s) => s.getAll())) || [];
  jobs.sort((a, b) => b.created - a.created);
  for (const job of jobs.slice(KEEP_JOBS)) {
    await withStore('jobs', 'readwrite', (s) => s.delete(job.id));
    await withStore('frames', 'readwrite', (s) =>
      s.delete(IDBKeyRange.bound(`${job.id}:`, `${job.id}:￿`)));
  }
}

/* ───────────── утилиты ───────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const errText = (e) => (e && e.message) || String(e || 'Неизвестная ошибка');

function quiet(p) {
  try { if (p && typeof p.catch === 'function') p.catch(() => {}); } catch { /* ignore */ }
}

function badge(tabId, text, color = '#2F6FEB') {
  try {
    quiet(api.action.setBadgeBackgroundColor({ tabId, color }));
    quiet(api.action.setBadgeText({ tabId, text }));
  } catch { /* ignore */ }
}

async function getOpts() {
  try {
    const { opts } = await api.storage.local.get('opts');
    return { ...DEFAULT_OPTS, ...(opts || {}) };
  } catch {
    return { ...DEFAULT_OPTS };
  }
}

async function openResult(tab, jobId) {
  const url = api.runtime.getURL('result.html') + '#' + jobId;
  try {
    await api.tabs.create({ url, index: tab.index + 1, windowId: tab.windowId });
  } catch {
    await api.tabs.create({ url });
  }
}

/* ───────────── сценарии съёмки ───────────── */

async function startCapture(tabId, mode, opts) {
  opts = { ...DEFAULT_OPTS, ...(opts || {}) };
  const tab = await api.tabs.get(tabId);
  const jobId = newId();

  setTimeout(() => {
    const run = mode === 'visible' ? captureVisible(tab, jobId) : injectAgent(tab, jobId, { ...opts, mode });
    run.catch((e) => failJob(tab, jobId, e, mode));
  }, POPUP_CLOSE_DELAY);

  return { jobId };
}

async function captureVisible(tab, jobId) {
  badge(tab.id, '…');
  const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  await putFrame(jobId, 0, dataUrl);
  await saveJob({
    id: jobId,
    created: Date.now(),
    mode: 'visible',
    title: tab.title || '',
    url: tab.url || '',
    frames: [{ index: 0, x: 0, y: 0 }],
  });
  await finishJob(tab, jobId);
}

async function injectAgent(tab, jobId, opts) {
  pending.set(tab.id, { ...opts, jobId });
  badge(tab.id, '…');
  try {
    await api.scripting.executeScript({ target: { tabId: tab.id }, files: ['agent.js'] });
  } catch (e) {
    pending.delete(tab.id);
    throw e;
  }
}

async function finishJob(tab, jobId) {
  badge(tab.id, '');
  quiet(purgeOldJobs());
  await openResult(tab, jobId);
}

async function failJob(tab, jobId, err, mode = 'full', extra = {}) {
  try {
    await saveJob({
      id: jobId,
      created: Date.now(),
      mode,
      title: extra.title ?? tab?.title ?? '',
      url: extra.url ?? tab?.url ?? '',
      error: errText(err),
    });
    if (tab) {
      badge(tab.id, '!', '#D93025');
      setTimeout(() => badge(tab.id, ''), 4000);
      await openResult(tab, jobId);
    }
  } catch { /* ignore */ }
}

/* ───────────── обработчики сообщений ───────────── */

const handlers = {
  // из popup
  async start(msg) {
    return startCapture(msg.tabId, MODES.includes(msg.mode) ? msg.mode : 'full', msg.opts);
  },

  // агент загрузился и просит параметры
  async hello(msg, sender) {
    const tabId = sender.tab?.id;
    const opts = pending.get(tabId);
    pending.delete(tabId);
    return { opts: opts || null };
  },

  // агент прокрутил страницу — снимаем кадр
  async frame(msg, sender) {
    const tab = sender.tab;
    if (!tab) throw new Error('Нет вкладки-отправителя');
    const [active] = await api.tabs.query({ active: true, windowId: tab.windowId });
    if (!active || active.id !== tab.id) {
      throw new Error('Вкладка перестала быть активной — съёмка прервана.');
    }
    const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    await putFrame(msg.jobId, msg.index, dataUrl);
    const pct = Math.min(99, Math.round((100 * (msg.index + 1)) / Math.max(1, msg.count)));
    badge(tab.id, pct + '%');
    return {};
  },

  // агент закончил: сохраняем геометрию и открываем результат
  async finish(msg, sender) {
    await saveJob({ id: msg.jobId, created: Date.now(), mode: 'full', ...msg.meta });
    await finishJob(sender.tab, msg.jobId);
    return {};
  },

  async fail(msg, sender) {
    await failJob(sender.tab, msg.jobId, msg.error, msg.mode || 'full', { title: msg.title, url: msg.url });
    return {};
  },

  // выбор элемента отменён (Esc) — просто гасим значок
  async cancel(msg, sender) {
    if (sender.tab) badge(sender.tab.id, '');
    return {};
  },
};

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && handlers[msg.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(
      (r) => sendResponse({ ok: true, ...(r || {}) }),
      (e) => sendResponse({ ok: false, error: errText(e) }),
    );
  return true; // ответ асинхронный
});

/* ───────────── горячие клавиши ───────────── */

if (api.commands && api.commands.onCommand) {
  api.commands.onCommand.addListener(async (command, tab) => {
    try {
      const t = tab || (await api.tabs.query({ active: true, currentWindow: true }))[0];
      if (!t) return;
      await startCapture(t.id, COMMAND_MODES[command] || 'full', await getOpts());
    } catch { /* ignore */ }
  });
}

// для отладки из консоли service worker'а
globalThis.PageShot = { startCapture, purgeOldJobs, sleep };
