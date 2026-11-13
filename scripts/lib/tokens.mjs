// Design-system checks. `collectDesign` runs in the page and measures what is
// actually used: declared CSS variables (tokens), every colour / spacing /
// radius / font size, and the style of each *role* (h1, h2, body text, buttons,
// fields, cards, icons, images, section containers). `analyseDesign` then
// compares like with like across pages, and `componentSheets` lays instances of
// the same component side by side so drift can be seen.
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { esc } from './compose.mjs';

/** Runs in the browser. Self-contained. */
export function collectDesign() {
  const vw = innerWidth;
  const cv = document.createElement('canvas').getContext('2d');
  const hex = (c) => { // normalise any CSS colour to #rrggbb, or rgba() when translucent
    if (!c) return null;
    cv.fillStyle = '#010203'; cv.fillStyle = c;
    const v = cv.fillStyle;
    return v === '#010203' && !/^#?010203$|rgb\(1, ?2, ?3\)/i.test(c) ? null : v;
  };
  const clear = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
  const n1 = (v) => Math.round(parseFloat(v) * 10) / 10 || 0;
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05; };
  const skip = (el) => !!el.closest('[data-kiln-blocker]') || (() => { let p = el; while (p && p !== document.body) { if (getComputedStyle(p).position === 'fixed' && !p.matches('header, nav') && !p.querySelector('nav')) return true; p = p.parentElement; } return false; })();
  const fam = (cs) => cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
  const txt = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const tally = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, count]) => ({ value, count }));
  const radius = (el, cs) => { const v = cs.borderTopLeftRadius; if (v.includes('%')) return parseFloat(v) >= 50 ? 'pill' : v; const r = el.getBoundingClientRect(); const p = parseFloat(v) || 0; return p > 0 && p >= Math.min(r.width, r.height) / 2 - 1 ? 'pill' : `${Math.round(p)}px`; };
  const border = (cs) => (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' ? `${n1(cs.borderTopWidth)}px ${hex(cs.borderTopColor)}` : 'none');

  // ---- declared tokens (CSS variables on :root / html / body) ----
  const declared = {}; let unreadableSheets = 0;
  const rootSel = /(^|,)\s*(:root|html|body)\s*(,|$)/;
  const visit = (rules, depth = 0) => {
    for (const r of rules) {
      if (r.style && r.selectorText && rootSel.test(r.selectorText)) for (const name of r.style) if (name.startsWith('--') && !name.startsWith('--tw-')) declared[name] = 1;
      if (r.cssRules && !r.selectorText && depth < 3) visit(r.cssRules, depth + 1);
    }
  };
  for (const s of document.styleSheets) { try { visit(s.cssRules); } catch { unreadableSheets++; } }
  const rootCs = getComputedStyle(document.documentElement), rootFs = parseFloat(rootCs.fontSize) || 16;
  const tokens = { colors: [], lengths: [], other: 0, unreadableSheets };
  for (const name of Object.keys(declared).slice(0, 500)) {
    const v = rootCs.getPropertyValue(name).trim();
    if (!v) continue;
    const len = v.match(/^(-?[\d.]+)(px|rem|em)$/);
    if (len) tokens.lengths.push({ name, px: Math.round(parseFloat(len[1]) * (len[2] === 'px' ? 1 : rootFs) * 10) / 10 });
    else if (!/^[\d.\s-]+$/.test(v) && hex(v)) tokens.colors.push({ name, value: hex(v) });
    else tokens.other++;
  }

  // ---- every value in use ----
  const textColors = new Map(), bgColors = new Map(), borderColors = new Map(), spacing = new Map(), radii = new Map(), shadows = new Map(), sizes = new Map();
  let scanned = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (scanned > 5000) break;
    if (/^(SCRIPT|STYLE|NOSCRIPT|BR|OPTION|PATH|G|DEFS|CIRCLE|RECT|LINE|POLYGON|USE)$/i.test(el.tagName) || !vis(el) || skip(el)) continue;
    scanned++;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue.trim()).join('').length;
    if (own > 1) { tally(textColors, hex(cs.color), own); tally(sizes, n1(cs.fontSize), own); }
    if (!clear(cs.backgroundColor) && r.width * r.height > 400) tally(bgColors, hex(cs.backgroundColor));
    if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' && !clear(cs.borderTopColor)) tally(borderColors, hex(cs.borderTopColor));
    for (const p of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginBottom', 'rowGap', 'columnGap']) { const v = parseFloat(cs[p]); if (v >= 2 && v <= 200) tally(spacing, Math.round(v * 2) / 2); }
    if (parseFloat(cs.borderTopLeftRadius) > 0 && r.width > 20) tally(radii, radius(el, cs));
    if (cs.boxShadow && cs.boxShadow !== 'none') tally(shadows, cs.boxShadow);
  }

  // ---- roles: the same kind of element, wherever it appears ----
  const roles = {}, crops = [];
  const add = (role, el, sig, { crop = false, motion = false } = {}) => {
    const key = Object.entries(sig).map(([k, v]) => `${k}=${v}`).join('; ');
    const list = (roles[role] ||= new Map());
    const e = list.get(key) || { sig, count: 0, sample: txt(el) };
    e.count++; list.set(key, e);
    if (motion) { const cs = getComputedStyle(el); const d = cs.transitionDuration.split(',').map((x) => parseFloat(x) * (x.includes('ms') ? 1 : 1000)).filter((x) => x > 0); e.transition ||= d.length ? `${Math.round(Math.max(...d))}ms ${cs.transitionTimingFunction.split(/,(?![^(]*\))/)[0].trim()}` : 'none'; }
    if (crop && e.count <= 2 && crops.filter((c) => c.role === role).length < (/button/.test(role) ? 7 : 5)) { const id = `${role}-${crops.length}`; el.setAttribute('data-kiln-ds', id); crops.push({ id, role, key, text: txt(el), top: !!el.closest('header, nav') }); }
  };
  const typeSig = (cs) => ({ font: fam(cs), size: `${n1(cs.fontSize)}px`, weight: cs.fontWeight, 'line-height': cs.lineHeight === 'normal' ? 'normal' : `${Math.round(parseFloat(cs.lineHeight))}px`, 'letter-spacing': cs.letterSpacing === 'normal' ? '0' : `${n1(cs.letterSpacing)}px`, case: cs.textTransform });
  for (const tag of ['h1', 'h2', 'h3', 'h4']) for (const el of document.querySelectorAll(tag)) if (vis(el) && !skip(el) && txt(el)) add(tag, el, typeSig(getComputedStyle(el)), { crop: tag === 'h1' || tag === 'h2' });
  for (const el of document.querySelectorAll('p')) if (vis(el) && !skip(el) && !el.closest('footer') && (el.innerText || '').trim().length > 80) add('body text', el, typeSig(getComputedStyle(el)));
  for (const el of document.querySelectorAll('header a[href], nav a[href]')) { if (!vis(el) || skip(el) || el.closest('footer')) continue; const cs = getComputedStyle(el); if (clear(cs.backgroundColor) && border(cs) === 'none' && txt(el)) add('nav link', el, { ...typeSig(cs), colour: hex(cs.color) }, { motion: true }); }
  for (const el of document.querySelectorAll('p a[href], li a[href]')) { if (!vis(el) || skip(el) || el.closest('header, nav, footer')) continue; const cs = getComputedStyle(el); if (clear(cs.backgroundColor)) add('text link', el, { colour: hex(cs.color), underline: cs.textDecorationLine.includes('underline') ? 'yes' : 'no', weight: cs.fontWeight }); }
  for (const el of document.querySelectorAll('a[href], button, [role=button], input[type=submit], input[type=button]')) {
    if (!vis(el) || skip(el)) continue;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    const filled = !clear(cs.backgroundColor), outlined = border(cs) !== 'none' && parseFloat(cs.paddingLeft) >= 8;
    if ((!filled && !outlined) || (el.innerText || el.value || '').trim().length < 2 || r.width < 40 || r.height < 20 || r.height > 90 || r.width > 520) continue;
    const solid = filled && /^#/.test(hex(cs.backgroundColor) || '');
    add(solid ? 'filled button' : outlined ? 'outline button' : 'tinted button', el, { fill: filled ? hex(cs.backgroundColor) : 'none', text: hex(cs.color), border: border(cs), radius: radius(el, cs), font: fam(cs), size: `${n1(cs.fontSize)}px`, weight: cs.fontWeight, height: `${Math.round(r.height)}px`, 'side padding': `${Math.round(parseFloat(cs.paddingLeft))}px`, case: cs.textTransform }, { crop: true, motion: true });
  }
  for (const el of document.querySelectorAll('input, textarea, select')) {
    if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'range'].includes(el.type) || !vis(el) || skip(el)) continue;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    add('form field', el, { height: `${Math.round(r.height)}px`, radius: radius(el, cs), border: border(cs), fill: clear(cs.backgroundColor) ? 'none' : hex(cs.backgroundColor), size: `${n1(cs.fontSize)}px`, 'side padding': `${Math.round(parseFloat(cs.paddingLeft))}px`, text: hex(cs.color) }, { crop: true });
  }
  const cards = [];
  for (const el of document.querySelectorAll('div, li, article, a, section')) {
    if (cards.length >= 60) break;
    const r = el.getBoundingClientRect();
    if (r.width < 160 || r.width > vw * 0.7 || r.height < 100 || r.height > 900 || !vis(el) || skip(el)) continue;
    const cs = getComputedStyle(el), hasShadow = cs.boxShadow && cs.boxShadow !== 'none';
    if (!(parseFloat(cs.borderTopLeftRadius) > 0 || hasShadow || border(cs) !== 'none') || !(!clear(cs.backgroundColor) || hasShadow || border(cs) !== 'none')) continue;
    const cls = typeof el.className === 'string' ? el.className : '';
    const sibs = el.parentElement ? [...el.parentElement.children].filter((s) => s !== el && s.tagName === el.tagName && (typeof s.className === 'string' ? s.className : '') === cls).length : 0;
    if (sibs < 1 || cards.some((c) => c.contains(el))) continue;
    cards.push(el);
    add('card', el, { radius: radius(el, cs), fill: clear(cs.backgroundColor) ? 'none' : hex(cs.backgroundColor), border: border(cs), shadow: hasShadow ? cs.boxShadow.replace(/\s+/g, ' ').slice(0, 70) : 'none', padding: `${Math.round(parseFloat(cs.paddingTop))}px ${Math.round(parseFloat(cs.paddingLeft))}px` }, { crop: true, motion: true });
  }
  for (const el of document.querySelectorAll('svg')) {
    const r = el.getBoundingClientRect();
    if (r.width < 10 || r.width > 64 || r.height > 64 || !vis(el) || skip(el)) continue;
    const shape = el.querySelector('path, circle, rect, line, polyline, polygon');
    if (!shape) continue;
    const cs = getComputedStyle(shape), stroked = cs.stroke && cs.stroke !== 'none' && parseFloat(cs.strokeWidth) > 0, filledIn = cs.fill && cs.fill !== 'none' && !clear(cs.fill);
    add('icon', el, { style: stroked && !filledIn ? 'outline' : stroked ? 'filled with outline' : 'filled', stroke: stroked ? `${n1(cs.strokeWidth)}px` : '-' });
  }
  for (const el of document.querySelectorAll('img')) {
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.height < 80 || !vis(el) || skip(el)) continue;
    const cs = getComputedStyle(el); let rad = radius(el, cs);
    if (rad === '0px' && el.parentElement) { const ps = getComputedStyle(el.parentElement); if (ps.overflow !== 'visible') rad = radius(el.parentElement, ps); }
    add('image', el, { corners: rad });
  }
  // sections: vertical padding, and the width and left edge of the content column
  const blocks = [...document.querySelectorAll('section, main > div, main > section, body > div > section, footer')].filter((el) => { const r = el.getBoundingClientRect(); return r.width >= vw * 0.9 && r.height >= 200 && vis(el) && !skip(el); });
  for (const el of blocks.filter((b) => !blocks.some((o) => o !== b && o.contains(b))).slice(0, 30)) {
    const cs = getComputedStyle(el);
    let c = el.querySelector('h1, h2, h3, p');
    while (c && c.parentElement && c.parentElement !== el && c.parentElement.getBoundingClientRect().width < vw * 0.95) c = c.parentElement;
    const cr = c ? c.getBoundingClientRect() : null;
    add('section', el, { 'content width': cr ? `${Math.round(cr.width / 4) * 4}px` : '?', 'left edge': cr ? `${Math.round(cr.left / 4) * 4}px` : '?' });
  }

  const out = {};
  for (const [role, m] of Object.entries(roles)) out[role] = [...m.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 14).map(([key, e]) => ({ key, ...e }));
  return {
    tokens, roles: out, crops,
    values: { textColors: top(textColors, 40), bgColors: top(bgColors, 40), borderColors: top(borderColors, 30), spacing: top(spacing, 60), radii: top(radii, 20), shadows: top(shadows, 12), sizes: top(sizes, 30) },
  };
}

