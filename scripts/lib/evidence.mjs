// Functions in this file are serialised and run INSIDE the audited page.
// Each must be fully self-contained: no imports, no outer-scope references.

/** Installed before any page script runs. Records vitals, frame timing and motion curves. */
export function initScript() {
  if (window.top !== window || window.__kiln) return;
  const K = (window.__kiln = { cls: 0, shifts: [], lcp: null, longTasks: [], frames: [], tracks: [] });

  const observe = (type, cb) => { try { new PerformanceObserver((l) => l.getEntries().forEach(cb)).observe({ type, buffered: true }); } catch {} };
  observe('layout-shift', (e) => { if (!e.hadRecentInput) { K.cls += e.value; if (K.shifts.length < 50) K.shifts.push([Math.round(e.startTime), +e.value.toFixed(4)]); } });
  observe('largest-contentful-paint', (e) => {
    K.lcp = { t: Math.round(e.startTime), size: e.size, tag: e.element?.tagName || '', url: (e.url || '').slice(0, 200), text: (e.element?.innerText || '').replace(/\s+/g, ' ').slice(0, 80) };
  });
  observe('longtask', (e) => { if (K.longTasks.length < 500) K.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); });

  // Frame timing: [timestamp, gap since previous frame]
  let last = performance.now();
  const tick = (now) => { K.frames.push([Math.round(now), +(now - last).toFixed(1)]); if (K.frames.length > 30000) K.frames.splice(0, 5000); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);

  const desc = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const c = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    if (c.length) s += '.' + c.join('.');
    return s.slice(0, 80);
  };

  // Motion curves: when an element starts animating, sample its box and opacity every frame.
  const tracked = new WeakSet();
  const MOVE_PROPS = /^(transform|opacity|top|left|right|bottom|width|height|margin|translate|scale|rotate|clip-path|max-height|all)/;
  const track = (el, cause, name) => {
    if (!(el instanceof Element) || tracked.has(el) || K.tracks.length >= 12) return;
    const r0 = el.getBoundingClientRect();
    if (r0.width * r0.height < 1500) return;
    tracked.add(el);
    const start = performance.now();
    const tr = { el: desc(el), cause, name: String(name || '').slice(0, 60), abs: performance.timeOrigin + start, startMs: Math.round(start), samples: [] };
    K.tracks.push(tr);
    let still = 0, prev = '';
    const step = (now) => {
      const b = el.getBoundingClientRect();
      const op = +getComputedStyle(el).opacity;
      const s = [Math.round(now - start), +(b.x + scrollX).toFixed(1), +(b.y + scrollY).toFixed(1), +b.width.toFixed(1), +b.height.toFixed(1), +op.toFixed(3)];
      const key = s.slice(1).join(',');
      still = key === prev ? still + 1 : 0; prev = key;
      tr.samples.push(s);
      if (now - start < 3000 && !(still > 15 && now - start > 150) && el.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  document.addEventListener('animationstart', (e) => track(e.target, 'css-animation', e.animationName), true);
  document.addEventListener('transitionrun', (e) => { if (MOVE_PROPS.test(e.propertyName)) track(e.target, 'css-transition', e.propertyName); }, true);
  const mo = new MutationObserver((ms) => {
    for (const m of ms) {
      const st = m.target.getAttribute?.('style') || '';
      if (/transform|opacity|translate/.test(st)) track(m.target, 'js-style', '');
    }
  });
  const startMo = () => { try { mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'], subtree: true }); } catch {} };
  if (document.documentElement) startMo(); else document.addEventListener('DOMContentLoaded', startMo);
}

/** Snapshot of running/declared animations. Called several times; de-duplicated in Node. */
export function collectAnimations() {
  const desc = (el) => {
    if (!el || !el.tagName) return '';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const c = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    if (c.length) s += '.' + c.join('.');
    return s.slice(0, 80);
  };
  const out = [];
  let all = [];
  try { all = document.getAnimations(); } catch {}
  for (const a of all.slice(0, 300)) {
    const eff = a.effect;
    let t = {}, props = [], easings = [];
    try { t = eff.getComputedTiming(); } catch {}
    try {
      const kf = eff.getKeyframes();
      props = [...new Set(kf.flatMap((k) => Object.keys(k)))].filter((p) => !['offset', 'easing', 'composite', 'computedOffset'].includes(p));
      easings = [...new Set(kf.map((k) => k.easing).filter(Boolean))];
    } catch {}
    out.push({
      type: a.constructor.name.replace('CSS', '').toLowerCase() || 'animation',
      name: a.animationName || a.transitionProperty || a.id || '',
      target: desc(eff?.target),
      duration: typeof t.duration === 'number' ? Math.round(t.duration) : null,
      delay: Math.round(t.delay || 0),
      iterations: t.iterations === Infinity ? 'infinite' : (t.iterations ?? 1),
      easing: (t.easing && t.easing !== 'linear' ? t.easing : easings[0]) || 'linear',
      props,
    });
  }
  return out;
}

/** Fixed/sticky things sitting over the content: cookie banners, popups, chat widgets, sticky bars. */
export function collectOverlays() {
  const vw = innerWidth, vh = innerHeight, out = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.05 || cs.pointerEvents === 'none') continue;
    if (el.hasAttribute('data-kiln-blocker')) continue; // reported separately as a popup
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)), h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    if (w < 30 || h < 30) continue;
    if (cs.position === 'sticky' && r.top > 4 && r.bottom < vh - 4) continue; // sticky but not currently stuck
    const id = `${el.id} ${typeof el.className === 'string' ? el.className : ''}`.toLowerCase();
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const areaPct = Math.round((w * h) / (vw * vh) * 100);
    let kind = 'fixed-element';
    if (/cookie|consent|gdpr|onetrust|cookiebot|privacy/.test(id) || /\bcookies?\b/i.test(text.slice(0, 300))) kind = 'cookie-banner';
    else if (/intercom|crisp|drift|hubspot-messages|tawk|zendesk|chat|tidio|livechat/.test(id) || (el.tagName === 'IFRAME' && /chat|messenger/i.test(el.title || ''))) kind = 'chat-widget';
    else if (areaPct >= 55) continue; // page wrappers and popups: popups are found by findBlocker
    else if (r.top <= 4 && r.width > vw * 0.8) kind = 'sticky-header';
    else if (r.bottom >= vh - 4 && r.width > vw * 0.8) kind = 'sticky-footer-bar';
    out.push({ kind, areaPct, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], text: text.slice(0, 100), el: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}` });
  }
  // keep outermost: drop entries fully inside an earlier bigger one of the same kind
  out.sort((a, b) => b.areaPct - a.areaPct);
  const kept = [];
  for (const o of out) {
    if (kept.some((k) => k.kind === o.kind && o.rect[0] >= k.rect[0] && o.rect[1] >= k.rect[1] && o.rect[0] + o.rect[2] <= k.rect[0] + k.rect[2] + 1 && o.rect[1] + o.rect[3] <= k.rect[1] + k.rect[3] + 1)) continue;
    kept.push(o);
    if (kept.length >= 8) break;
  }
  return kept;
}

/**
 * Is something sitting on top of the middle of the screen? Returns the popup's
 * details and tags it, or null. Works for popups rendered inside iframes too,
 * because it asks the browser what is actually under five points on screen.
 */
export function findBlocker() {
  const vw = innerWidth, vh = innerHeight;
  document.querySelectorAll('[data-kiln-blocker]').forEach((e) => e.removeAttribute('data-kiln-blocker'));
  const hits = new Map();
  for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.36], [0.5, 0.64], [0.32, 0.5], [0.68, 0.5]]) {
    let p = document.elementFromPoint(vw * fx, vh * fy), fixed = null;
    while (p && p !== document.documentElement && p !== document.body) { if (getComputedStyle(p).position === 'fixed') fixed = p; p = p.parentElement; }
    if (fixed) hits.set(fixed, (hits.get(fixed) || 0) + 1);
  }
  const best = [...hits.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 3) return null;
  const el = best[0];
  const pageText = (document.body.innerText || '').length || 1;
  if ((el.innerText || '').length / pageText > 0.6) return null; // the page itself lives in a fixed scroller
  // visible extent: union of visible descendants, since the fixed wrapper is often full-screen and transparent
  let x0 = vw, y0 = vh, x1 = 0, y1 = 0;
  for (const c of [el, ...el.querySelectorAll('*')].slice(0, 400)) {
    const cs = getComputedStyle(c);
    const paints = c.tagName === 'IFRAME' || c.tagName === 'IMG' || (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent' && !/rgba\(.*,\s*0(\.[0-4]\d*)?\)$/.test(cs.backgroundColor));
    if (!paints) continue;
    const r = c.getBoundingClientRect();
    if (r.width < 40 || r.height < 40 || (r.width >= vw * 0.98 && r.height >= vh * 0.98)) continue; // skip dimming backdrops
    x0 = Math.min(x0, Math.max(0, r.left)); y0 = Math.min(y0, Math.max(0, r.top)); x1 = Math.max(x1, Math.min(vw, r.right)); y1 = Math.max(y1, Math.min(vh, r.bottom));
  }
  const area = x1 > x0 && y1 > y0 ? Math.round((x1 - x0) * (y1 - y0) / (vw * vh) * 100) : 100;
  if (area < 18) return null;
  el.setAttribute('data-kiln-blocker', '1');
  return {
    areaPct: area, el: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`.slice(0, 80), text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    isDialog: !!el.querySelector('[role=dialog],dialog,[aria-modal=true]') || el.matches('[role=dialog],dialog,[aria-modal=true]'), inIframe: !!el.querySelector('iframe') || el.tagName === 'IFRAME',
    sinceLoadMs: Math.round(performance.now()), scrollY: Math.round(scrollY),
  };
}

