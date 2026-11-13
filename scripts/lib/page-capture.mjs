// Capture one page at one viewport: screenshots, sheets, evidence, motion, interactions.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { attempt, log, round, withTimeout } from './util.mjs';
import { probeFormBehaviour, popupFormRoot } from './forms.mjs';
import { collectDesign, cropComponents } from './tokens.mjs';
import { initScript, collectEvidence, collectAnimations, collectOverlays, dismissCookieBanner, findBlocker, frameStats, getTracks } from './evidence.mjs';
import { Screencast, frameSheet, analyseTracks, curvesSheet, elementStrip, summariseAnimations } from './motion.mjs';
import { probeInteractions } from './interact.mjs';

const require = createRequire(import.meta.url);
let axeSource = null;
const getAxe = () => (axeSource ??= fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'));

export const VIEWPORTS = {
  desktop: { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false, perSheet: 2, direction: 'column', maxSegments: 14 },
  mobile: {
    name: 'mobile', width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true, perSheet: 3, direction: 'row', maxSegments: 18,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  },
};

export function contextOptions(vp, extra = {}) {
  return {
    viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.deviceScaleFactor, isMobile: vp.isMobile, hasTouch: vp.hasTouch,
    ...(vp.userAgent ? { userAgent: vp.userAgent } : {}), locale: 'en-US', ...extra,
  };
}

/** Network and console listeners shared by every kind of page load. */
export function watchPage(page, origin) {
  const w = { console: [], pageErrors: [], failed: [], badResponses: [] };
  page.on('console', (m) => { if (m.type() === 'error' && w.console.length < 25) w.console.push(m.text().slice(0, 240)); });
  page.on('pageerror', (e) => { if (w.pageErrors.length < 15) w.pageErrors.push(String(e.message || e).slice(0, 240)); });
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText || '';
    if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(why)) return; // navigations and cancelled beacons
    if (w.failed.length < 25) w.failed.push({ url: r.url().slice(0, 200), type: r.resourceType(), error: why });
  });
  page.on('response', (r) => {
    if (r.status() >= 400 && w.badResponses.length < 25) w.badResponses.push({ url: r.url().slice(0, 200), status: r.status(), type: r.request().resourceType(), firstParty: r.url().startsWith(origin) });
  });
  return w;
}

export async function settle(page, { idleMs = 6000, extra = 1200 } = {}) {
  await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: idleMs }).catch(() => {});
  await page.waitForTimeout(extra);
}

/** Smooth-scroll the whole page so lazy content loads and scroll reveals fire. */
export async function scrollThrough(page, vp, onStep) {
  let y = 0;
  for (let i = 0; i < 45; i++) {
    const h = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
    if (y >= h - vp.height - 2) break;
    y = Math.min(y + Math.round(vp.height * 0.75), h - vp.height);
    await page.evaluate((top) => window.scrollTo({ top, behavior: 'smooth' }), y);
    await page.waitForTimeout(480);
    if (onStep) await onStep(i);
  }
  await page.waitForTimeout(350);
}

const CLOSERS = ['[aria-label*="close" i]', '[aria-label*="dismiss" i]', '[title*="close" i]', 'button[class*="close" i]', '[class*="close" i][role=button]', '[data-dismiss]', '[class*="close-button" i]', '[class*="closeButton" i]', '[id*="close" i]'];

/**
 * If a popup is covering the screen: screenshot it, record it, then close it so
 * the rest of the capture shows the page underneath. Returns the record or null.
 */
export async function handlePopup(page, when, shotPath, probeForm = false) {
  const b = await page.evaluate(findBlocker).catch(() => null);
  if (!b) return null;
  await page.screenshot({ path: shotPath, type: 'jpeg', quality: 76 }).catch(() => {});
  // A popup that asks for details is a form like any other: test how it behaves before closing it.
  if (probeForm) {
    const root = await popupFormRoot(page).catch(() => null);
    if (root) {
      b.formShots = [];
      b.form = await withTimeout(probeFormBehaviour(root, page, async (kind, label, note) => {
        const f = shotPath.replace(/\.jpg$/, `-${kind}.jpg`);
        await page.screenshot({ path: f, type: 'jpeg', quality: 74 });
        b.formShots.push({ kind: 'popup-form', label: `Popup form: ${label}`, note, file: f });
      }), 60000, 'popup form').catch((e) => ({ errors: [String(e.message).split('\n')[0]] }));
    }
  }
  const gone = async () => { await page.waitForTimeout(450); return !(await page.evaluate(findBlocker).catch(() => null)); };
  let closedVia = null;
  await page.keyboard.press('Escape').catch(() => {});
  if (await gone()) closedVia = 'the Escape key';
  if (!closedVia) {
    outer: for (const frame of page.frames()) {
      const scope = frame === page.mainFrame() ? '[data-kiln-blocker] ' : '';
      for (const sel of CLOSERS) {
        const loc = frame.locator(scope + sel).first();
        if (!(await loc.isVisible().catch(() => false))) continue;
        await loc.click({ timeout: 1200 }).catch(() => {});
        if (await gone()) { closedVia = 'its close button (Escape did nothing)'; break outer; }
      }
    }
  }
  if (!closedVia) {
    await page.mouse.click(6, Math.round(page.viewportSize().height / 2)).catch(() => {});
    if (await gone()) closedVia = 'clicking outside it (no working close button or Escape)';
  }
  if (!closedVia) {
    await page.evaluate(() => document.querySelectorAll('[data-kiln-blocker]').forEach((e) => e.remove())).catch(() => {});
    closedVia = 'NOT POSSIBLE with Escape, a close button or an outside click; kiln deleted it to continue';
  }
  await page.evaluate(() => { document.body.style.overflow = ''; document.documentElement.style.overflow = ''; }).catch(() => {});
  return { ...b, when, closedVia };
}