/** Screenshot the elements `collectDesign` tagged, for the component sheets. */
export async function cropComponents(page, design, dir, rel) {
  fs.mkdirSync(dir, { recursive: true });
  for (const c of design.crops || []) {
    const f = path.join(dir, `${c.id}.png`);
    if (c.top) { await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {}); await page.waitForTimeout(350); }
    try { await page.locator(`[data-kiln-ds="${c.id}"]`).first().screenshot({ path: f, timeout: 2500, animations: 'disabled' }); c.file = rel(f); } catch { /* element moved or hidden: skip */ }
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

// ---------------------------------------------------------------- analysis

const lab = (h) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92));
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), y = f(r * 0.2126 + g * 0.7152 + b * 0.0722), z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};
const dE = (a, b) => { const A = lab(a), B = lab(b); return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]); };
const isHex = (c) => /^#[0-9a-f]{6}$/i.test(c || '');
const ids = (set) => { const a = [...set].sort(); return a.length > 6 ? `${a.slice(0, 5).join(', ')} +${a.length - 5} more` : a.join(', '); };

export function analyseDesign(pages) {
  const got = pages.filter((p) => p.desktop?.evidence?.design);
  if (!got.length) return null;
  const merge = (pick) => { const m = new Map(); for (const p of got) for (const { value, count } of pick(p.desktop.evidence.design.values) || []) { if (value == null) continue; const e = m.get(value) || { value, count: 0, pages: new Set() }; e.count += count; e.pages.add(p.id); m.set(value, e); } return [...m.values()].sort((a, b) => b.count - a.count); };
  const D = { pages: got.length };

  // 1. declared tokens, and how much of what is used comes from them
  const tok = { colors: new Map(), lengths: new Map(), unreadable: 0 };
  for (const p of got) { const t = p.desktop.evidence.design.tokens; tok.unreadable = Math.max(tok.unreadable, t.unreadableSheets || 0); for (const c of t.colors) if (isHex(c.value)) tok.colors.set(c.name, c.value); for (const l of t.lengths) tok.lengths.set(l.name, l.px); }
  const colours = { text: merge((v) => v.textColors), background: merge((v) => v.bgColors), border: merge((v) => v.borderColors) };
  const tokenColours = new Set([...tok.colors.values()].map((c) => c.toLowerCase()));
  const tokenLens = new Set(tok.lengths.values());
  D.tokens = { colourCount: tok.colors.size, lengthCount: tok.lengths.size, unreadableSheets: tok.unreadable, sampleNames: [...tok.colors.keys()].slice(0, 8).concat([...tok.lengths.keys()].slice(0, 6)), usable: tok.colors.size >= 4 };
  if (D.tokens.usable) {
    const off = [], on = { n: 0, total: 0 };
    for (const [kind, list] of Object.entries(colours)) for (const c of list) {
      if (!isHex(c.value)) continue;
      on.total += c.pages.size;
      if (tokenColours.has(c.value.toLowerCase())) { on.n += c.pages.size; continue; }
      const near = [...tok.colors.entries()].map(([name, v]) => ({ name, v, d: dE(c.value, v) })).sort((a, b) => a.d - b.d)[0];
      off.push({ value: c.value, kind, uses: c.count, pages: ids(c.pages), nearest: near.name, nearestValue: near.v, distance: Math.round(near.d * 10) / 10 });
    }
    D.tokens.colourOnTokenPct = on.total ? Math.round(on.n / on.total * 100) : null;
    D.tokens.offTokenColours = off.sort((a, b) => a.distance - b.distance).slice(0, 14);
  }
  // 2. scales inferred from use
  D.nearDuplicateColours = [];
  for (const [kind, list] of Object.entries(colours)) {
    const solid = list.filter((c) => isHex(c.value)).slice(0, 30);
    for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) { const d = dE(solid[i].value, solid[j].value); if (d > 0.4 && d < 6) D.nearDuplicateColours.push({ kind, main: solid[i].value, mainUses: solid[i].count, stray: solid[j].value, strayUses: solid[j].count, strayPages: ids(solid[j].pages), distance: Math.round(d * 10) / 10 }); }
    D[`${kind}ColourCount`] = list.length;
  }
  D.nearDuplicateColours = D.nearDuplicateColours.sort((a, b) => a.distance - b.distance).slice(0, 12);
  const sizes = merge((v) => v.sizes), chars = sizes.reduce((a, s) => a + s.count, 0) || 1;
  D.typeScale = sizes.map((s) => ({ px: s.value, pct: Math.round(s.count / chars * 1000) / 10, pages: s.pages.size })).sort((a, b) => a.px - b.px);
  // Walk sizes from most to least used: a size within 1px of one already accepted is a stray, not a step on the scale.
  const accepted = []; D.offScaleSizes = [];
  for (const s of [...D.typeScale].sort((a, b) => b.pct - a.pct)) {
    const near = accepted.filter((m) => Math.abs(m.px - s.px) <= 1);
    if (near.length) D.offScaleSizes.push({ ...s, near: near.map((m) => m.px), pageIds: ids(sizes.find((x) => x.value === s.px).pages) }); else accepted.push(s);
  }
  const sp = merge((v) => v.spacing), spTotal = sp.reduce((a, s) => a + s.count, 0) || 1;
  const share = (b) => sp.filter((s) => s.value % b === 0).reduce((a, s) => a + s.count, 0) / spTotal;
  const base = share(8) >= 0.75 ? 8 : share(4) >= 0.7 ? 4 : null;
  D.spacing = { distinct: sp.length, base, onBasePct: Math.round(share(base || 4) * 100), common: sp.slice(0, 10).map((s) => s.value), off: sp.filter((s) => s.value % (base || 4) !== 0).slice(0, 10).map((s) => ({ px: s.value, uses: s.count, pages: ids(s.pages) })) };
  const rad = merge((v) => v.radii);
  D.radii = rad.map((r) => ({ value: r.value, uses: r.count, pages: r.pages.size }));
  const rpx = rad.filter((r) => /px$/.test(r.value)).map((r) => ({ ...r, px: parseFloat(r.value) }));
  D.nearDuplicateRadii = []; for (const a of rpx) for (const b of rpx) if (a.px < b.px && b.px - a.px <= 2 && Math.min(a.count, b.count) >= 1) D.nearDuplicateRadii.push(`${a.value} (${a.count} uses) and ${b.value} (${b.count} uses)`);
  D.shadowCount = merge((v) => v.shadows).length;
  if (tokenLens.size >= 4) {
    const pct = (list, f = (x) => x) => { const t = list.reduce((a, s) => a + s.count, 0) || 1; return Math.round(list.filter((s) => tokenLens.has(f(s.value))).reduce((a, s) => a + s.count, 0) / t * 100); };
    D.tokens.lengthOnTokenPct = { fontSizes: pct(sizes), spacing: pct(sp), radii: pct(rpx, (v) => parseFloat(v)) };
  }

  // 3. the same role across pages
  D.roles = {};
  const roleNames = new Set(got.flatMap((p) => Object.keys(p.desktop.evidence.design.roles)));
  for (const role of roleNames) {
    const m = new Map();
    for (const p of got) for (const s of p.desktop.evidence.design.roles[role] || []) { const e = m.get(s.key) || { key: s.key, sig: s.sig, count: 0, pages: new Set(), sample: s.sample, transition: s.transition }; e.count += s.count; e.pages.add(p.id); m.set(s.key, e); }
    const styles = [...m.values()].sort((a, b) => b.pages.size - a.pages.size || b.count - a.count);
    const main = styles[0];
    D.roles[role] = {
      distinct: styles.length, pagesWithRole: got.filter((p) => (p.desktop.evidence.design.roles[role] || []).length).length,
      letters: Object.fromEntries(styles.slice(0, 26).map((s, i) => [s.key, String.fromCharCode(65 + i)])),
      styles: styles.slice(0, 7).map((s, i) => ({ letter: String.fromCharCode(65 + i), key: s.key, sig: s.sig, uses: s.count, pages: ids(s.pages), pageCount: s.pages.size, sample: s.sample, transition: s.transition || null, differs: i === 0 ? null : Object.keys(s.sig).filter((k) => s.sig[k] !== main.sig[k]).map((k) => `${k} ${s.sig[k]} (main: ${main.sig[k]})`) })),
    };
  }
  // 5. behaviour of the same component
  D.hover = got.map((p) => { const h = p.desktop.evidence.interactions?.hover?.details || []; const b = h.filter((x) => x.kind === 'button'); return b.length ? `${p.id}: ${[...new Set(b.map((x) => (x.visible ? (x.changed.join('+') || 'changes') : 'NO change')))].join(' | ')}` : null; }).filter(Boolean);
  const anim = new Map();
  for (const p of got) for (const a of p.desktop.evidence.motion?.animations?.list || []) { if (!a.duration || a.iterations === 'infinite' || a.iterations === Infinity) continue; const k = `${a.duration}ms ${a.easing}`; const e = anim.get(k) || { k, targets: 0, pages: new Set() }; e.targets += a.targets || 1; e.pages.add(p.id); anim.set(k, e); }
  D.animationTimings = [...anim.values()].sort((a, b) => b.targets - a.targets).slice(0, 10).map((e) => `${e.k} ×${e.targets} on ${ids(e.pages)}`);
  D.animationTimingCount = anim.size;
  return D;
}

