// Dedicated measurement passes, run alone (nothing else loading) so the numbers
// are trustworthy: three cold desktop loads, one throttled phone load, and
// WebKit/Firefox renders for cross-browser comparison.
import path from 'node:path';
import { initScript, frameStats } from './evidence.mjs';
import { VIEWPORTS, contextOptions, settle, watchPage } from './page-capture.mjs';
import { median, attempt, log } from './util.mjs';

const vitals = () => {
  const K = window.__kiln || {};
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const fcp = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
  const res = performance.getEntriesByType('resource');
  return {
    ttfb: Math.round(nav.responseStart || 0), fcp: fcp ? Math.round(fcp.startTime) : null, lcp: K.lcp ? K.lcp.t : null,
    cls: +(K.cls || 0).toFixed(3), tbt: Math.round((K.longTasks || []).reduce((a, [, d]) => a + Math.max(0, d - 50), 0)),
    load: Math.round(nav.loadEventEnd || 0) || null,
    transferKb: Math.round(((nav.transferSize || 0) + res.reduce((a, r) => a + (r.transferSize || 0), 0)) / 1024), requests: res.length + 1,
  };
};

async function scriptedScroll(page) {
  const since = await page.evaluate(() => performance.now());
  for (let i = 1; i <= 4; i++) {
    await page.evaluate((k) => window.scrollTo({ top: innerHeight * 0.8 * k, behavior: 'smooth' }), i);
    await page.waitForTimeout(450);
  }
  return page.evaluate(frameStats, since);
}

export async function desktopRuns(browser, url, runs = 3) {
  const out = [];
  for (let i = 0; i < runs; i++) {
    const ctx = await browser.newContext(contextOptions(VIEWPORTS.desktop));
    await ctx.addInitScript(initScript);
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: 35000 });
      await settle(page, { idleMs: 5000, extra: 800 });
      const loadFrames = await page.evaluate(frameStats, 0);
      const scroll = await scriptedScroll(page);
      out.push({ ...(await page.evaluate(vitals)), loadMaxGap: loadFrames?.maxGapMs ?? null, scrollMaxGap: scroll?.maxGapMs ?? null, scrollGapsOver50: scroll?.gapsOver50ms ?? null, scrollFps: scroll?.avgFps ?? null });
    } catch (e) { out.push({ error: String(e.message).split('\n')[0] }); }
    finally { await ctx.close().catch(() => {}); }
  }
  const ok = out.filter((r) => !r.error);
  const m = (k) => median(ok.map((r) => r[k]));
  const jankRuns = ok.filter((r) => (r.scrollMaxGap ?? 0) > 100 || (r.scrollGapsOver50 ?? 0) >= 3).length;
  return {
    runs: ok.length, failedRuns: out.length - ok.length,
    median: { ttfb: m('ttfb'), fcp: m('fcp'), lcp: m('lcp'), cls: m('cls'), tbt: m('tbt'), load: m('load'), transferKb: m('transferKb'), requests: m('requests'), scrollFps: m('scrollFps'), scrollMaxGapMs: m('scrollMaxGap') },
    spread: { lcp: ok.map((r) => r.lcp), scrollMaxGapMs: ok.map((r) => r.scrollMaxGap) },
    scrollJank: { runsWithJank: jankRuns, reproducible: ok.length >= 2 && jankRuns >= 2, rule: 'a frame gap over 100 ms, or three or more over 50 ms, while scrolling; reproducible = seen in at least 2 runs' },
  };
}

