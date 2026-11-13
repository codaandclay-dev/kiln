#!/usr/bin/env node
// kiln capture: crawl a marketing site and collect everything the reviewers need.
//   node scripts/capture.mjs <url> --out <dir> [--max-pages 25] [--quick] [--submit-forms] [--headless] [--concurrency 2] [--key-pages 5]
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit, firefox } from 'playwright';
import { parseArgs, log, slugFor, writeJson, pool, attempt } from './lib/util.mjs';
import { Composer } from './lib/compose.mjs';
import { discover } from './lib/discover.mjs';
import { capturePage, VIEWPORTS, contextOptions } from './lib/page-capture.mjs';
import { keyPagePasses, checkLinks } from './lib/perf.mjs';
import { pageDigest, siteDigest } from './lib/digest.mjs';
import { analyseDesign, componentSheets } from './lib/tokens.mjs';

const args = parseArgs(process.argv.slice(2), ['quick', 'submit-forms', 'headless']);
let startUrl = args._[0];
if (!startUrl || !args.out) { console.error('usage: capture.mjs <url> --out <dir> [--max-pages N] [--urls a,b,c] [--quick] [--submit-forms] [--headless]'); process.exit(2); }
if (!/^https?:\/\//i.test(startUrl)) startUrl = 'https://' + startUrl;
const opts = {
  out: path.resolve(args.out), maxPages: Math.max(1, +(args['max-pages'] || 25)), quick: !!args.quick, submitForms: !!args['submit-forms'],
  headless: !!args.headless, concurrency: Math.max(1, +(args.concurrency || 3)), keyPages: Math.max(0, +(args['key-pages'] ?? 5)),
};
fs.mkdirSync(opts.out, { recursive: true });
const startedAt = new Date().toISOString();
const warnings = [];

async function launchMain() {
  const common = { headless: opts.headless, args: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--window-position=40,40', '--hide-scrollbars'] };
  if (!opts.headless) {
    try { return { browser: await chromium.launch({ ...common, channel: 'chrome' }), name: 'Google Chrome (visible window)' }; }
    catch { warnings.push('Google Chrome was not found, so the bundled Chromium build was used instead.'); }
  }
  return { browser: await chromium.launch(common), name: opts.headless ? 'Chromium (headless)' : 'Chromium (visible window)' };
}

const helper = await chromium.launch({ headless: true }); // image composition + discovery
const composer = new Composer(helper);
await composer.init(path.join(opts.out, '.compose'));
const main = await launchMain();
log(`capturing with ${main.name}; mode: ${opts.quick ? 'quick' : 'full'}`);

let exitCode = 0;
try {
  // ---------- discover ----------
  const disc = await discover(helper, startUrl, { maxPages: args.urls ? 1 : opts.maxPages });
  if (args.urls) { // probe exactly these pages instead of crawling
    const list = String(args.urls).split(',').map((u) => u.trim()).filter(Boolean).map((u) => new URL(u, disc.origin + '/').href);
    disc.pages = list.map((url) => ({ url, depth: 0, title: '' })); disc.skipped = [];
  }
  opts.origin = disc.origin;
  const used = new Set();
  const pages = disc.pages.map((p, i) => {
    let slug = slugFor(p.url); while (used.has(slug)) slug += '-x'; used.add(slug);
    return { id: `p${String(i + 1).padStart(2, '0')}`, url: p.url, slug, depth: p.depth, title: p.title, dir: path.join(opts.out, 'pages', slug), key: !opts.quick && i < opts.keyPages };
  });

  // ---------- capture ----------
  let done = 0;
  await pool(pages, opts.concurrency, async (p) => {
    fs.mkdirSync(p.dir, { recursive: true });
    p.desktop = await capturePage(main.browser, p, VIEWPORTS.desktop, opts, composer).catch((e) => ({ viewport: 'desktop', failed: true, errors: [String(e.message).split('\n')[0]], images: { sheets: [], sections: [], states: [], motion: {} } }));
    p.mobile = await capturePage(main.browser, p, VIEWPORTS.mobile, opts, composer).catch((e) => ({ viewport: 'mobile', failed: true, errors: [String(e.message).split('\n')[0]], images: { sheets: [], sections: [], states: [], motion: {} } }));
    p.title = p.desktop.evidence?.meta?.title || p.title || p.url;
    log(`page ${++done}/${pages.length} done: ${p.url}`);
  });

  // ---------- key pages: clean performance + other engines ----------
  if (!opts.quick) {
    const engines = { webkit, firefox };
    for (const p of pages.filter((x) => x.key && !x.desktop.failed)) {
      p.perfErrors = [];
      p.perf = await keyPagePasses(main.browser, engines, p, opts, composer, p.perfErrors);
    }
  }
  await main.browser.close().catch(() => {});

  // ---------- site-wide ----------
  const site = { sitemapFound: disc.sitemapFound };
  site.notFound = await attempt('404 probe', async () => {
    const ctx = await helper.newContext(contextOptions(VIEWPORTS.desktop));
    const page = await ctx.newPage();
    const url = `${disc.origin}/kiln-missing-page-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const res = await page.goto(url, { waitUntil: 'load', timeout: 25000 });
      await page.waitForTimeout(1200);
      const shot = path.join(opts.out, 'site', 'not-found.jpg');
      fs.mkdirSync(path.dirname(shot), { recursive: true });
      await page.screenshot({ path: shot, type: 'jpeg', quality: 76 });
      const facts = await page.evaluate((home) => ({ text: (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300), hasHomeLink: [...document.querySelectorAll('a[href]')].some((a) => a.href.replace(/\/$/, '') === home.replace(/\/$/, '')) }), disc.home);
      return { url, status: res?.status() ?? null, shot: path.relative(opts.out, shot), ...facts };
    } finally { await ctx.close().catch(() => {}); }
  }, warnings, 40000) || null;

  const linkMap = new Map();
  for (const p of pages) for (const l of p.desktop.evidence?.links?.list || []) if (!linkMap.has(l.href)) linkMap.set(l.href, { ...l, foundOn: p.url });
  const all = [...linkMap.values()].sort((a, b) => Number(b.internal) - Number(a.internal));
  log(`checking ${Math.min(all.length, 350)} links`);
  site.links = await checkLinks(all);
  for (const p of pages) { const mine = new Set((p.desktop.evidence?.links?.list || []).map((l) => l.href)); p.brokenLinks = site.links.broken.filter((b) => mine.has(b.href)); }

  const firstEv = (k) => pages.map((p) => p.desktop.evidence?.links?.[k]).find(Boolean) || null;
  site.legal = { privacy: firstEv('privacy'), terms: firstEv('terms') };
  site.tech = [...new Set(pages.flatMap((p) => p.desktop.evidence?.tech || []))];
  site.consistency = pages.filter((p) => p.desktop.evidence).map((p) => {
    const e = p.desktop.evidence;
    return {
      id: p.id, path: new URL(p.url).pathname, families: (e.typography?.families || []).slice(0, 3).map((f) => f.value).join(' / '), sizes: e.typography?.sizeCount ?? '?', colors: e.typography?.textColorCount ?? '?',
      buttonStyles: e.cta?.distinctStyles ?? '?', radii: (e.cta?.distinctRadii || []).slice(0, 4).join(' ') || '-', titleLength: e.meta?.titleLength ?? 0, description: e.meta?.description ? `${e.meta.description.length} chars` : 'MISSING',
    };
  });
  site.headerCtas = pages.map((p) => `${p.id}: ${p.desktop.evidence?.fold?.headerCta ? `"${p.desktop.evidence.fold.headerCta}"` : 'none'}`).join(' · ');
  const titles = new Map();
  for (const p of pages) { const t = p.desktop.evidence?.meta?.title; if (t) titles.set(t, [...(titles.get(t) || []), p.id]); }
  site.duplicateTitles = [...titles.entries()].filter(([, ids]) => ids.length > 1).map(([t, ids]) => `"${t.slice(0, 60)}" on ${ids.join(', ')}`);
  site.missingDescriptions = pages.filter((p) => p.desktop.evidence && !p.desktop.evidence.meta?.description).map((p) => p.id);

  // ---------- design system: tokens, scales, roles, component sheets ----------
  site.design = await attempt('design system analysis', async () => analyseDesign(pages), warnings, 30000) || null;
  site.componentSheets = site.design ? await attempt('component sheets', () => componentSheets(composer, pages, site.design, path.join(opts.out, 'site'), opts.out), warnings, 60000) || [] : [];

  // ---------- write per-page files ----------
  const manPages = [];
  for (const p of pages) {
    const relDir = path.relative(opts.out, p.dir);
    const D = p.desktop.images, M = p.mobile.images;
    const audit = [];
    D.sheets.forEach((s) => audit.push({ file: s.file, what: `desktop 1440px, page y ${s.yFrom}–${s.yTo}px (two screens stacked, red bar between)` }));
    M.sheets.forEach((s) => audit.push({ file: s.file, what: `mobile 390px, page y ${s.yFrom}–${s.yTo}px (consecutive screens left to right)` }));
    (D.stateSheets || []).forEach((f) => audit.push({ file: f, what: 'desktop interaction states (hover, focus, dropdowns, forms)' }));
    (M.stateSheets || []).forEach((f) => audit.push({ file: f, what: 'mobile interaction states (menu, accordions, forms)' }));
    if (D.motion.load) audit.push({ file: D.motion.load, what: 'desktop page-load frames in time order: how the page appears' });
    if (D.motion.scroll) audit.push({ file: D.motion.scroll, what: 'desktop frames while scrolling: scroll-triggered motion' });
    if (D.motion.curves) audit.push({ file: D.motion.curves, what: 'measured motion curves for animated elements' });
    if (D.motion.element) audit.push({ file: D.motion.element, what: 'frame-by-frame crop of the largest animated element' });
    if (M.motion.load) audit.push({ file: M.motion.load, what: 'mobile page-load frames in time order' });
    if (p.perf?.sheet) audit.push({ file: p.perf.sheet, what: 'same first screen in Chrome, Safari engine and Firefox' });
    if (p.perf?.throttledMobile?.shot) audit.push({ file: p.perf.throttledMobile.shot, what: 'what a slow phone shows 3 seconds after tapping the link' });
    if (p === pages[0]) for (const s of site.componentSheets) audit.push({ file: s.file, what: `SITE-WIDE: ${s.what}` });
    p.images = { audit, sections: D.sections };
    p.files = { evidence: `${relDir}/evidence.json`, digest: `${relDir}/digest.md`, text: `${relDir}/text.txt` };

    const text = p.desktop.evidence?.copy?.text || '';
    if (p.desktop.evidence?.copy) delete p.desktop.evidence.copy.text;
    if (p.mobile.evidence?.copy) delete p.mobile.evidence.copy.text;
    fs.writeFileSync(path.join(opts.out, p.files.text), text);
    writeJson(path.join(opts.out, p.files.evidence), { url: p.url, desktop: p.desktop.evidence || null, mobile: p.mobile.evidence || null, perf: p.perf || null, brokenLinks: p.brokenLinks });
    fs.writeFileSync(path.join(opts.out, p.files.digest), pageDigest(p));

    const d = p.desktop.evidence || {};
    manPages.push({
      id: p.id, url: p.url, slug: p.slug, title: p.title, key: p.key, failed: !!p.desktop.failed, status: p.desktop.status ?? null, dir: relDir, files: p.files,
      images: {
        audit, aboveFold: { desktop: D.aboveFold || null, mobile: M.aboveFold || null }, thumb: { desktop: D.thumb || null, mobile: M.thumb || null }, full: { desktop: D.full || null, mobile: M.full || null },
        sections: D.sections, states: [...D.states, ...M.states], video: D.video || null,
      },
      facts: {
        lcp: p.perf?.desktop?.median?.lcp ?? d.perf?.lcp ?? null, lcpThrottled: p.perf?.throttledMobile?.lcp ?? null, cls: p.perf?.desktop?.median?.cls ?? d.perf?.cls ?? null,
        transferKb: p.perf?.desktop?.median?.transferKb ?? d.perf?.transferKb ?? null, requests: d.perf?.requests ?? null,
        a11yViolations: d.axe ? d.axe.length : null, consoleErrors: (d.runtime?.consoleErrors?.length || 0) + (d.runtime?.pageErrors?.length || 0), brokenLinks: p.brokenLinks.length,
        mobileOverflowPx: p.mobile.evidence?.layout?.horizontalOverflowPx ?? null, sections: (d.sections || []).map((s) => s.kind),
      },
      warnings: [...(p.desktop.errors || []).map((e) => `desktop: ${e}`), ...(p.mobile.errors || []).map((e) => `mobile: ${e}`), ...(p.perfErrors || [])],
    });
  }

  // ---------- batches for the reviewers ----------
  const batches = []; let cur = [], budget = 0;
  for (const p of manPages.filter((x) => !x.failed)) {
    const n = p.images.audit.length;
    if (cur.length && (budget + n > 24 || cur.length >= 3)) { batches.push(cur); cur = []; budget = 0; }
    cur.push(p.id); budget += n;
  }
  if (cur.length) batches.push(cur);

  if (opts.quick) warnings.push('Quick mode: no motion capture, interaction states, video, cross-browser renders or repeat performance runs.');
  else if (manPages.some((p) => !p.key)) warnings.push(`Clean three-run performance figures, the slow-phone load and the Safari/Firefox renders were taken for the first ${opts.keyPages} pages only; other pages have a single indicative measurement.`);
  if (disc.skipped.length) warnings.push(`${disc.skipped.length} discovered pages were not probed (page cap of ${opts.maxPages}, or more than 3 pages of the same template).`);
  if (!opts.submitForms) warnings.push('Forms were filled but never submitted, so success and server-side error states were not seen.');
  warnings.push('Pages behind a login, payment or CAPTCHA are not covered.');
  const failed = manPages.filter((p) => p.failed);
  if (failed.length) warnings.push(`${failed.length} page(s) failed to load: ${failed.map((p) => p.url).join(', ')}`);

  const manifest = {
    kiln: 1, url: startUrl, origin: disc.origin, home: disc.home, startedAt, finishedAt: new Date().toISOString(), mode: opts.quick ? 'quick' : 'full', browser: main.name,
    options: { maxPages: opts.maxPages, submitForms: opts.submitForms, keyPages: opts.keyPages }, discovery: { skipped: disc.skipped, sitemapFound: disc.sitemapFound },
    site, pages: manPages, batches, warnings, files: { siteDigest: 'site-digest.md' },
  };
  writeJson(path.join(opts.out, 'manifest.json'), manifest);
  fs.writeFileSync(path.join(opts.out, 'site-digest.md'), siteDigest(manifest));

  console.log(JSON.stringify({
    ok: true, run: opts.out, pages: manPages.length, failedPages: failed.length, batches: batches.length, images: manPages.reduce((a, p) => a + p.images.audit.length, 0),
    brokenLinks: site.links.broken.length, minutes: +((Date.now() - Date.parse(startedAt)) / 60000).toFixed(1), warnings,
  }, null, 2));
} catch (e) {
  exitCode = 1;
  console.error(`kiln capture failed: ${e.stack || e}`);
  console.log(JSON.stringify({ ok: false, error: String(e.message || e) }));
} finally {
  await composer.close();
  await main.browser.close().catch(() => {});
  await helper.close().catch(() => {});
  fs.rmSync(path.join(opts.out, '.compose'), { recursive: true, force: true });
}
process.exit(exitCode);