/** Contact sheets: instances of the same component from every page, side by side at real size. */
export async function componentSheets(composer, pages, design, outDir, runDir) {
  const sheets = [];
  const spec = [[['filled button', 'outline button', 'tinted button'], 'Buttons', 30, 420], [['form field'], 'Form fields', 14, 520], [['card'], 'Cards', 10, 340], [['h1'], 'Page headlines (h1)', 10, 1100], [['h2'], 'Section headings (h2)', 14, 1100]];
  for (const [roleList, title, cap, maxW] of spec) {
    const role = roleList[0].replace(/^filled /, '');
    const letters = new Map(roleList.flatMap((r) => Object.entries(design.roles[r]?.letters || {}).map(([k, l]) => [`${r}|${k}`, roleList.length > 1 ? `${r.split(' ')[0]} ${l}` : l])));
    const all = pages.flatMap((p) => (p.desktop?.evidence?.design?.crops || []).filter((c) => roleList.includes(c.role) && c.file).map((c) => ({ ...c, key: `${c.role}|${c.key}`, page: p.id })));
    if (all.length < 2) continue;
    // spread across styles first, then pages, so every variant is shown
    const byKey = new Map(); for (const c of all) byKey.set(c.key, [...(byKey.get(c.key) || []), c]);
    const picked = []; for (let round = 0; picked.length < cap && round < 4; round++) for (const list of byKey.values()) { const seen = new Set(picked.filter((x) => x.key === list[0].key).map((x) => x.page)); const next = list.find((c) => !picked.includes(c) && !seen.has(c.page)) || (round > 1 ? list.find((c) => !picked.includes(c)) : null); if (next && picked.length < cap) picked.push(next); }
    picked.sort((a, b) => (letters.get(a.key) || 'Z').localeCompare(letters.get(b.key) || 'Z') || a.page.localeCompare(b.page));
    const html = `<div style="width:1600px;padding:14px;background:#f2f2f2"><div style="font-size:16px;font-weight:700;padding-bottom:10px">${esc(title)} from every page, at real size. The letter is the style in the site digest's "Same role across pages" list; same letter = identical measured style.</div><div style="display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end">` +
      picked.map((c) => `<div style="background:#fff;padding:10px;border:1px solid #ccc"><img src="${pathToFileURL(path.join(runDir, c.file)).href}" style="max-width:${maxW}px;height:auto"><div style="padding-top:6px;font-size:12px;color:#333"><b>${esc(letters.get(c.key) || '?')}</b> · ${esc(c.page)}${c.text ? ` · "${esc(c.text.slice(0, 28))}"` : ''}</div></div>`).join('') + '</div></div>';
    const out = path.join(outDir, `components-${role.replace(/\s+/g, '-')}.jpg`);
    try { await composer.render(html, out, { width: 1600, quality: 82, background: '#f2f2f2' }); sheets.push({ file: path.relative(runDir, out), what: `${title} collected from every page, side by side at real size, labelled with their style letter` }); } catch { /* sheet is optional */ }
  }
  return sheets;
}

