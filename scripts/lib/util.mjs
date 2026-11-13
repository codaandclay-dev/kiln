import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KILN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function log(...a) {
  const t = new Date().toISOString().slice(11, 19);
  console.error(`[kiln ${t}]`, ...a);
}

/** Minimal flag parser: --flag, --key value, --key=value, positionals in `_`. */
export function parseArgs(argv, booleans = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > -1) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    if (booleans.includes(key) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

export async function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}

/** Run `fn`, swallow and record any error. Capture must never die on one bad page feature. */
export async function attempt(label, fn, errors, ms = 20000) {
  try { return await withTimeout(fn(), ms, label); }
  catch (e) { errors?.push(`${label}: ${String(e.message || e).split('\n')[0].slice(0, 200)}`); return undefined; }
}

const TRACKING = /^(utm_|fbclid$|gclid$|msclkid$|mc_|ref$|_ga$|_gl$|hsa_|igshid$)/i;
const SKIP_EXT = /\.(pdf|zip|png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mov|mp3|wav|css|js|json|xml|rss|atom|txt|csv|docx?|xlsx?|pptx?|dmg|exe|woff2?|ttf)$/i;

/** Canonical form of a same-origin page URL, or null if it is not a crawlable page. */
export function normalizeUrl(href, base, origin) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (stripWww(u.host) !== stripWww(new URL(origin).host)) return null;
  if (SKIP_EXT.test(u.pathname)) return null;
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  u.pathname = u.pathname.replace(/\/index\.html?$/i, '') || '/';
  return u.toString();
}

export const stripWww = (h) => h.replace(/^www\./i, '').toLowerCase();

export function slugFor(url) {
  const u = new URL(url);
  const s = (u.pathname + (u.search ? '-' + u.search.slice(1) : ''))
    .replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 60);
  return s || 'home';
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (fallback !== undefined) return fallback; throw new Error(`Cannot read ${file}: ${e.message}`); }
}

export const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2 * 100) / 100;
};

export const round = (n, d = 0) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

/** Simple promise pool. */
export async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
