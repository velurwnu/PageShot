'use strict';

const api = globalThis.browser ?? globalThis.chrome;
const DEFAULTS = { lazy: true, hideFixed: false };
const TOGGLES = ['lazy', 'hideFixed'];

const $ = (id) => document.getElementById(id);

async function loadOpts() {
  try {
    const { opts } = await api.storage.local.get('opts');
    return { ...DEFAULTS, ...(opts || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

const isOn = (id) => $(id).getAttribute('aria-checked') === 'true';
const setOn = (id, on) => $(id).setAttribute('aria-checked', String(!!on));

function currentOpts() {
  return { lazy: isOn('lazy'), hideFixed: isOn('hideFixed') };
}

function saveOpts() {
  try {
    const p = api.storage.local.set({ opts: currentOpts() });
    if (p && p.catch) p.catch(() => {});
  } catch { /* ignore */ }
}

function showError(text) {
  const el = $('note');
  el.textContent = text;
  el.classList.add('err');
  el.hidden = false;
}

async function start(mode) {
  const buttons = ['full', 'visible', 'element'].map($);
  for (const b of buttons) b.disabled = true;
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('Не нашёл активную вкладку.');
    const res = await api.runtime.sendMessage({ type: 'start', tabId: tab.id, mode, opts: currentOpts() });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Фон расширения не ответил.');
    window.close();
  } catch (e) {
    showError((e && e.message) || String(e));
    for (const b of buttons) b.disabled = false;
  }
}

(async () => {
  const opts = await loadOpts();
  for (const id of TOGGLES) {
    setOn(id, opts[id]);
    // пункт-галочка, как в меню macOS: щелчок переключает, меню не закрывается
    $(id).addEventListener('click', () => { setOn(id, !isOn(id)); saveOpts(); });
  }
  $('full').addEventListener('click', () => start('full'));
  $('visible').addEventListener('click', () => start('visible'));
  $('element').addEventListener('click', () => start('element'));
})();