/** Site-digest section. Facts only. */
export function designLines(D) {
  if (!D) return [];
  const L = ['', '## Design system check (desktop, measured across all probed pages)', ''];
  const t = D.tokens;
  L.push('### Declared tokens');
  if (!t.usable) L.push(`- The site declares ${t.colourCount} colour and ${t.lengthCount} size variables on its root${t.unreadableSheets ? ` (${t.unreadableSheets} stylesheet(s) could not be read, so some may be missing)` : ''}: too few to check use against. The scales below are inferred from what is actually used.`);
  else {
    L.push(`- ${t.colourCount} colour and ${t.lengthCount} size variables declared, e.g. ${t.sampleNames.map((n) => `\`${n}\``).join(', ')}${t.unreadableSheets ? `; ${t.unreadableSheets} stylesheet(s) could not be read` : ''}.`);
    L.push(`- ${t.colourOnTokenPct}% of colour uses match a declared colour exactly.${t.lengthOnTokenPct ? ` Sizes matching a declared value: font sizes ${t.lengthOnTokenPct.fontSizes}%, spacing ${t.lengthOnTokenPct.spacing}%, corner radii ${t.lengthOnTokenPct.radii}%.` : ''}`);
    for (const o of t.offTokenColours.filter((x) => x.distance < 8).slice(0, 8)) L.push(`  - OFF-TOKEN ${o.kind} colour ${o.value} (${o.uses} uses on ${o.pages}) is close to but not \`${o.nearest}\` ${o.nearestValue} (difference ${o.distance}; under 2 is invisible, 2–6 is a visible near-miss)`);
    const far = t.offTokenColours.filter((x) => x.distance >= 8).length; if (far) L.push(`  - ${far} more colours in use are not close to any declared colour.`);
  }
  L.push('', '### Scales inferred from use');
  L.push(`- Colours in use: ${D.textColourCount} text, ${D.backgroundColourCount} background, ${D.borderColourCount} border.`);
  for (const n of D.nearDuplicateColours.slice(0, 8)) L.push(`  - NEAR-DUPLICATE ${n.kind} colours: ${n.main} (${n.mainUses} uses) and ${n.stray} (${n.strayUses} uses, on ${n.strayPages}); difference ${n.distance}`);
  L.push(`- Type scale (${D.typeScale.length} sizes; share of all text): ${D.typeScale.map((s) => `${s.px}px ${s.pct}%`).join(' · ')}`);
  for (const s of D.offScaleSizes.slice(0, 8)) L.push(`  - OFF-SCALE ${s.px}px (${s.pct}% of text, on ${s.pageIds}) sits beside the established ${s.near.join('/')}px`);
  const s = D.spacing;
  L.push(`- Spacing: ${s.distinct} distinct padding/margin/gap values; ${s.base ? `${s.onBasePct}% are multiples of ${s.base}px, so the system is built on ${s.base}px` : `only ${s.onBasePct}% are multiples of 4px: NO consistent base unit`}. Most used: ${s.common.join(', ')}px.`);
  if (s.off.length) L.push(`  - Off the ${s.base || 4}px grid: ${s.off.map((o) => `${o.px}px ×${o.uses}`).join(', ')}`);
  L.push(`- Corner radii (${D.radii.length}): ${D.radii.slice(0, 10).map((r) => `${r.value} ×${r.uses}`).join(', ')}${D.nearDuplicateRadii.length ? `. NEAR-DUPLICATES: ${D.nearDuplicateRadii.slice(0, 5).join('; ')}` : ''}`);
  L.push(`- Distinct shadows: ${D.shadowCount}`);

  L.push('', '### Same role across pages', 'Each role lists every measured style, most widespread first. A = the main style. Later letters show only what differs from A. One style = consistent.');
  const order = ['h1', 'h2', 'h3', 'h4', 'body text', 'nav link', 'text link', 'filled button', 'outline button', 'tinted button', 'form field', 'card', 'icon', 'image', 'section'];
  for (const role of order.filter((r) => D.roles[r])) {
    const r = D.roles[role], a = r.styles[0];
    if (role === 'section') L.push('  (section = width and left edge of each section\'s content column; a deliberately narrower centred column is not drift)');
    L.push(`- **${role}** — ${r.distinct === 1 ? 'consistent: 1 style' : `${r.distinct} styles`} across ${r.pagesWithRole} page(s)`);
    L.push(`  - A ×${a.uses} on ${a.pages}: ${a.key}${a.transition ? ` · transition ${a.transition}` : ''}`);
    for (const x of r.styles.slice(1)) L.push(`  - ${x.letter} ×${x.uses} on ${x.pages}${x.sample ? ` (e.g. "${x.sample}")` : ''}: ${x.differs.join('; ') || 'same values, different order'}${x.transition && x.transition !== a.transition ? ` · transition ${x.transition} (main: ${a.transition})` : ''}`);
    if (r.distinct > r.styles.length) L.push(`  - …and ${r.distinct - r.styles.length} more styles`);
  }
  L.push('', '### Behaviour of the same component');
  if (D.hover.length) L.push(`- What changes when a button is hovered, per page: ${D.hover.join(' · ')}`);
  if (D.animationTimings.length) L.push(`- Animation timings in use (${D.animationTimingCount} distinct duration/easing pairs): ${D.animationTimings.join(' · ')}`);
  return L;
}