/** One load as a mid-range phone on a slow connection would experience it. */
export async function throttledMobile(browser, url, shotPath) {
  const ctx = await browser.newContext(contextOptions(VIEWPORTS.mobile));
  await ctx.addInitScript(initScript);
  const page = await ctx.newPage();
  try {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForTimeout(Math.max(0, 3000 - (Date.now() - t0)));
    await page.screenshot({ path: shotPath, type: 'jpeg', quality: 72 }).catch(() => {});
    await page.waitForLoadState('load', { timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(1500);
    return { profile: '4x CPU slowdown, 1.6 Mbps down, 150 ms latency', ...(await page.evaluate(vitals)), at3sShot: true };
  } catch (e) { return { error: String(e.message).split('\n')[0] }; }
  finally { await ctx.close().catch(() => {}); }
}

/** Above-the-fold render in another engine, plus its console errors and overflow. */
export async function otherEngine(engine, name, url, shotPath, origin) {
  let browser;
  try {
    browser = await engine.launch({ headless: true });
    const ctx = await browser.newContext(contextOptions(VIEWPORTS.desktop));
    const page = await ctx.newPage();
    const watch = watchPage(page, origin);
    await page.goto(url, { waitUntil: 'load', timeout: 40000 });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await page.screenshot({ path: shotPath, type: 'jpeg', quality: 78 });
    const facts = await page.evaluate(() => ({ overflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth), pageHeight: document.documentElement.scrollHeight, fonts: [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, '')))].slice(0, 8) }));
    return { engine: name, ok: true, ...facts, consoleErrors: [...new Set(watch.console)].slice(0, 6), pageErrors: [...new Set(watch.pageErrors)].slice(0, 6) };
  } catch (e) { return { engine: name, ok: false, error: String(e.message).split('\n')[0].slice(0, 200) }; }
  finally { await browser?.close().catch(() => {}); }
}

export async function keyPagePasses(chromium, engines, page, opts, composer, errors) {
  const out = {};
  out.desktop = await attempt('perf runs', () => desktopRuns(chromium, page.url, 3), errors, 180000);
  const shot3s = path.join(page.dir, 'throttled-3s.jpg');
  out.throttledMobile = await attempt('throttled mobile', () => throttledMobile(chromium, page.url, shot3s), errors, 120000);
  if (out.throttledMobile && !out.throttledMobile.error) out.throttledMobile.shot = path.relative(opts.out, shot3s);

  const shots = [{ file: path.join(page.dir, `above-fold-desktop.jpg`), label: 'Chrome' }];
  out.engines = [];
  for (const [name, engine] of Object.entries(engines)) {
    const f = path.join(page.dir, `xbrowser-${name}.jpg`);
    const r = await attempt(`${name} render`, () => otherEngine(engine, name, page.url, f, opts.origin), errors, 70000);
    if (r) { out.engines.push(r); if (r.ok) shots.push({ file: f, label: name === 'webkit' ? 'Safari engine (WebKit)' : 'Firefox' }); }
  }
  if (shots.length > 1) {
    const sheet = path.join(page.dir, 'sheets', 'xbrowser.jpg');
    const made = await attempt('xbrowser sheet', () => composer.sheet(shots, sheet, { direction: 'row', width: 1600 }), errors, 30000);
    if (made) out.sheet = path.relative(opts.out, sheet);
  }
  log(`  perf    ${page.slug} — LCP ${out.desktop?.median?.lcp ?? '?'} ms desktop, ${out.throttledMobile?.lcp ?? '?'} ms throttled phone`);
  return out;
}

/** HEAD/GET every distinct link once. Bot-blocking statuses are reported separately, not as broken. */
export async function checkLinks(links, { limit = 350 } = {}) {
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  const list = links.slice(0, limit);
  const results = [];
  let i = 0;
  const one = async (l) => {
    const go = async (method) => {
      const res = await fetch(l.href, { method, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*' }, signal: AbortSignal.timeout(10000) });
      res.body?.cancel?.().catch(() => {});
      return res.status;
    };
    try {
      let status = await go('HEAD');
      if (status >= 400) status = await go('GET');
      return { ...l, status };
    } catch (e) { return { ...l, status: 0, error: String(e.cause?.code || e.name || e.message).slice(0, 60) }; }
  };
  await Promise.all(Array.from({ length: 8 }, async () => { while (i < list.length) { const l = list[i++]; results.push(await one(l)); } }));
  const SOCIAL = /(^|\.)(facebook|instagram|linkedin|twitter|x|tiktok|threads|pinterest|youtube|g2|trustpilot|glassdoor|crunchbase)\.(com|net)$/;
  const host = (h) => { try { return new URL(h).host; } catch { return ''; } };
  const blocked = (r) => !r.internal && ([401, 403, 405, 406, 429, 999].includes(r.status) || (r.status >= 400 && SOCIAL.test(host(r.href))));
  return {
    checked: results.length, notChecked: Math.max(0, links.length - list.length),
    broken: results.filter((r) => (r.status >= 400 || r.status === 0) && !blocked(r)).map(({ href, status, error, foundOn, text, internal }) => ({ href, status, error, foundOn, text, internal })),
    blockedByBotProtection: results.filter(blocked).length,
  };
}
