/*
 * PageShot — агент, внедряемый в страницу (content script).
 *
 * 1. Находит, что прокручивать: само окно или внутренний контейнер
 *    (у веб-приложений вроде почты прокручивается не окно, а <div>).
 * 2. Готовит страницу: прячет полосы прокрутки, отключает плавную прокрутку,
 *    «отклеивает» sticky-элементы, по желанию прогружает ленивые картинки.
 * 3. Шагает по странице на высоту экрана; на каждом шаге просит фон
 *    снять кадр (captureVisibleTab) и запоминает фактическую позицию.
 *    Fixed-элементы (шапки, кнопки чатов) видны только на первом кадре.
 * 4. Возвращает страницу как было и отдаёт фону геометрию для склейки.
 *
 * В режиме «элемент» сначала даёт выбрать элемент мышью (↑/↓ — родитель/потомок),
 * а потом снимает только его: прокручивает ближайший к нему прокручиваемый блок
 * (или окно) в пределах элемента, геометрия кадров считается от его левого верхнего угла.
 * Если элемент сам прокручивается (лента чата, блок с таблицей), снимается всё его содержимое.
 *
 * Esc во время съёмки — отмена.
 */
(() => {
  'use strict';

  const api = globalThis.browser ?? globalThis.chrome;
  const root = document.documentElement;
  const LOCK = 'data-pageshot-busy';

  // Блокировка через DOM: работает, даже если скрипт внедрили повторно.
  // Повторное нажатие во время съёмки просто игнорируем
  // (hello забирает параметры у фона, чтобы они не висели).
  if (root.hasAttribute(LOCK)) {
    api.runtime.sendMessage({ type: 'hello' }).catch(() => {});
    return;
  }

  const MIN_CAPTURE_INTERVAL = 550; // мс — в Chrome не больше 2 снимков в секунду
  const MAX_FRAMES = 120;           // защита от бесконечных лент
  const LAZY_TIME_LIMIT = 12000;    // мс на предварительную прокрутку
  const ABORT_MSG = 'Съёмка отменена (Esc).';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => {
    let done = false;
    const fin = () => { if (!done) { done = true; r(); } };
    requestAnimationFrame(fin);
    setTimeout(fin, 100); // rAF не срабатывает в фоновых вкладках
  });
  const settle = async (ms = 0) => { await nextFrame(); await nextFrame(); if (ms) await sleep(ms); };

  api.runtime.sendMessage({ type: 'hello' }).then((res) => {
    if (res && res.ok && res.opts) run(res.opts);
  }, () => {});

  async function run(opts) {
    if (root.hasAttribute(LOCK)) return;
    root.setAttribute(LOCK, '');

    let target = null;
    if (opts.mode === 'element') {
      target = await pickElement();
      if (!target) {
        root.removeAttribute(LOCK);
        try { await api.runtime.sendMessage({ type: 'cancel', jobId: opts.jobId }); } catch { /* ignore */ }
        return;
      }
    }

    const undo = [];
    let aborted = false;
    const onKey = (e) => {
      if (e.key === 'Escape') { aborted = true; e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    undo.push(() => window.removeEventListener('keydown', onKey, true));

    let meta = null;
    let error = null;
    try {
      meta = await capture(opts, undo, () => aborted, target);
    } catch (e) {
      error = (e && e.message) || String(e);
    } finally {
      for (let i = undo.length - 1; i >= 0; i--) {
        try { undo[i](); } catch { /* ignore */ }
      }
      root.removeAttribute(LOCK);
    }

    try {
      if (error) {
        await api.runtime.sendMessage({
          type: 'fail', jobId: opts.jobId, mode: opts.mode, error, title: document.title, url: location.href,
        });
      } else {
        await api.runtime.sendMessage({ type: 'finish', jobId: opts.jobId, meta });
      }
    } catch { /* фон недоступен — ничего не поделать */ }
  }

  /* ───────────── выбор элемента ───────────── */

  // Подсветка под курсором; клик или Enter — выбрать, ↑/↓ — родитель/обратно
  // к потомку, Esc — отмена (null). Клики по странице на это время глушатся.
  function pickElement() {
    return new Promise((resolve) => {
      const host = document.createElement('div');
      host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
      const shadow = host.attachShadow({ mode: 'closed' });
      shadow.innerHTML = `
        <style>
          .box { position: fixed; display: none; box-sizing: border-box; border: 2px solid #2f6feb;
                 background: rgba(47, 111, 235, 0.12); border-radius: 3px; }
          .tag { position: fixed; display: none; padding: 3px 7px; border-radius: 5px; background: #2f6feb;
                 color: #fff; font: 500 12px/1.3 -apple-system, BlinkMacSystemFont, sans-serif;
                 white-space: nowrap; max-width: 70vw; overflow: hidden; text-overflow: ellipsis; }
          .bar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); padding: 8px 14px;
                 border-radius: 9px; background: rgba(30, 30, 32, 0.92); color: #fff;
                 font: 13px/1.35 -apple-system, BlinkMacSystemFont, sans-serif; white-space: nowrap;
                 box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25); }
          .bar.top { top: 16px; bottom: auto; }
          b { display: inline-block; min-width: 1.4em; padding: 0 4px; margin: 0 1px; border-radius: 4px;
              background: rgba(255, 255, 255, 0.18); font-weight: 600; text-align: center; }
        </style>
        <div class="box"></div><div class="tag"></div>
        <div class="bar">Щёлкни по элементу, который снять · <b>↑</b> шире · <b>↓</b> уже · <b>Esc</b> отмена</div>`;
      const box = shadow.querySelector('.box');
      const tag = shadow.querySelector('.tag');
      const bar = shadow.querySelector('.bar');
      const cursor = document.createElement('style');
      cursor.textContent = '*, *::before, *::after { cursor: crosshair !important; }';

      let current = null;
      let trail = []; // по ↑ запоминаем путь, чтобы ↓ вёл обратно

      const draw = () => {
        if (!current || !current.isConnected) { box.style.display = 'none'; tag.style.display = 'none'; return; }
        const r = current.getBoundingClientRect();
        Object.assign(box.style, {
          display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
        });
        tag.textContent = `${describe(current)} · ${Math.round(r.width)} × ${Math.round(r.height)}`;
        tag.style.display = 'block';
        const th = tag.offsetHeight || 20;
        const top = r.top - th - 4 >= 0 ? r.top - th - 4 : Math.min(window.innerHeight - th, Math.max(0, r.top) + 4);
        tag.style.left = `${Math.min(Math.max(0, r.left), Math.max(0, window.innerWidth - tag.offsetWidth))}px`;
        tag.style.top = `${top}px`;
      };
      const select = (el, keepTrail = false) => {
        if (!el || el === host || el === root) return;
        if (!keepTrail) trail = [];
        current = el;
        draw();
      };

      const block = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      };
      const onMove = (e) => {
        const el = e.target instanceof Element ? e.target : null;
        // после ↑ движение мыши внутри выбранного родителя выбор не сбрасывает
        if (el && el !== current && !(trail.length && current && current.contains(el))) select(el);
        // нижняя подсказка не должна закрывать то, что выбираешь
        bar.classList.toggle('top', e.clientY > window.innerHeight - 90);
      };
      const onClick = (e) => {
        block(e);
        if (e.button !== 0) return;
        const el = current || (e.target instanceof Element ? e.target : null);
        if (el) finish(el);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { block(e); finish(null); return; }
        if (!current) return;
        if (e.key === 'ArrowUp') {
          block(e);
          const up = current.parentElement;
          if (up && up !== root) { trail.push(current); select(up, true); }
        } else if (e.key === 'ArrowDown') {
          block(e);
          if (trail.length) select(trail.pop(), true);
          else if (current.firstElementChild) select(current.firstElementChild, true);
        } else if (e.key === 'Enter') {
          block(e);
          finish(current);
        }
      };
      let raf = 0;
      const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); };

      const opts = { capture: true, passive: false };
      const listeners = [
        ['mousemove', onMove], ['click', onClick], ['keydown', onKey],
        ['mousedown', block], ['mouseup', block], ['pointerdown', block], ['pointerup', block],
        ['dblclick', block], ['auxclick', block],
        ['scroll', onScroll], ['resize', onScroll],
      ];
      for (const [type, fn] of listeners) window.addEventListener(type, fn, opts);
      (document.head || root).appendChild(cursor);
      root.appendChild(host);

      function finish(el) {
        for (const [type, fn] of listeners) window.removeEventListener(type, fn, opts);
        cancelAnimationFrame(raf);
        host.remove();
        cursor.remove();
        resolve(el && el.isConnected ? el : null);
      }
    });
  }

  // Короткое имя элемента для подсказки и для страницы результата: table#prices.data
  function describe(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    if (cls.length) s += `.${cls.slice(0, 2).join('.')}`;
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
  }

  /* ───────────── основная процедура ───────────── */

  // target — выбранный элемент (режим «элемент») или null (вся страница)
  async function capture(opts, undo, isAborted, target = null) {
    const check = () => { if (isAborted()) throw new Error(ABORT_MSG); };

    // 1. Служебные стили на время съёмки
    const style = document.createElement('style');
    style.textContent = `
      html, body, * { scroll-behavior: auto !important; caret-color: transparent !important; }
      html { scrollbar-width: none !important; }
      html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
      [data-pageshot-scroller] { scrollbar-width: none !important; }
      [data-pageshot-scroller]::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
    `;
    (document.head || root).appendChild(style);
    undo.push(() => style.remove());

    const start = { x: window.scrollX, y: window.scrollY };
    undo.push(() => window.scrollTo(start.x, start.y));
    await settle();

    // 2. Что прокручиваем и какую область снимаем (в координатах содержимого sc)
    let own = null; // элемент прокручивается сам — снимаем всё его содержимое
    if (target && isScrollable(target, 40)) {
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      await settle();
      if (fitsViewport(target)) own = target;
    }
    const sc = own ? elementScroller(own)
      : target && isPinned(target) ? pinnedScroller(target)
      : target ? scrollerFor(target)
      : pickScroller();
    const region = () => (target && !own && sc.kind !== 'pinned'
      ? regionOf(target, sc)
      : { x: 0, y: 0, ...sc.size() });
    if (sc.el) {
      const el = sc.el;
      const st = { x: el.scrollLeft, y: el.scrollTop };
      el.setAttribute('data-pageshot-scroller', '');
      undo.push(() => {
        el.removeAttribute('data-pageshot-scroller');
        el.scrollLeft = st.x;
        el.scrollTop = st.y;
      });
      await settle();
    }

    // 3. Ленивые картинки: быстро пролистываем страницу до конца и обратно
    if (opts.lazy) {
      document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]').forEach((e) => {
        try { e.loading = 'eager'; } catch { /* ignore */ }
      });
      const view = sc.crop();
      const r = region();
      const step = Math.max(200, Math.floor(view.h * 0.85));
      const t0 = performance.now();
      for (let y = r.y; y < r.y + r.h; y += step) {
        check();
        sc.scrollTo(0, y);
        await sleep(90);
        if (performance.now() - t0 > LAZY_TIME_LIMIT || y - r.y > view.h * MAX_FRAMES) break;
      }
      sc.scrollTo(0, r.y);
      await settle(400);
    }
    check();

    // 4. sticky → static (без повторов), список fixed-элементов
    const fixed = collectFloating(sc, undo, target);
    const hideFixed = () => {
      for (const el of fixed) {
        setImportant(el, 'transition', 'none', undo);
        setImportant(el, 'opacity', '0', undo);
      }
    };
    // у элемента шапки и кнопки поверх него не нужны ни на одном кадре
    if (opts.hideFixed || target) hideFixed();
    await settle(100);

    // 5. Сетка кадров
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    const crop = sc.crop();
    const R = region();
    const allowX = sc.allowX() && R.w - crop.w > 4 && R.w <= crop.w * 4;
    const xs = allowX ? steps(R.x, R.w, crop.w) : [fitX(R, crop, sc.pos().x)];
    let ys = steps(R.y, R.h, crop.h);
    let truncated = false;
    const maxRows = Math.max(1, Math.floor(MAX_FRAMES / xs.length));
    if (ys.length > maxRows) { ys = ys.slice(0, maxRows); truncated = true; }

    const total = {
      w: xs.length > 1 ? R.w : Math.min(R.w, crop.w),
      h: truncated ? ys[ys.length - 1] - R.y + crop.h : R.h,
    };

    // 6. Съёмка
    const frames = [];
    const count = xs.length * ys.length;
    let lastShot = -Infinity;
    let i = 0;
    for (const y of ys) {
      for (const x of xs) {
        check();
        if (i === 1 && !opts.hideFixed && !target) hideFixed();
        sc.scrollTo(x, y);
        await settle(opts.delay ?? 150);
        const p = sc.pos();

        const wait = lastShot + MIN_CAPTURE_INTERVAL - performance.now();
        if (wait > 0) await sleep(wait);
        check();
        lastShot = performance.now();

        const res = await api.runtime.sendMessage({ type: 'frame', jobId: opts.jobId, index: i, count });
        if (!res || !res.ok) throw new Error((res && res.error) || 'Не удалось сделать снимок экрана');
        frames.push({ index: i, x: p.x - R.x, y: p.y - R.y });
        i++;
      }
    }

    return {
      mode: target ? 'element' : 'full',
      target: target ? describe(target) : undefined,
      title: document.title,
      url: location.href,
      scroller: sc.kind,
      viewport,
      crop,
      total,
      frames,
      truncated,
      dpr: window.devicePixelRatio || 1,
    };
  }

  /* ───────────── прокрутка ───────────── */

  // Позиции прокрутки, чтобы отрезок [from, from + len) покрылся окнами размера view
  function steps(from, len, view) {
    const out = [];
    const last = from + Math.max(0, Math.round(len - view));
    for (let p = from; p < last; p += view) out.push(Math.round(p));
    if (!out.length || last - out[out.length - 1] >= 1) out.push(last);
    return out;
  }

  // Горизонтальная прокрутка без шагов: область целиком в кадре, лишний раз не двигаем
  function fitX(R, crop, cur) {
    if (R.w >= crop.w) return R.x;
    return Math.max(R.x + R.w - crop.w, Math.min(cur, R.x));
  }

  function overflowHidden(v) { return v === 'hidden' || v === 'clip'; }

  function windowScroller() {
    const se = document.scrollingElement || root;
    return {
      kind: 'window',
      el: null,
      crop: () => ({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }),
      size: () => ({
        w: Math.max(se.scrollWidth, window.innerWidth),
        h: Math.max(se.scrollHeight, window.innerHeight),
      }),
      scrollTo: (x, y) => window.scrollTo(x, y),
      pos: () => ({ x: window.scrollX, y: window.scrollY }),
      allowX: () => {
        // overflow у <body> переходит на окно, если у <html> он visible
        const oh = getComputedStyle(root).overflowX;
        const ox = oh === 'visible' && document.body ? getComputedStyle(document.body).overflowX : oh;
        return !overflowHidden(ox);
      },
    };
  }

  function elementScroller(el) {
    return {
      kind: 'element',
      el,
      crop: () => {
        const r = el.getBoundingClientRect();
        return { x: r.left + el.clientLeft, y: r.top + el.clientTop, w: el.clientWidth, h: el.clientHeight };
      },
      size: () => ({
        w: Math.max(el.scrollWidth, el.clientWidth),
        h: Math.max(el.scrollHeight, el.clientHeight),
      }),
      scrollTo: (x, y) => { el.scrollLeft = x; el.scrollTop = y; },
      pos: () => ({ x: el.scrollLeft, y: el.scrollTop }),
      allowX: () => !overflowHidden(getComputedStyle(el).overflowX),
    };
  }

  // Элемент внутри fixed-слоя (модальное окно, боковая панель): прокрутка его не
  // двигает — снимаем один кадр, рамка = видимая часть элемента
  function pinnedScroller(el) {
    const crop = () => {
      const r = clipRect(el, null);
      return { x: r.left, y: r.top, w: Math.max(1, r.right - r.left), h: Math.max(1, r.bottom - r.top) };
    };
    return {
      kind: 'pinned',
      el: null,
      crop,
      size: () => { const c = crop(); return { w: c.w, h: c.h }; },
      scrollTo: () => {},
      pos: () => ({ x: 0, y: 0 }),
      allowX: () => false,
    };
  }

  function pickScroller() {
    const w = windowScroller();
    if (w.size().h - window.innerHeight >= 40) return w;
    const el = findInnerScroller();
    return el ? elementScroller(el) : w;
  }

  function isScrollable(el, min = 1) {
    if (el === document.body || el === root) return false;
    const cs = getComputedStyle(el);
    const can = (v) => v === 'auto' || v === 'scroll' || v === 'overlay';
    return (el.scrollHeight - el.clientHeight >= min && can(cs.overflowY))
      || (el.scrollWidth - el.clientWidth >= min && can(cs.overflowX));
  }

  function fitsViewport(el) {
    const r = el.getBoundingClientRect();
    const left = r.left + el.clientLeft;
    const top = r.top + el.clientTop;
    return left >= -1 && top >= -1
      && left + el.clientWidth <= window.innerWidth + 1
      && top + el.clientHeight <= window.innerHeight + 1;
  }

  // Ближайший прокручиваемый по вертикали предок, который виден на экране целиком
  function scrollerFor(el) {
    for (let p = el.parentElement; p && p !== document.body && p !== root; p = p.parentElement) {
      const cs = getComputedStyle(p);
      const oy = cs.overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay')
        && p.scrollHeight - p.clientHeight >= 1 && fitsViewport(p)) return elementScroller(p);
    }
    return windowScroller();
  }

  function isPinned(el) {
    for (let p = el; p && p !== root; p = p.parentElement) {
      if (getComputedStyle(p).position === 'fixed') return true;
    }
    return false;
  }

  // Рамка элемента (во вьюпорте), обрезанная предками с overflow ≠ visible —
  // например, обёрткой таблицы с горизонтальной прокруткой. stop — где остановиться.
  function clipRect(el, stop) {
    const r = el.getBoundingClientRect();
    let { left, top, right, bottom } = r;
    for (let p = el.parentElement; p && p !== stop && p !== document.body && p !== root; p = p.parentElement) {
      const cs = getComputedStyle(p);
      const pr = p.getBoundingClientRect();
      if (cs.overflowX !== 'visible') {
        left = Math.max(left, pr.left + p.clientLeft);
        right = Math.min(right, pr.left + p.clientLeft + p.clientWidth);
      }
      if (cs.overflowY !== 'visible') {
        top = Math.max(top, pr.top + p.clientTop);
        bottom = Math.min(bottom, pr.top + p.clientTop + p.clientHeight);
      }
      if (cs.position === 'fixed') break;
    }
    return { left, top, right: Math.max(left, right), bottom: Math.max(top, bottom) };
  }

  // Область элемента в координатах содержимого прокручиваемой области sc
  function regionOf(el, sc) {
    const r = clipRect(el, sc.el);
    const c = sc.crop();
    const p = sc.pos();
    const size = sc.size();
    const x0 = Math.max(0, Math.floor(r.left - c.x + p.x));
    const y0 = Math.max(0, Math.floor(r.top - c.y + p.y));
    const x1 = Math.min(size.w, Math.ceil(r.right - c.x + p.x));
    const y1 = Math.min(size.h, Math.ceil(r.bottom - c.y + p.y));
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  // Самый большой прокручиваемый контейнер, целиком помещающийся в окне
  function findInnerScroller() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let best = null;
    let bestArea = 0;
    const walker = document.createTreeWalker(document.body || root, NodeFilter.SHOW_ELEMENT);
    let n = 0;
    for (let el = walker.currentNode; el; el = walker.nextNode()) {
      if (++n > 40000) break;
      if (el.scrollHeight - el.clientHeight < 40) continue;
      if (el.clientHeight < vh * 0.35 || el.clientWidth < vw * 0.3) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      const r = el.getBoundingClientRect();
      const left = r.left + el.clientLeft;
      const top = r.top + el.clientTop;
      if (left < -1 || top < -1 || left + el.clientWidth > vw + 1 || top + el.clientHeight > vh + 1) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) { best = el; bestArea = area; }
    }
    return best;
  }

  /* ───────────── плавающие элементы ───────────── */

  function setImportant(el, prop, value, undo) {
    const old = el.style.getPropertyValue(prop);
    const pri = el.style.getPropertyPriority(prop);
    el.style.setProperty(prop, value, 'important');
    undo.push(() => {
      if (old) el.style.setProperty(prop, old, pri);
      else el.style.removeProperty(prop);
    });
  }

  function collectFloating(sc, undo, target = null) {
    const fixed = [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const walker = document.createTreeWalker(document.body || root, NodeFilter.SHOW_ELEMENT);
    let n = 0;
    for (let el = walker.currentNode; el; el = walker.nextNode()) {
      if (++n > 60000) break;
      const pos = getComputedStyle(el).position;
      if (pos === 'sticky' || pos === '-webkit-sticky') {
        // sticky-элемент в потоке занимает то же место, что и static, —
        // раскладка не меняется, а повторяться на каждом кадре он перестаёт
        setImportant(el, 'position', 'static', undo);
      } else if (pos === 'fixed') {
        if (sc.el && el.contains(sc.el)) continue;           // оболочка приложения
        if (target && el.contains(target)) continue;         // слой, в котором сам элемент
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        if (r.width * r.height >= vw * vh * 0.85) continue;  // фоновый слой
        fixed.push(el);
      }
    }
    return fixed;
  }
})();
