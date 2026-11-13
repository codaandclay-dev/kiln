// Interaction states: hover, keyboard focus, menus, accordions, tabs, toggles,
// carousels and forms. Every probe is best-effort and isolated; a site that
// lacks a component simply produces no state for it.
import path from 'node:path';
import fs from 'node:fs';
import { attempt } from './util.mjs';
import { probeFormBehaviour } from './forms.mjs';

const STYLE_PROPS = ['color', 'backgroundColor', 'backgroundImage', 'borderTopColor', 'boxShadow', 'transform', 'textDecorationLine', 'opacity', 'filter', 'outlineStyle', 'scale', 'translate'];

export async function probeInteractions(page, url, vp, dir, opts, errors) {
  const states = [];   // {kind, label, file, note}
  const facts = {};
  const mobile = vp.name === 'mobile';
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const file = (label) => path.join(dir, `${vp.name}-${String(++n).padStart(2, '0')}-${label}.jpg`);
  const shot = async (kind, label, note, clip) => {
    const f = file(kind);
    await page.screenshot({ path: f, type: 'jpeg', quality: 72, ...(clip ? { clip } : {}) });
    states.push({ kind, label, note: note || '', file: f });
  };
  const restore = async () => {
    await page.keyboard.press('Escape').catch(() => {});
    if (page.url().split('#')[0] !== url.split('#')[0]) {
      await page.goto(url, { waitUntil: 'load', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(800);
    }
  };
  const clipAround = async (locator, pad = 24, maxH = 900) => {
    const b = await locator.boundingBox();
    if (!b) return null;
    const v = page.viewportSize();
    const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
    const w = Math.min(v.width - x, b.width + pad * 2), h = Math.min(v.height - y, Math.min(maxH, b.height + pad * 2));
    return w > 10 && h > 10 ? { x, y, width: w, height: h } : null;
  };
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);

  // ---- hover states (desktop) ----
  if (!mobile) await attempt('hover states', async () => {
    const count = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 20 && r.height > 12 && r.top >= 0 && r.bottom <= innerHeight && cs.visibility !== 'hidden' && +cs.opacity > 0.05; };
      const picked = [], seen = new Set();
      const consider = (el, kind) => {
        if (!vis(el)) return;
        const cs = getComputedStyle(el);
        const key = `${kind}|${cs.backgroundColor}|${cs.color}|${cs.borderRadius}`;
        if (seen.has(key)) return; seen.add(key);
        el.setAttribute('data-kiln-hover', String(picked.length)); el.setAttribute('data-kiln-kind', kind); picked.push(el);
      };
      for (const el of document.querySelectorAll('header a[href], nav a[href]')) { if (picked.length < 2) consider(el, 'nav-link'); }
      for (const el of document.querySelectorAll('button, a[href], [role=button]')) {
        if (picked.length >= 7) break;
        const cs = getComputedStyle(el);
        const styled = cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(cs.borderTopWidth) > 0;
        if (styled) consider(el, 'button');
      }
      return picked.length;
    });
    const results = [];
    for (let i = 0; i < count; i++) {
      const loc = page.locator(`[data-kiln-hover="${i}"]`).first();
      const read = () => loc.evaluate((el, props) => { const cs = getComputedStyle(el); const o = { cursor: cs.cursor }; for (const p of props) o[p] = cs[p]; return o; }, STYLE_PROPS);
      await page.mouse.move(2, 2);
      await page.waitForTimeout(120);
      const before = await read().catch(() => null);
      if (!before) continue;
      const clip = await clipAround(loc, 18, 160);
      const beforeFile = clip ? file('hover-off') : null;
      const shotA = clip ? await page.screenshot({ path: beforeFile, type: 'jpeg', quality: 80, clip }) : null;
      await loc.hover({ timeout: 2500, force: false }).catch(() => {});
      await page.waitForTimeout(380);
      const after = await read().catch(() => null);
      if (!after) continue;
      const changed = STYLE_PROPS.filter((p) => before[p] !== after[p]);
      const info = await loc.evaluate((el) => ({ text: (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 40), kind: el.getAttribute('data-kiln-kind') }));
      const afterFile = clip ? file('hover-on') : null;
      const shotB = clip ? await page.screenshot({ path: afterFile, type: 'jpeg', quality: 80, clip }) : null;
      // Pixels are the ground truth: hover styling is often on a child or pseudo-element.
      const visible = shotA && shotB ? !shotA.equals(shotB) : changed.length > 0;
      results.push({ ...info, changed, visible, cursor: after.cursor, before: beforeFile, after: afterFile });
    }
    await page.mouse.move(2, 2);
    facts.hover = {
      checked: results.length,
      noVisibleChange: results.filter((r) => !r.visible).map((r) => `${r.kind} "${r.text}"`),
      notPointerCursor: results.filter((r) => r.cursor !== 'pointer').map((r) => `${r.kind} "${r.text}"`),
      details: results.map((r) => ({ kind: r.kind, text: r.text, visible: r.visible, changed: r.changed })),
    };
    for (const r of results) {
      if (r.before) states.push({ kind: 'hover', label: `${r.kind} "${r.text}" — resting`, note: '', file: r.before, pair: 'a' });
      if (r.after) states.push({ kind: 'hover', label: `${r.kind} "${r.text}" — hovered`, note: r.visible ? `visibly changes${r.changed.length ? ` (${r.changed.join(', ')})` : ''}` : 'NO visible change', file: r.after, pair: 'b' });
    }
  }, errors, 45000);

  // ---- keyboard focus (desktop) ----
  if (!mobile) await attempt('keyboard focus', async () => {
    await page.evaluate(() => { window.scrollTo(0, 0); document.activeElement?.blur?.(); });
    const stops = [];
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(90);
      const s = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el), r = el.getBoundingClientRect();
        const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
        return { el: el.tagName.toLowerCase(), text: (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 40), ring: !!ring, onScreen: r.width > 0 && r.top < innerHeight && r.bottom > 0 };
      });
      if (s) stops.push(s);
      if (i === 2) await shot('focus', 'Keyboard focus after 3 Tab presses', 'Shows whether a focus indicator is visible', { x: 0, y: 0, width: vp.width, height: Math.min(vp.height, 520) });
    }
    facts.focus = {
      tabStops: stops.length, withVisibleIndicator: stops.filter((s) => s.ring).length,
      skipLinkFirst: !!stops[0] && /skip/i.test(stops[0].text), offScreenStops: stops.filter((s) => !s.onScreen).length,
      withoutIndicator: stops.filter((s) => !s.ring).map((s) => `${s.el} "${s.text}"`).slice(0, 6),
    };
    await page.evaluate(() => document.activeElement?.blur?.());
  }, errors, 20000);

  // ---- mobile menu ----
  if (mobile) await attempt('mobile menu', async () => {
    const found = await page.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 10 && r.height > 10 && r.top < 200 && r.top >= 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
      const cands = [...document.querySelectorAll('button, [role=button], a, label, div[class*="burger"], div[class*="menu-toggle"], div[class*="nav-toggle"]')].filter(vis);
      const score = (el) => {
        const s = `${el.getAttribute('aria-label') || ''} ${el.id} ${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute('aria-controls') || ''}`.toLowerCase();
        let n = 0;
        if (/menu|navigation|nav\b|hamburger|burger|toggle/.test(s)) n += 3;
        if (el.hasAttribute('aria-expanded')) n += 2;
        if (el.closest('header, nav')) n += 1;
        if (!(el.innerText || '').trim() && el.querySelector('svg, span, i')) n += 1;
        if ((el.innerText || '').trim().length > 14) n -= 3;
        if (el.tagName === 'A' && el.getAttribute('href') && !el.getAttribute('href').startsWith('#')) n -= 3;
        return n;
      };
      const best = cands.map((el) => [score(el), el]).sort((a, b) => b[0] - a[0])[0];
      if (!best || best[0] < 3) return false;
      best[1].setAttribute('data-kiln-menu', '1');
      return true;
    });
    const navLinksVisible = () => page.evaluate(() => [...document.querySelectorAll('nav a[href], header a[href], [role=dialog] a[href]')].filter((a) => { const r = a.getBoundingClientRect(); const cs = getComputedStyle(a); return r.width > 20 && r.height > 8 && r.top >= 0 && r.top < innerHeight && r.left >= 0 && r.left < innerWidth && cs.visibility !== 'hidden' && +cs.opacity > 0.1; }).length);
    const before = await navLinksVisible();
    if (!found) { facts.mobileMenu = { toggleFound: false, navLinksVisibleWithoutMenu: before }; return; }
    await page.locator('[data-kiln-menu]').first().click({ timeout: 3000 });
    await page.waitForTimeout(700);
    const after = await navLinksVisible();
    const scrollLocked = await page.evaluate(() => /hidden|clip/.test(getComputedStyle(document.body).overflowY + getComputedStyle(document.documentElement).overflowY));
    await shot('mobile-menu', 'Mobile menu opened', `${after} navigation links visible after tapping the menu button (was ${before})`);
    facts.mobileMenu = { toggleFound: true, linksBefore: before, linksAfter: after, opened: after > before, scrollLockedWhileOpen: scrollLocked };
    await page.locator('[data-kiln-menu]').first().click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(400);
    await restore();
  }, errors, 20000);

  // ---- desktop dropdown navigation ----
  if (!mobile) await attempt('dropdown nav', async () => {
    const count = await page.evaluate(() => {
      const items = [...document.querySelectorAll('header [aria-haspopup], header [aria-expanded], nav [aria-haspopup], nav [aria-expanded], nav li:has(ul) > a, nav li:has(ul) > button')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 10 && r.top >= 0 && r.top < 160; });
      items.slice(0, 2).forEach((el, i) => el.setAttribute('data-kiln-dd', String(i)));
      return Math.min(2, items.length);
    });
    for (let i = 0; i < count; i++) {
      const loc = page.locator(`[data-kiln-dd="${i}"]`).first();
      const text = (await loc.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 30);
      await loc.hover({ timeout: 2000 });
      await page.waitForTimeout(450);
      let expanded = await loc.getAttribute('aria-expanded');
      if (expanded === 'false') { await loc.click({ timeout: 2000 }).catch(() => {}); await page.waitForTimeout(450); expanded = await loc.getAttribute('aria-expanded'); }
      await shot('dropdown', `Navigation dropdown "${text}"`, '', { x: 0, y: 0, width: vp.width, height: Math.min(vp.height, 640) });
      await page.mouse.move(2, vp.height - 4);
      await restore();
    }
    facts.dropdowns = count;
  }, errors, 20000);

  // ---- accordions / FAQ ----
  await attempt('accordion', async () => {
    const count = await page.evaluate(() => {
      const els = [...document.querySelectorAll('main details > summary, details > summary, main [aria-expanded="false"][aria-controls], main button[aria-expanded="false"]')].filter((el) => !el.closest('header, nav') && el.getBoundingClientRect().width > 80);
      els.slice(0, 1).forEach((el) => el.setAttribute('data-kiln-acc', '1'));
      return els.length;
    });
    facts.accordions = count;
    if (!count) return;
    const loc = page.locator('[data-kiln-acc]').first();
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
    await page.waitForTimeout(300);
    await loc.click({ timeout: 2500 });
    await page.waitForTimeout(600);
    await shot('accordion', 'Accordion / FAQ item opened', `${count} collapsible items on the page`);
    await restore();
  }, errors, 15000);

  // ---- tabs ----
  await attempt('tabs', async () => {
    const loc = page.locator('[role=tab][aria-selected="false"]').first();
    if (!(await loc.count())) return;
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
    await loc.click({ timeout: 2500 });
    await page.waitForTimeout(600);
    await shot('tabs', 'Second tab selected', '');
    facts.tabs = true;
    await restore();
  }, errors, 15000);

  // ---- pricing period toggle ----
  await attempt('pricing toggle', async () => {
    let loc = page.locator('main [role=switch], [role=switch]').first();
    if (!(await loc.count())) loc = page.getByRole('button', { name: /^(annual(ly)?|yearly|billed (annually|yearly))/i }).first();
    if (!(await loc.count())) loc = page.getByRole('tab', { name: /annual|yearly/i }).first();
    if (!(await loc.count()) || !(await loc.isVisible().catch(() => false))) return;
    const near = await loc.evaluate((el) => /month|annual|year|billing|pricing|plan/i.test((el.closest('section, div[class*="pric"], main') || document.body).innerText.slice(0, 4000)));
    if (!near) return;
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
    await loc.click({ timeout: 2500 });
    await page.waitForTimeout(600);
    await shot('pricing-toggle', 'Pricing after switching billing period', '');
    facts.pricingToggle = true;
    await restore();
  }, errors, 15000);

  // ---- carousel ----
  await attempt('carousel', async () => {
    const loc = page.locator('.swiper-button-next, .slick-next, .splide__arrow--next, [aria-label*="next" i]:is(button,[role=button]), [aria-label*="Next slide" i]').first();
    if (!(await loc.count()) || !(await loc.isVisible().catch(() => false))) return;
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
    await page.waitForTimeout(250);
    await loc.click({ timeout: 2500 });
    await page.waitForTimeout(800);
    await shot('carousel', 'Carousel after pressing next', '');
    facts.carousel = true;
    await restore();
  }, errors, 15000);

  // ---- lead form ----
  await attempt('form', async () => {
    const idx = await page.evaluate(() => {
      const forms = [...document.querySelectorAll('form')].filter((f) => f.getBoundingClientRect().width > 100);
      const f = forms.find((x) => x.getAttribute('role') !== 'search' && [...x.querySelectorAll('input, textarea, select')].filter((i) => !['hidden', 'submit', 'button', 'search'].includes(i.type) && i.getBoundingClientRect().width > 0).length >= 1 && !x.querySelector('input[type=password]'));
      if (!f) return -1;
      f.setAttribute('data-kiln-lead', '1');
      return forms.indexOf(f);
    });
    if (idx < 0) return;
    const form = page.locator('[data-kiln-lead]').first();
    await form.scrollIntoViewIfNeeded({ timeout: 3000 });
    await page.waitForTimeout(350);
    const clip = async () => (await clipAround(form, 20, vp.height)) || undefined;
    await shot('form-empty', 'Lead form, untouched', '', await clip());
    // Behave like a visitor: mistype, leave, correct. Records when errors appear, what they say and when they clear.
    const behaviour = await probeFormBehaviour(form, page, async (kind, label, note) => shot(kind, `Lead form: ${label}`, note, await clip())).catch((e) => ({ errors: [String(e.message).split('\n')[0]] }));
    const fields = form.locator('input:visible, textarea:visible, select:visible');
    const total = Math.min(await fields.count(), 12);
    for (let i = 0; i < total; i++) {
      const f = fields.nth(i);
      const meta = await f.evaluate((el) => ({ tag: el.tagName, type: (el.type || '').toLowerCase(), name: `${el.name} ${el.id} ${el.placeholder} ${el.autocomplete}`.toLowerCase() })).catch(() => null);
      if (!meta || ['submit', 'button', 'hidden', 'file', 'password'].includes(meta.type)) continue;
      try {
        if (meta.tag === 'SELECT') await f.selectOption({ index: 1 }, { timeout: 1500 });
        else if (meta.type === 'checkbox' || meta.type === 'radio') await f.check({ timeout: 1500 });
        else if (meta.type === 'email' || /email/.test(meta.name)) await f.fill('kiln-test@example.com', { timeout: 1500 });
        else if (meta.type === 'tel' || /phone|tel/.test(meta.name)) await f.fill('555-010-0199', { timeout: 1500 });
        else if (meta.type === 'url' || /website|url/.test(meta.name)) await f.fill('https://example.com', { timeout: 1500 });
        else if (meta.type === 'number') await f.fill('3', { timeout: 1500 });
        else if (meta.tag === 'TEXTAREA') await f.fill('This is an automated site-quality test. Please ignore.', { timeout: 1500 });
        else if (/first/.test(meta.name)) await f.fill('Kiln', { timeout: 1500 });
        else if (/last/.test(meta.name)) await f.fill('Test', { timeout: 1500 });
        else if (/company|organi[sz]ation|business/.test(meta.name)) await f.fill('Kiln Test Co', { timeout: 1500 });
        else if (['text', '', 'search'].includes(meta.type)) await f.fill('Kiln Test', { timeout: 1500 });
      } catch {}
    }
    await page.waitForTimeout(300);
    await shot('form-filled', 'Lead form filled with test data (not submitted)', '', await clip());
    facts.form = { probed: true, behaviour, submitted: false };
    if (opts.submitForms) {
      const submit = form.locator('button[type=submit], input[type=submit], button:not([type])').first();
      if (await submit.count()) {
        await submit.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(3500);
        await shot('form-submitted', 'Result after submitting the form', `URL after submit: ${page.url()}`);
        facts.form.submitted = true; facts.form.urlAfterSubmit = page.url();
      }
    }
    await restore();
  }, errors, 90000);

  return { states, facts };
}