export async function capturePage(browser, info, vp, opts, composer) {
  const { url, dir } = info;
  const rel = (f) => path.relative(opts.out, f);
  const errors = [];
  const result = { viewport: vp.name, images: { sheets: [], sections: [], states: [], motion: {} }, errors };
  const tmp = path.join(dir, `.tmp-${vp.name}`);
  fs.mkdirSync(tmp, { recursive: true });

  const wantVideo = !opts.quick && vp.name === 'desktop' && info.key;
  const context = await browser.newContext(contextOptions(vp, wantVideo ? { recordVideo: { dir: tmp, size: { width: 1280, height: 800 } } } : {}));
  await context.addInitScript(initScript);
  const page = await context.newPage();
  const watch = watchPage(page, opts.origin);
  const cast = new Screencast();
  const motion = !opts.quick;
  if (motion) await cast.start(context, page);

  try {
    // ---------- load ----------
    const t0 = Date.now();
    let response = null;
    try { response = await page.goto(url, { waitUntil: 'commit', timeout: 35000 }); }
    catch (e) { errors.push(`navigation: ${String(e.message).split('\n')[0]}`); result.failed = true; return result; }
    result.status = response?.status() ?? null;
    result.finalUrl = page.url();
    await settle(page);
    result.loadWallMs = Date.now() - t0;
    const origin = await page.evaluate(() => performance.timeOrigin).catch(() => t0);
    const loadFrames = motion ? cast.take() : [];
    const loadStats = await page.evaluate(frameStats, 0).catch(() => null);
    const animSnaps = [await page.evaluate(collectAnimations).catch(() => [])];

    // ---------- first impression, exactly as a visitor gets it ----------
    const above = path.join(dir, `above-fold-${vp.name}.jpg`);
    await page.screenshot({ path: above, type: 'jpeg', quality: 82 });
    result.images.aboveFold = rel(above);
    const overlaysInitial = await page.evaluate(collectOverlays).catch(() => []);
    const dismissed = await page.evaluate(dismissCookieBanner).catch(() => null);
    if (dismissed) await page.waitForTimeout(700);
    const popups = [];
    const popupCheck = async (when) => {
      const f = path.join(dir, 'states', `${vp.name}-popup-${popups.length + 1}.jpg`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const b = await handlePopup(page, when, f, !opts.quick && !popups.some((x) => x.form)).catch(() => null);
      if (b) { b.shot = rel(f); popups.push(b); }
    };
    await popupCheck('on arrival');

    // ---------- scroll pass ----------
    const scrollStart = await page.evaluate(() => performance.now());
    let scrollFrames = [];
    await attempt('scroll pass', () => scrollThrough(page, vp, async (i) => {
      if (motion && i === 3) scrollFrames = cast.take();
      if (i === 1 || i === 4) animSnaps.push(await page.evaluate(collectAnimations).catch(() => []));
    }), errors, 60000);
    if (motion && !scrollFrames.length) scrollFrames = cast.take();
    const scrollStats = await page.evaluate(frameStats, scrollStart).catch(() => null);
    animSnaps.push(await page.evaluate(collectAnimations).catch(() => []));
    const tracksRaw = await page.evaluate(getTracks).catch(() => ({ tracks: [] }));
    await cast.stop();
    await popupCheck('while scrolling down the page');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);

    await popupCheck('after returning to the top');

    // ---------- viewport segments -> sheets ----------
    await attempt('segments', async () => {
      const pageH = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
      const total = Math.max(1, Math.ceil(pageH / vp.height));
      const count = Math.min(total, vp.maxSegments);
      result.segmentsTruncated = total > count ? { captured: count, total } : null;
      const segs = [];
      for (let i = 0; i < count; i++) {
        const y = Math.min(i * vp.height, Math.max(0, pageH - vp.height));
        await page.evaluate((top) => window.scrollTo(0, top), y);
        await page.waitForTimeout(i === 0 ? 150 : 380);
        // Timed popups can appear at any moment; never let one sit in a screenshot of the page itself.
        if (popups.length < 3) { const before = popups.length; await popupCheck('while reading the page'); if (popups.length > before) { await page.evaluate((top) => window.scrollTo(0, top), y); await page.waitForTimeout(300); } }
        const f = path.join(tmp, `seg-${String(i).padStart(2, '0')}.jpg`);
        await page.screenshot({ path: f, type: 'jpeg', quality: 78 });
        segs.push({ file: f, y, label: `${vp.name} · y ${y}–${y + vp.height}px` });
      }
      for (let i = 0, s = 1; i < segs.length; i += vp.perSheet, s++) {
        const group = segs.slice(i, i + vp.perSheet);
        const out = path.join(dir, 'sheets', `${vp.name}-${String(s).padStart(2, '0')}.jpg`);
        await composer.sheet(group, out, { direction: vp.direction, width: vp.direction === 'row' ? Math.min(1600, group.length * 520) : 1440 });
        result.images.sheets.push({ file: rel(out), yFrom: group[0].y, yTo: group[group.length - 1].y + vp.height });
      }
    }, errors, 90000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);

    // ---------- full page ----------
    await attempt('full page screenshot', async () => {
      const full = path.join(dir, `full-${vp.name}.jpg`);
      if (popups.length < 3) await popupCheck('while reading the page');
      await page.screenshot({ path: full, type: 'jpeg', quality: 70, fullPage: true });
      const thumb = path.join(dir, `thumb-${vp.name}.jpg`);
      await composer.thumb(full, thumb, { width: vp.name === 'desktop' ? 760 : 320, quality: 58 });
      result.images.full = rel(full); result.images.thumb = rel(thumb);
    }, errors, 45000);

    // ---------- evidence ----------
    const ev = await attempt('evidence', () => page.evaluate(collectEvidence, { mobile: vp.isMobile }), errors, 30000) || {};
    await popupCheck('later in the visit');
    ev.overlaysOnArrival = overlaysInitial;
    ev.popups = popups;
    if (vp.name === 'desktop') await attempt('design system measurements', async () => {
      ev.design = await page.evaluate(collectDesign);
      await cropComponents(page, ev.design, path.join(dir, 'design'), rel);
    }, errors, 45000);
    ev.cookieBannerDismissedVia = dismissed;

    if (vp.name === 'desktop' && ev.sections?.length) {
      await attempt('section crops', async () => {
        for (const s of ev.sections.slice(0, 12)) {
          const f = path.join(dir, 'sections', `${String(s.i).padStart(2, '0')}-${s.kind}.jpg`);
          fs.mkdirSync(path.dirname(f), { recursive: true });
          await page.screenshot({ path: f, type: 'jpeg', quality: 70, fullPage: true, clip: { x: 0, y: s.y, width: vp.width, height: Math.max(40, Math.min(s.h, 1800)) } });
          s.shot = rel(f);
          result.images.sections.push({ i: s.i, kind: s.kind, heading: s.heading, file: rel(f) });
        }
      }, errors, 60000);
    }

    // ---------- accessibility ----------
    ev.axe = await attempt('axe', async () => {
      await page.evaluate(getAxe());
      const r = await page.evaluate(() => window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] } }));
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, samples: v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')}${n.any?.[0]?.message ? ' — ' + n.any[0].message.slice(0, 140) : ''}`) }))
        .sort((a, b) => ['critical', 'serious', 'moderate', 'minor'].indexOf(a.impact) - ['critical', 'serious', 'moderate', 'minor'].indexOf(b.impact));
    }, errors, 40000) || null;

    // ---------- canvas activity ----------
    if (ev.media?.canvases?.length) {
      await attempt('canvas', async () => {
        for (const c of ev.media.canvases.slice(0, 2)) {
          const loc = page.locator(`[data-kiln-canvas="${c.i}"]`).first();
          await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
          const a = await loc.screenshot({ type: 'png', timeout: 4000 });
          await page.waitForTimeout(500);
          const b = await loc.screenshot({ type: 'png', timeout: 4000 });
          c.animating = !a.equals(b);
        }
        const since = await page.evaluate(() => performance.now());
        await page.waitForTimeout(1500);
        ev.media.canvasFrameStats = await page.evaluate(frameStats, since);
        await page.evaluate(() => window.scrollTo(0, 0));
      }, errors, 20000);
    }

    // ---------- interactions ----------
    if (!opts.quick) {
      const inter = await attempt('interactions', () => probeInteractions(page, url, vp, path.join(dir, 'states'), opts, errors), errors, 210000);
      if (inter) {
        ev.interactions = inter.facts;
        const popupStates = popups.flatMap((b) => [{ kind: 'popup', label: `Popup seen ${b.when}`, note: `covers ${b.areaPct}% of the screen; closing: ${b.closedVia}`, file: path.join(opts.out, b.shot) }, ...(b.formShots || [])]);
        inter.states.unshift(...popupStates);
        result.images.states = inter.states.map((s) => ({ kind: s.kind, label: s.label, note: s.note, file: rel(s.file) }));
        await attempt('state sheets', async () => {
          const hov = inter.states.filter((s) => s.kind === 'hover');
          const rest = inter.states.filter((s) => s.kind !== 'hover');
          const sheets = [];
          if (hov.length) { const out = path.join(dir, 'sheets', `${vp.name}-states-hover.jpg`); await composer.grid(hov.map((s) => ({ file: s.file, label: `${s.label}${s.note ? ' — ' + s.note : ''}` })), out, { cols: 4, title: 'Hover states: resting vs hovered' }); sheets.push(rel(out)); }
          for (let i = 0, k = 1; i < rest.length; i += 6, k++) {
            const out = path.join(dir, 'sheets', `${vp.name}-states-${k}.jpg`);
            await composer.grid(rest.slice(i, i + 6).map((s) => ({ file: s.file, label: `${s.label}${s.note ? ' — ' + s.note : ''}` })), out, { cols: vp.isMobile ? 4 : 2, title: `Interaction states (${vp.name})` });
            sheets.push(rel(out));
          }
          result.images.stateSheets = sheets;
        }, errors, 40000);
      }
    }

    // ---------- reduced motion ----------
    await attempt('reduced motion', async () => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForTimeout(350);
      const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length);
      ev.reducedMotion = { stillRunningUnderReduce: running, cssRuleFound: ev.motionCss?.reducedMotionRule ?? null };
      await page.emulateMedia({ reducedMotion: null });
    }, errors, 8000);

    ev.overlaysLate = await page.evaluate(collectOverlays).catch(() => []);
    ev.runtime = {
      status: result.status, finalUrl: result.finalUrl, redirected: result.finalUrl.replace(/\/$/, '') !== url.replace(/\/$/, ''),
      consoleErrors: [...new Set(watch.console)].slice(0, 12), pageErrors: [...new Set(watch.pageErrors)].slice(0, 8),
      failedRequests: watch.failed.slice(0, 12), badResponses: watch.badResponses.slice(0, 12),
    };

    // ---------- motion artefacts ----------
    const tracks = analyseTracks(tracksRaw.tracks);
    ev.motion = {
      animations: summariseAnimations(animSnaps),
      frameTiming: { load: loadStats, scroll: scrollStats, note: 'Measured while other pages were being captured; treat as indicative. The dedicated performance pass is the reliable number.' },
      tracks: tracks.map(({ progress, box, abs, ...t }) => t),
    };
    if (motion) {
      const mdir = path.join(dir, 'motion');
      const put = async (key, fn) => { const f = await attempt(`motion ${key}`, fn, errors, 30000); if (f) result.images.motion[key] = rel(f); };
      await put('load', () => frameSheet(composer, loadFrames, path.join(mdir, `${vp.name}-load.jpg`), { title: `Page load, ${vp.name}: frames as the page appeared (time since navigation start)`, originMs: origin }));
      if (vp.name === 'desktop') {
        await put('scroll', () => frameSheet(composer, scrollFrames, path.join(mdir, 'desktop-scroll.jpg'), { title: 'First scroll, desktop: frames while scrolling down the first screens', originMs: origin }));
        await put('curves', () => curvesSheet(composer, tracks, path.join(mdir, 'desktop-curves.jpg'), 'Measured motion curves'));
        const big = [...tracks].filter((t) => t.startMs < 6000).sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0];
        if (big) await put('element', () => elementStrip(composer, loadFrames, big, vp, path.join(mdir, 'desktop-element.jpg')));
      }
    }
    result.evidence = ev;
  } finally {
    const video = page.video();
    await context.close().catch(() => {});
    if (video && wantVideo) {
      try {
        const src = await video.path();
        const dest = path.join(dir, 'video.webm');
        fs.renameSync(src, dest);
        result.images.video = rel(dest);
      } catch {}
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  log(`  ${vp.name.padEnd(7)} ${info.slug} — ${result.images.sheets.length} sheets, ${result.images.states.length} states${errors.length ? `, ${errors.length} warnings` : ''} (${round((result.loadWallMs || 0) / 1000, 1)}s load)`);
  return result;
}