/** Click the obvious "accept" button of a cookie banner so it does not cover every later screenshot. */
export function dismissCookieBanner() {
  const OK = /^(accept( all)?( cookies)?|allow( all)?( cookies)?|i agree|agree|got it!?|ok(ay)?|accept (&|and) (close|continue)|understood|i understand|yes,? i agree|continue)$/i;
  const btns = [...document.querySelectorAll('button, a, [role=button], input[type=button], input[type=submit]')];
  for (const b of btns) {
    const t = (b.innerText || b.value || '').replace(/\s+/g, ' ').trim();
    if (!OK.test(t)) continue;
    const r = b.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    let p = b, hit = false;
    for (let i = 0; i < 8 && p; i++, p = p.parentElement) {
      const cs = getComputedStyle(p);
      const id = `${p.id} ${typeof p.className === 'string' ? p.className : ''}`.toLowerCase();
      if (/cookie|consent|gdpr|onetrust|cookiebot/.test(id) || ((cs.position === 'fixed' || cs.position === 'sticky') && /cookie/i.test(p.innerText || ''))) { hit = true; break; }
    }
    if (hit) { b.click(); return t; }
  }
  return null;
}

/** The main static evidence sweep for one page at one viewport. */
export function collectEvidence(opts) {
  const vw = innerWidth, vh = innerHeight;
  const doc = document.documentElement;
  const pageH = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const clean = (s, n = 80) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05;
  };
  const desc = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const c = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    if (c.length) s += '.' + c.join('.');
    return s.slice(0, 70);
  };
  const label = (el) => clean(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || el.querySelector?.('img[alt]')?.alt || '', 60);
  const metaC = (sel) => document.querySelector(sel)?.getAttribute('content') || null;
  const tally = (map, k, n = 1) => map.set(k, (map.get(k) || 0) + n);
  const top = (map, n) => { const tot = [...map.values()].reduce((a, b) => a + b, 0) || 1; return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ value: k, share: Math.round(v / tot * 100) })); };
  const pageY = (el) => Math.round(el.getBoundingClientRect().top + scrollY);
  const transparent = (c) => !c || c === 'transparent' || /rgba\(.*,\s*0\)$/.test(c);

  // ---------- head / meta ----------
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(vis);
  const outline = headings.slice(0, 40).map((h) => ({ level: +h.tagName[1], text: clean(h.innerText, 90) }));
  const skips = [];
  for (let i = 1; i < outline.length; i++) if (outline[i].level - outline[i - 1].level > 1) skips.push(`h${outline[i - 1].level} -> h${outline[i].level} at "${outline[i].text.slice(0, 40)}"`);
  const icon = document.querySelector('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]');
  const meta = {
    title: document.title || null,
    titleLength: (document.title || '').length,
    description: metaC('meta[name="description"]'),
    canonical: document.querySelector('link[rel=canonical]')?.href || null,
    lang: doc.getAttribute('lang'),
    viewport: metaC('meta[name=viewport]'),
    robots: metaC('meta[name=robots]'),
    generator: metaC('meta[name=generator]'),
    ogTitle: metaC('meta[property="og:title"]'),
    ogDescription: metaC('meta[property="og:description"]'),
    ogImage: metaC('meta[property="og:image"]'),
    twitterCard: metaC('meta[name="twitter:card"]'),
    favicon: icon ? icon.href : null,
    structuredData: document.querySelectorAll('script[type="application/ld+json"]').length,
    h1: headings.filter((h) => h.tagName === 'H1').map((h) => clean(h.innerText, 120)),
    headingOutline: outline,
    headingSkips: skips.slice(0, 6),
  };

  // ---------- typography & colour ----------
  const fam = new Map(), sizes = new Map(), weights = new Map(), colors = new Map();
  let small = 0, smallSamples = [], textEls = 0, wideParas = 0, tightLines = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  let node, guard = 0;
  while ((node = walker.nextNode()) && guard++ < 6000) {
    const t = node.nodeValue.trim();
    if (t.length < 2) continue;
    const el = node.parentElement;
    if (!el || seen.has(el) || /^(SCRIPT|STYLE|NOSCRIPT|OPTION)$/.test(el.tagName)) continue;
    seen.add(el);
    if (!vis(el)) continue;
    const cs = getComputedStyle(el);
    const n = t.length, fs = parseFloat(cs.fontSize);
    textEls++;
    tally(fam, cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(), n);
    tally(sizes, Math.round(fs) + 'px', n);
    tally(weights, cs.fontWeight, n);
    tally(colors, cs.color, n);
    if (fs < 12) { small += n; if (smallSamples.length < 5) smallSamples.push(`${Math.round(fs * 10) / 10}px "${t.slice(0, 40)}"`); }
    const lh = parseFloat(cs.lineHeight);
    if (n > 120 && lh && lh / fs < 1.3) tightLines++;
    if (n > 200 && el.getBoundingClientRect().width / (fs * 0.5) > 100) wideParas++;
  }
  const bg = new Map();
  for (const el of document.querySelectorAll('body, body *')) {
    const r = el.getBoundingClientRect();
    if (r.width < vw * 0.5 || r.height < 120) continue;
    const c = getComputedStyle(el).backgroundColor;
    if (!transparent(c)) tally(bg, c, Math.round(r.width * r.height / 1000));
  }
  const typography = {
    families: top(fam, 6), familyCount: fam.size,
    sizes: top(sizes, 12), sizeCount: sizes.size,
    weights: top(weights, 6),
    textColors: top(colors, 8), textColorCount: colors.size,
    backgroundColors: top(bg, 6),
    smallTextChars: small, smallTextSamples: smallSamples,
    paragraphsOver100Chars: wideParas, tightLineHeightBlocks: tightLines, textElements: textEls,
  };

  // ---------- buttons / calls to action ----------
  const interactive = [...document.querySelectorAll('a[href], button, [role=button], input[type=submit], input[type=button]')].filter(vis);
  const buttons = [];
  for (const el of interactive) {
    const cs = getComputedStyle(el);
    const isBtnTag = el.tagName !== 'A';
    const styled = !transparent(cs.backgroundColor) || (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && parseFloat(cs.paddingLeft) >= 8);
    if (!isBtnTag && !styled) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 16 || r.width > vw * 0.95 && r.height > 200) continue;
    const text = label(el);
    if (!text) continue;
    buttons.push({
      text, bg: cs.backgroundColor, color: cs.color, radius: cs.borderTopLeftRadius, fontSize: Math.round(parseFloat(cs.fontSize)),
      w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: pageY(el),
      aboveFold: r.top + scrollY < vh, inHeader: !!el.closest('header, nav'), href: el.getAttribute('href') || null,
    });
    if (buttons.length >= 80) break;
  }
  const styleKey = (b) => `${b.bg}|${b.color}|${b.radius}`;
  const btnStyles = new Map(), btnTexts = new Map(), radii = new Map();
  buttons.forEach((b) => { tally(btnStyles, styleKey(b)); tally(btnTexts, b.text.toLowerCase()); tally(radii, b.radius); });
  const cta = {
    count: buttons.length,
    aboveFold: buttons.filter((b) => b.aboveFold).map((b) => ({ text: b.text, bg: b.bg, w: b.w, h: b.h, inHeader: b.inHeader })).slice(0, 8),
    distinctStyles: btnStyles.size,
    styles: [...btnStyles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => { const [bgc, col, rad] = k.split('|'); return { bg: bgc, color: col, radius: rad, count: n }; }),
    distinctRadii: [...radii.keys()].slice(0, 8),
    texts: [...btnTexts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, n]) => ({ text: k, count: n })),
    positions: buttons.filter((b) => !b.inHeader).slice(0, 25).map((b) => ({ text: b.text, y: b.y })),
  };

  // ---------- layout problems ----------
  const overflowPx = doc.scrollWidth - vw;
  const overflowOffenders = [];
  if (overflowPx > 1) {
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || (r.right <= vw + 2 && r.left >= -2)) continue;
      let p = el.parentElement, clipped = false;
      while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o !== 'visible') { clipped = true; break; } p = p.parentElement; }
      if (clipped || !vis(el)) continue;
      overflowOffenders.push({ el: desc(el), right: Math.round(r.right), y: pageY(el), w: Math.round(r.width) });
      if (overflowOffenders.length >= 6) break;
    }
  }
  let tapSmall = 0, tapTiny = 0; const tapSamples = [];
  if (opts.mobile) {
    for (const el of interactive) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (cs.display === 'inline' && el.parentElement && (el.parentElement.innerText || '').length > (el.innerText || '').length * 2) continue; // inline link in a sentence
      if (r.width >= 44 && r.height >= 44) continue;
      tapSmall++;
      if (r.width < 24 || r.height < 24) tapTiny++;
      if (tapSamples.length < 8) tapSamples.push({ el: desc(el), text: label(el).slice(0, 30), w: Math.round(r.width), h: Math.round(r.height), y: pageY(el) });
    }
  }
  const layout = {
    pageHeight: pageH, viewport: [vw, vh], screens: +(pageH / vh).toFixed(1),
    horizontalOverflowPx: overflowPx > 1 ? overflowPx : 0, overflowOffenders,
    tapTargetsUnder44: tapSmall, tapTargetsUnder24: tapTiny, tapSamples,
    interactiveCount: interactive.length,
  };

  // ---------- images / media ----------
  const imgs = [...document.images];
  const broken = [], oversized = [], upscaled = [], formats = new Map();
  let noAlt = 0, noDims = 0, lazy = 0;
  for (const im of imgs) {
    const src = im.currentSrc || im.src || '';
    if (!im.hasAttribute('alt')) noAlt++;
    if (!im.getAttribute('width') && !im.getAttribute('height') && !im.style.aspectRatio) noDims++;
    if (im.loading === 'lazy') lazy++;
    const ext = (src.split('?')[0].match(/\.([a-z0-9]{2,5})$/i) || [, src.startsWith('data:') ? 'data-uri' : 'other'])[1].toLowerCase();
    tally(formats, ext);
    if (im.complete && im.naturalWidth === 0 && src && !src.startsWith('data:')) { if (broken.length < 10) broken.push(src.slice(0, 160)); continue; }
    const r = im.getBoundingClientRect();
    if (r.width < 8) continue;
    const dpr = devicePixelRatio || 1;
    if (im.naturalWidth > r.width * dpr * 2 && im.naturalWidth > 1200 && oversized.length < 8) oversized.push({ src: src.slice(0, 120), natural: im.naturalWidth, shown: Math.round(r.width) });
    if (im.naturalWidth && r.width > im.naturalWidth * 1.3 && r.width > 200 && !/\.svg/i.test(src) && upscaled.length < 8) upscaled.push({ src: src.slice(0, 120), natural: im.naturalWidth, shown: Math.round(r.width) });
  }
  const videos = [...document.querySelectorAll('video')].slice(0, 6).map((v) => ({
    src: (v.currentSrc || v.querySelector('source')?.src || '').slice(0, 200), autoplay: v.autoplay, muted: v.muted, loop: v.loop, playsinline: v.playsInline,
    controls: v.controls, poster: !!v.poster, preload: v.preload, w: v.videoWidth, h: v.videoHeight, duration: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
    shown: [Math.round(v.getBoundingClientRect().width), Math.round(v.getBoundingClientRect().height)], y: pageY(v),
  }));
  const canvases = [...document.querySelectorAll('canvas')].filter(vis).slice(0, 6).map((c, i) => {
    c.setAttribute('data-kiln-canvas', String(i));
    const r = c.getBoundingClientRect();
    return { i, w: Math.round(r.width), h: Math.round(r.height), y: pageY(c), backing: [c.width, c.height] };
  });
  const media = {
    images: imgs.length, missingAlt: noAlt, withoutDimensions: noDims, lazyLoaded: lazy, formats: Object.fromEntries(formats),
    broken, oversized, upscaled, videos, canvases,
    iframes: [...document.querySelectorAll('iframe[src]')].slice(0, 10).map((f) => { try { return new URL(f.src).host; } catch { return 'invalid'; } }),
    inlineSvgs: document.querySelectorAll('svg').length,
  };

  // ---------- forms ----------
  const forms = [...document.querySelectorAll('form')].filter(vis).slice(0, 6).map((f, i) => {
    f.setAttribute('data-kiln-form', String(i));
    const fields = [...f.querySelectorAll('input, select, textarea')].filter((x) => !['hidden', 'submit', 'button'].includes(x.type) && vis(x));
    const describe = (x) => {
      let how = null;
      if (x.id && f.ownerDocument.querySelector(`label[for="${CSS.escape(x.id)}"]`)) how = 'label';
      else if (x.closest('label')) how = 'label';
      else if (x.getAttribute('aria-label') || x.getAttribute('aria-labelledby')) how = 'aria';
      else if (x.placeholder) how = 'placeholder-only';
      return { type: x.type || x.tagName.toLowerCase(), name: x.name || x.id || '', labelled: how, required: x.required, autocomplete: x.autocomplete || null, placeholder: clean(x.placeholder, 40) || null };
    };
    const submit = f.querySelector('button[type=submit], input[type=submit], button:not([type])');
    return {
      i, y: pageY(f), fields: fields.map(describe), fieldCount: fields.length,
      unlabelled: fields.map(describe).filter((d) => !d.labelled || d.labelled === 'placeholder-only').length,
      submitText: submit ? label(submit) : null, action: (f.getAttribute('action') || '').slice(0, 120), method: f.method,
      isSearch: f.getAttribute('role') === 'search' || fields.length === 1 && fields[0].type === 'search',
    };
  });

  // ---------- links ----------
  const anchors = [...document.querySelectorAll('a[href]')];
  const hrefs = new Map();
  let emptyText = 0, hashOnly = 0, blankNoRel = 0;
  for (const a of anchors) {
    const raw = a.getAttribute('href') || '';
    if (raw === '#' || raw === '' || raw.startsWith('javascript:')) { if (vis(a)) hashOnly++; continue; }
    if (vis(a) && !label(a)) emptyText++;
    if (a.target === '_blank' && !/noopener|noreferrer/.test(a.rel)) blankNoRel++;
    if (/^(mailto|tel|sms):/i.test(raw)) continue;
    try { const u = new URL(a.href); u.hash = ''; if (/^https?:$/.test(u.protocol) && !hrefs.has(u.href)) hrefs.set(u.href, { href: u.href, text: label(a).slice(0, 40), internal: u.host.replace(/^www\./, '') === location.host.replace(/^www\./, '') }); } catch {}
  }
  const footer = document.querySelector('footer') || document.body;
  const findLink = (re) => { const a = [...document.querySelectorAll('a[href]')].find((x) => re.test(x.innerText || '') || re.test(x.getAttribute('href') || '')); return a ? a.href : null; };
  const links = {
    total: anchors.length, unique: hrefs.size, list: [...hrefs.values()].slice(0, 300),
    emptyText, deadHashLinks: hashOnly, blankWithoutNoopener: blankNoRel,
    privacy: findLink(/privacy/i), terms: findLink(/terms|conditions|\btos\b/i),
    contact: findLink(/contact/i), mailto: [...new Set(anchors.filter((a) => /^mailto:/i.test(a.getAttribute('href') || '')).map((a) => a.getAttribute('href').slice(7).split('?')[0]))].slice(0, 4),
    tel: anchors.some((a) => /^tel:/i.test(a.getAttribute('href') || '')),
    social: [...new Set(anchors.map((a) => { try { return new URL(a.href).host.replace(/^www\./, ''); } catch { return ''; } }).filter((h) => /^(twitter|x|linkedin|facebook|instagram|youtube|tiktok|github|threads)\./.test(h)))],
  };

  // ---------- copy ----------
  const bodyText = (document.querySelector('main') || document.body).innerText || '';
  const placeholderHits = [];
  for (const re of [/lorem ipsum[^.]{0,40}/i, /\b(your|insert|add) (text|title|heading|headline|description|content|tagline) here\b/i, /\bplaceholder (text|title|content)\b/i, /\b(heading|title|subtitle) (one|two|[1-9])\b/i, /\bjohn doe\b|\bjane doe\b/i, /\b(TODO|FIXME|TBD)\b/, /example\.com/i, /\bcoming soon\b/i, /\[[A-Z][A-Za-z ]{2,30}\]/]) {
    const m = bodyText.match(re); if (m) placeholderHits.push(clean(m[0], 60));
  }
  const footText = footer.innerText || '';
  const years = [...footText.matchAll(/(?:©|\(c\)|copyright)[^\d]{0,30}(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => +m[1]);
  const copy = {
    words: bodyText.split(/\s+/).filter(Boolean).length,
    placeholderHits, copyrightYear: years.length ? Math.max(...years) : null, currentYear: new Date().getFullYear(),
    text: bodyText.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 9000),
  };

  // ---------- sections ----------
  let root = document.querySelector('main') || document.body;
  for (let i = 0; i < 6; i++) {
    const kids = [...root.children].filter((c) => !/^(SCRIPT|STYLE|NOSCRIPT|LINK|TEMPLATE)$/.test(c.tagName) && vis(c) && c.getBoundingClientRect().height >= 80);
    if (kids.length === 1 && kids[0].children.length) root = kids[0]; else break;
  }
  const blocks = new Set([...root.children].filter((c) => !/^(SCRIPT|STYLE|NOSCRIPT|LINK|TEMPLATE)$/.test(c.tagName) && vis(c) && c.getBoundingClientRect().height >= 100 && c.getBoundingClientRect().width >= vw * 0.6));
  const hdr = document.querySelector('header'), ftr = document.querySelector('footer');
  if (hdr && vis(hdr) && ![...blocks].some((b) => b.contains(hdr))) blocks.add(hdr);
  if (ftr && vis(ftr) && ![...blocks].some((b) => b.contains(ftr))) blocks.add(ftr);
  const sections = [...blocks].map((el) => {
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') return null;
    const r = el.getBoundingClientRect();
    const text = el.innerText || '';
    const head = clean(el.querySelector('h1,h2,h3')?.innerText, 80);
    const idc = `${el.id} ${typeof el.className === 'string' ? el.className : ''}`.toLowerCase();
    const words = text.split(/\s+/).filter(Boolean).length;
    const nImgs = el.querySelectorAll('img, svg').length;
    const y = Math.round(r.top + scrollY);
    let kind = 'content';
    if (el.tagName === 'FOOTER' || /\bfooter\b/.test(idc)) kind = 'footer';
    else if (el.tagName === 'HEADER' || el.tagName === 'NAV' || (y < 40 && r.height < 160)) kind = 'header';
    else if (el.querySelector('h1') && y < vh * 1.2) kind = 'hero';
    else if (/pricing|plans?\b/.test(idc + ' ' + head.toLowerCase()) || /(\$|€|£)\s?\d+.{0,12}(\/|per )\s?(mo|month|year|yr|user)/i.test(text)) kind = 'pricing';
    else if (/testimonial|review|what .{0,30} (say|think)|loved by|customer stories/i.test(idc + ' ' + head) || el.querySelector('blockquote')) kind = 'testimonials';
    else if (/faq|frequently asked|questions/i.test(idc + ' ' + head) || el.querySelectorAll('details').length >= 2) kind = 'faq';
    else if (/trusted by|as seen|used by|our (partners|clients|customers)|logos?\b/i.test(idc + ' ' + text.slice(0, 200)) && nImgs >= 3 && words < 60) kind = 'logos';
    else if (el.querySelector('form') && el.querySelectorAll('input, textarea').length >= 2) kind = 'form';
    else if (/feature|benefit|how it works|why /i.test(idc + ' ' + head)) kind = 'features';
    else if (words < 60 && el.querySelector('a, button') && y > pageH * 0.6) kind = 'closing-cta';
    return { kind, heading: head, el: desc(el), y, h: Math.round(r.height), words, images: nImgs, bg: transparent(cs.backgroundColor) ? null : cs.backgroundColor, buttons: [...el.querySelectorAll('a,button')].filter((b) => buttons.some((x) => x.text === label(b))).map(label).slice(0, 4) };
  }).filter(Boolean).sort((a, b) => a.y - b.y).slice(0, 24);
  // Fill gaps the block walk missed (heroes are often siblings of <main>, or absolutely positioned).
  {
    const heads = [...document.querySelectorAll('h1,h2,h3')].filter(vis).map((h) => ({ y: pageY(h), text: clean(h.innerText, 80), tag: h.tagName }));
    const filled = []; let cursor = 0;
    const gap = (from, to) => {
      if (to - from < 220) return;
      const hd = heads.find((h) => h.y >= from - 10 && h.y < to);
      const isHero = from < vh * 0.5 && heads.some((h) => h.tag === 'H1' && h.y >= from - 10 && h.y < to);
      filled.push({ kind: isHero ? 'hero' : 'content', heading: hd ? hd.text : '', el: '(unwrapped region)', y: from, h: to - from, words: 0, images: 0, bg: null, buttons: buttons.filter((b) => b.y >= from && b.y < to && !b.inHeader).map((b) => b.text).slice(0, 4) });
    };
    for (const s of sections) { gap(cursor, s.y); cursor = Math.max(cursor, s.y + s.h); }
    gap(cursor, pageH);
    sections.push(...filled); sections.sort((a, b) => a.y - b.y); sections.splice(24);
  }
  sections.forEach((s, i) => { s.i = i + 1; });

  // ---------- above the fold ----------
  const h1El = document.querySelector('h1');
  const fold = {
    h1Visible: !!h1El && vis(h1El) && h1El.getBoundingClientRect().top + scrollY < vh - 20,
    h1FontSize: h1El ? Math.round(parseFloat(getComputedStyle(h1El).fontSize)) : null,
    ctaCount: buttons.filter((b) => b.aboveFold && !b.inHeader).length,
    headerCta: buttons.find((b) => b.aboveFold && b.inHeader)?.text || null,
  };

  // ---------- tech & interaction styling ----------
  const w = window, has = (sel) => !!document.querySelector(sel);
  const tech = [];
  const add = (cond, name) => { try { if (cond()) tech.push(name); } catch {} };
  add(() => w.gsap || w.TweenMax, 'GSAP'); add(() => w.THREE, 'three.js'); add(() => w.lottie || w.bodymovin || has('lottie-player, dotlottie-player'), 'Lottie');
  add(() => w.jQuery, 'jQuery'); add(() => w.Swiper || has('.swiper'), 'Swiper'); add(() => w.AOS || has('[data-aos]'), 'AOS');
  add(() => has('[data-framer-name], #__framer-badge-container') || /framer/i.test(meta.generator || ''), 'Framer');
  add(() => doc.hasAttribute('data-wf-site'), 'Webflow'); add(() => /wix/i.test(meta.generator || '') || w.wixBiSession, 'Wix');
  add(() => /squarespace/i.test(meta.generator || '') || w.Squarespace, 'Squarespace'); add(() => /wordpress/i.test(meta.generator || '') || has('link[href*="wp-content"], script[src*="wp-content"]'), 'WordPress');
  add(() => /elementor/i.test(meta.generator || '') || has('.elementor'), 'Elementor'); add(() => w.Shopify, 'Shopify');
  add(() => w.__NEXT_DATA__ || has('script[src*="/_next/"]'), 'Next.js'); add(() => w.__NUXT__, 'Nuxt'); add(() => has('[data-astro-cid], astro-island') || /astro/i.test(meta.generator || ''), 'Astro');
  add(() => /gatsby/i.test(meta.generator || '') || has('#___gatsby'), 'Gatsby'); add(() => /hubspot/i.test(meta.generator || ''), 'HubSpot CMS');
  add(() => has('[class*="md:"],[class*="sm:"],[class*="lg:"]'), 'Tailwind-style utility classes'); add(() => has('.container .row [class*="col-"]'), 'Bootstrap-style grid');
  add(() => w.dataLayer || w.gtag || w.ga, 'Google Analytics/Tag Manager'); add(() => w.fbq, 'Meta Pixel'); add(() => w.Intercom, 'Intercom'); add(() => w.HubSpotConversations || w._hsq, 'HubSpot tracking');
  add(() => w.Lenis || has('.lenis, html.lenis'), 'Lenis smooth scroll'); add(() => w.ScrollTrigger, 'GSAP ScrollTrigger');
  let noTransition = 0, withTransition = 0; const durations = new Map();
  for (const el of interactive.slice(0, 150)) {
    const d = Math.max(...getComputedStyle(el).transitionDuration.split(',').map((x) => parseFloat(x) * (x.includes('ms') ? 1 : 1000)));
    if (d > 0) { withTransition++; tally(durations, Math.round(d) + 'ms'); } else noTransition++;
  }
  let reducedMotionRule = false, unreadableSheets = 0;
  for (const sh of document.styleSheets) {
    try { for (const r of sh.cssRules) if (r.media && /prefers-reduced-motion/.test(r.media.mediaText)) { reducedMotionRule = true; break; } }
    catch { unreadableSheets++; }
    if (reducedMotionRule) break;
  }
  const motionCss = { interactiveWithTransition: withTransition, interactiveWithoutTransition: noTransition, transitionDurations: top(durations, 6), reducedMotionRule, unreadableSheets, scrollBehavior: getComputedStyle(doc).scrollBehavior };

  // ---------- performance ----------
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const paints = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]));
  const res = performance.getEntriesByType('resource');
  const byType = {}; let bytes = nav.transferSize || 0; const hosts = new Set(); const big = [];
  for (const r of res) {
    const ext = (r.name.split('?')[0].match(/\.([a-z0-9]{2,5})$/i) || [, ''])[1].toLowerCase();
    let type = r.initiatorType;
    if (/^(js|mjs)$/.test(ext) || type === 'script') type = 'script';
    else if (ext === 'css' || (type === 'link' && !ext)) type = 'css';
    else if (/^(png|jpe?g|gif|webp|avif|svg|ico)$/.test(ext) || type === 'img') type = 'image';
    else if (/^(woff2?|ttf|otf|eot)$/.test(ext)) type = 'font';
    else if (/^(mp4|webm|mov|m3u8)$/.test(ext) || type === 'video') type = 'media';
    else type = 'other';
    const size = r.transferSize || r.encodedBodySize || 0;
    byType[type] = (byType[type] || 0) + size; bytes += size;
    try { const h = new URL(r.name).host; if (h !== location.host) hosts.add(h); } catch {}
    big.push({ url: r.name.slice(0, 140), kb: Math.round(size / 1024), type });
  }
  const K = w.__kiln || {};
  const lt = K.longTasks || [];
  const perf = {
    ttfb: Math.round(nav.responseStart || 0) || null, domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0) || null, load: Math.round(nav.loadEventEnd || 0) || null,
    fcp: paints['first-contentful-paint'] ?? null, lcp: K.lcp ? K.lcp.t : null, lcpElement: K.lcp ? `${K.lcp.tag} ${K.lcp.text || K.lcp.url}`.trim().slice(0, 120) : null,
    cls: +(K.cls || 0).toFixed(3), longTasks: lt.length, totalBlockingTime: Math.round(lt.reduce((a, [, d]) => a + Math.max(0, d - 50), 0)),
    requests: res.length + 1, transferKb: Math.round(bytes / 1024), byTypeKb: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, Math.round(v / 1024)])),
    largest: big.sort((a, b) => b.kb - a.kb).slice(0, 6), thirdPartyHosts: hosts.size, domNodes: document.getElementsByTagName('*').length,
    fontsLoaded: [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, '')))].slice(0, 10),
  };

  return { meta, typography, cta, layout, media, forms, links, copy, sections, fold, tech, motionCss, perf };
}

/** Frame-gap statistics for frames at or after `since` (performance.now() ms). */
export function frameStats(since) {
  const K = window.__kiln; if (!K) return null;
  const f = K.frames.filter(([t]) => t >= since).map(([, g]) => g);
  if (f.length < 5) return null;
  const sum = f.reduce((a, b) => a + b, 0);
  return { frames: f.length, avgFps: Math.round(1000 / (sum / f.length)), maxGapMs: Math.round(Math.max(...f)), gapsOver50ms: f.filter((g) => g > 50).length, gapsOver100ms: f.filter((g) => g > 100).length };
}

export function getTracks() { const K = window.__kiln; return K ? { tracks: K.tracks, timeOrigin: performance.timeOrigin } : { tracks: [], timeOrigin: 0 }; }
