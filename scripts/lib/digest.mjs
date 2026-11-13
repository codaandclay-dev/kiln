// Turns raw evidence into a compact, plain-language digest the reviewers read
// alongside the screenshots. Facts only: no judgements are made here.

import { behaviourLines } from './forms.mjs';
import { designLines } from './tokens.mjs';

const list = (xs, f = (x) => x, sep = ', ') => xs.map(f).join(sep);
const ms = (n) => (n == null ? 'n/a' : `${n} ms`);
const yes = (b) => (b ? 'yes' : 'no');

export function pageDigest(p) {
  const d = p.desktop?.evidence || {}, m = p.mobile?.evidence || {};
  const L = [];
  const add = (s = '') => L.push(s);
  const sec = (t) => { add(); add(`## ${t}`); };

  add(`# ${p.id} · ${p.url}`);
  add(`Title: ${d.meta?.title || '(none)'} · HTTP ${p.desktop?.status ?? '?'}${d.runtime?.redirected ? ` · redirected to ${d.runtime.finalUrl}` : ''}`);
  if (p.desktop?.failed) { add('**The page failed to load on desktop.**'); return L.join('\n'); }

  sec('Images to look at');
  for (const im of p.images.audit) add(`- \`${im.file}\` — ${im.what}`);
  if (p.images.sections?.length) add(`- Section crops (open if you need a closer look): ${list(p.images.sections, (s) => `\`${s.file}\``)}`);

  sec('Page structure (desktop, top to bottom)');
  for (const s of d.sections || []) add(`- §${s.i} **${s.kind}** y=${s.y} h=${s.h}px${s.heading ? ` — "${s.heading}"` : ''} · ${s.words} words, ${s.images} images${s.buttons?.length ? ` · buttons: ${list(s.buttons, (b) => `"${b}"`)}` : ''}`);
  add(`Desktop page is ${d.layout?.screens ?? '?'} screens tall (${d.layout?.pageHeight ?? '?'}px); mobile is ${m.layout?.screens ?? '?'} screens (${m.layout?.pageHeight ?? '?'}px).`);
  for (const r of [p.desktop, p.mobile]) if (r?.segmentsTruncated) add(`Note: ${r.viewport} screenshots cover the first ${r.segmentsTruncated.captured} of ${r.segmentsTruncated.total} screens.`);

  sec('First screen');
  add(`- Desktop: h1 visible without scrolling: ${yes(d.fold?.h1Visible)}${d.fold?.h1FontSize ? ` (${d.fold.h1FontSize}px)` : ''}; buttons above the fold: ${list(d.cta?.aboveFold || [], (b) => `"${b.text}"${b.inHeader ? ' (header)' : ''}`) || 'none'}`);
  add(`- Mobile: h1 visible without scrolling: ${yes(m.fold?.h1Visible)}${m.fold?.h1FontSize ? ` (${m.fold.h1FontSize}px)` : ''}; buttons above the fold: ${list(m.cta?.aboveFold || [], (b) => `"${b.text}"${b.inHeader ? ' (header)' : ''}`) || 'none'}`);
  add(`- h1: ${list(d.meta?.h1 || [], (h) => `"${h}"`) || 'NONE'}${(d.meta?.h1 || []).length > 1 ? ` (${d.meta.h1.length} h1 elements)` : ''}`);
  const ov = (e, when) => (e || []).filter((o) => o.kind !== 'sticky-header').map((o) => `${o.kind} covering ${o.areaPct}% of the screen ${when}${o.text ? ` ("${o.text.slice(0, 50)}")` : ''}`);
  const overlays = [...ov(d.overlaysOnArrival, 'on desktop arrival'), ...ov(m.overlaysOnArrival, 'on mobile arrival'), ...ov((m.overlaysLate || []).filter((o) => !(m.overlaysOnArrival || []).some((a) => a.kind === o.kind)), 'on mobile after scrolling')];
  if (overlays.length) add(`- Overlays: ${overlays.join('; ')}`);
  for (const [vpn, e] of [['desktop', d], ['mobile', m]]) for (const b of e.popups || []) { add(`- POPUP on ${vpn}: covered ${b.areaPct}% of the screen, first seen ${b.when} (${Math.round(b.sinceLoadMs / 1000)}s after load)${b.text ? `, text "${b.text.slice(0, 80)}"` : b.inIframe ? ', content inside an iframe' : ''}; closing it: ${b.closedVia}. Screenshot: \`${b.shot}\`. Later screenshots were taken with it closed.`); for (const l of behaviourLines(b.form, `Popup form (${vpn})`)) add(l); }

  sec('Buttons and calls to action');
  add(`- ${d.cta?.count ?? 0} button-like elements in ${d.cta?.distinctStyles ?? 0} distinct visual styles; corner radii in use: ${list(d.cta?.distinctRadii || []) || 'n/a'}`);
  add(`- Styles: ${list(d.cta?.styles || [], (s) => `${s.count}× bg ${s.bg} / text ${s.color} / radius ${s.radius}`, '; ')}`);
  add(`- Wording: ${list(d.cta?.texts || [], (t) => `"${t.text}"×${t.count}`)}`);
  add(`- Positions down the page (y px): ${list((d.cta?.positions || []).slice(0, 16), (b) => `"${b.text}"@${b.y}`)}`);

  sec('Typography and colour (measured)');
  add(`- Font families (${d.typography?.familyCount}): ${list(d.typography?.families || [], (f) => `${f.value} ${f.share}%`)}`);
  add(`- Font sizes in use (${d.typography?.sizeCount}): ${list(d.typography?.sizes || [], (f) => `${f.value} ${f.share}%`)}`);
  add(`- Mobile font sizes (${m.typography?.sizeCount}): ${list((m.typography?.sizes || []).slice(0, 8), (f) => `${f.value} ${f.share}%`)}`);
  add(`- Weights: ${list(d.typography?.weights || [], (f) => `${f.value} ${f.share}%`)}`);
  add(`- Text colours (${d.typography?.textColorCount}): ${list(d.typography?.textColors || [], (f) => `${f.value} ${f.share}%`)}`);
  add(`- Large background colours: ${list(d.typography?.backgroundColors || [], (f) => `${f.value} ${f.share}%`)}`);
  if (d.typography?.smallTextChars) add(`- Text under 12px on desktop: ${d.typography.smallTextChars} characters, e.g. ${d.typography.smallTextSamples.join('; ')}`);
  if (m.typography?.smallTextChars) add(`- Text under 12px on mobile: ${m.typography.smallTextChars} characters, e.g. ${m.typography.smallTextSamples.join('; ')}`);
  if (d.typography?.paragraphsOver100Chars) add(`- ${d.typography.paragraphsOver100Chars} long paragraphs run wider than ~100 characters per line`);
  if (d.typography?.tightLineHeightBlocks) add(`- ${d.typography.tightLineHeightBlocks} body-text blocks have line-height under 1.3`);

  sec('Mobile layout');
  add(`- Horizontal overflow: ${m.layout?.horizontalOverflowPx ? `YES, ${m.layout.horizontalOverflowPx}px wider than the screen; offenders: ${list(m.layout.overflowOffenders, (o) => `${o.el} (right edge ${o.right}px at y=${o.y})`)}` : 'none'}`);
  if (d.layout?.horizontalOverflowPx) add(`- Desktop horizontal overflow: ${d.layout.horizontalOverflowPx}px`);
  add(`- Tap targets under 44×44px: ${m.layout?.tapTargetsUnder44 ?? 0} (under 24px: ${m.layout?.tapTargetsUnder24 ?? 0})${m.layout?.tapSamples?.length ? ` e.g. ${list(m.layout.tapSamples.slice(0, 5), (t) => `"${t.text || t.el}" ${t.w}×${t.h}`)}` : ''}`);
  const mm = m.interactions?.mobileMenu;
  if (mm) add(`- Mobile menu: ${mm.toggleFound ? `toggle found; tapping it ${mm.opened ? `revealed ${mm.linksAfter} links` : 'did NOT reveal navigation links'}${mm.opened ? `; page scroll locked while open: ${yes(mm.scrollLockedWhileOpen)}` : ''}` : `no menu button detected; ${mm.navLinksVisibleWithoutMenu} nav links visible`}`);

  const it = d.interactions || {};
  if (Object.keys(it).length) {
    sec('Interaction states (desktop)');
    if (it.hover) {
      add(`- Hover checked on ${it.hover.checked} elements: ${list(it.hover.details, (h) => `${h.kind} "${h.text}" → ${h.visible ? `visible change${h.changed.length ? ` (${h.changed.join('/')})` : ''}` : 'NO visible change'}`, '; ')}`);
      if (it.hover.notPointerCursor.length) add(`- No pointer cursor on: ${it.hover.notPointerCursor.join(', ')}`);
    }
    if (it.focus) add(`- Keyboard: ${it.focus.withVisibleIndicator} of ${it.focus.tabStops} first tab stops show a focus indicator; skip link first: ${yes(it.focus.skipLinkFirst)}${it.focus.withoutIndicator.length ? `; no indicator on ${it.focus.withoutIndicator.join(', ')}` : ''}`);
    const comps = [it.dropdowns ? `${it.dropdowns} nav dropdowns` : '', it.accordions ? `${it.accordions} accordion items` : '', it.tabs ? 'tabs' : '', it.pricingToggle ? 'pricing toggle' : '', it.carousel ? 'carousel' : ''].filter(Boolean);
    if (comps.length) add(`- Components exercised: ${comps.join(', ')}`);
    if (it.form) { add(`- Lead form probed${it.form.submitted ? ' and SUBMITTED' : ' (filled in but not submitted)'}. Behaviour while filling it in:`); for (const l of behaviourLines(it.form.behaviour, 'Lead form')) add(l); }
  }

  if (d.forms?.length) {
    sec('Forms');
    for (const f of d.forms) add(`- Form at y=${f.y}${f.isSearch ? ' (search)' : ''}: ${f.fieldCount} fields [${list(f.fields, (x) => `${x.type}${x.required ? '*' : ''}:${x.labelled || 'NO LABEL'}`)}], ${f.unlabelled} without a real label, submit "${f.submitText || '?'}"`);
  }

  sec('Motion');
  const an = d.motion?.animations;
  if (an) {
    add(`- ${an.total} animations/transitions seen (${an.distinct} distinct); infinite loops: ${an.infinite}; longer than 1s: ${an.longerThan1s}; linear-eased movement: ${an.linearMovement}; animating layout properties: ${an.layoutProperties}`);
    for (const a of an.list.slice(0, 10)) add(`  - ${a.type} "${a.name}" ${a.duration ?? '?'}ms delay ${a.delay}ms ${a.easing} ×${a.iterations} on ${a.targets} element(s) e.g. ${a.sample} [${a.props.join(', ')}]`);
  }
  for (const t of (d.motion?.tracks || []).filter((t) => t.looping).slice(0, 4)) add(`- Measured: ${t.el} (${t.cause}${t.name ? ` "${t.name}"` : ''}) loops continuously from ${t.startMs}ms after load`);
  for (const t of (d.motion?.tracks || []).filter((t) => !t.looping).slice(0, 8)) add(`- Measured: ${t.el} (${t.cause}) ${t.channel} over ${t.durationMs}ms starting ${t.startMs}ms after load; moved ${t.movedPx.join(',')}px, opacity ${t.opacity.join('→')}; curve: ${t.easing}${t.overshoot ? `, overshoot ${t.overshoot}` : ''}; worst frame gap ${t.maxFrameGapMs}ms, ${t.droppedFrames} dropped frames`);
  add(`- Buttons/links with a hover transition: ${d.motionCss?.interactiveWithTransition ?? '?'}; without: ${d.motionCss?.interactiveWithoutTransition ?? '?'}; durations: ${list(d.motionCss?.transitionDurations || [], (x) => `${x.value} ${x.share}%`) || 'n/a'}`);
  add(`- Reduced motion: CSS rule present: ${d.motionCss?.reducedMotionRule ? 'yes' : d.motionCss?.unreadableSheets ? 'not found (some stylesheets unreadable)' : 'no'}; animations still running when the visitor asks for reduced motion: ${d.reducedMotion?.stillRunningUnderReduce ?? '?'}`);
  if (d.media?.canvases?.length) add(`- Canvas: ${list(d.media.canvases, (c) => `${c.w}×${c.h} at y=${c.y}, ${c.animating == null ? 'activity unknown' : c.animating ? 'animating' : 'static'}`)}${d.media.canvasFrameStats ? `; ${d.media.canvasFrameStats.avgFps} fps, worst gap ${d.media.canvasFrameStats.maxGapMs}ms` : ''}`);
  for (const v of d.media?.videos || []) add(`- Video ${v.w}×${v.h} shown at ${v.shown.join('×')} y=${v.y}: autoplay ${yes(v.autoplay)}, muted ${yes(v.muted)}, loop ${yes(v.loop)}, poster ${yes(v.poster)}, controls ${yes(v.controls)}, ${v.duration ?? '?'}s — ${v.src.slice(0, 90)}`);

  sec('Performance');
  const pf = p.perf;
  if (pf?.desktop?.median) {
    const md = pf.desktop.median;
    add(`- Desktop, median of ${pf.desktop.runs} cold loads: first paint ${ms(md.fcp)}, largest element ${ms(md.lcp)}, layout shift ${md.cls}, blocking time ${ms(md.tbt)}, ${md.transferKb} KB over ${md.requests} requests`);
    add(`- Scrolling: ${md.scrollFps} fps, worst frame gap ${ms(md.scrollMaxGapMs)}; jank reproducible: ${yes(pf.desktop.scrollJank.reproducible)} (${pf.desktop.scrollJank.runsWithJank} of ${pf.desktop.runs} runs)`);
  } else {
    const q = d.perf || {};
    add(`- Desktop, single load during capture (indicative): first paint ${ms(q.fcp)}, largest element ${ms(q.lcp)}, layout shift ${q.cls}, blocking time ${ms(q.totalBlockingTime)}, ${q.transferKb} KB over ${q.requests} requests`);
  }
  if (pf?.throttledMobile && !pf.throttledMobile.error) add(`- Slow phone (${pf.throttledMobile.profile}): first paint ${ms(pf.throttledMobile.fcp)}, largest element ${ms(pf.throttledMobile.lcp)}, layout shift ${pf.throttledMobile.cls}`);
  const q = d.perf || {};
  add(`- Largest element: ${q.lcpElement || 'n/a'} · weight by type (KB): ${list(Object.entries(q.byTypeKb || {}), ([k, v]) => `${k} ${v}`)} · ${q.thirdPartyHosts ?? '?'} third-party hosts · ${q.domNodes ?? '?'} DOM nodes`);
  add(`- Heaviest files: ${list((q.largest || []).slice(0, 4), (r) => `${r.kb} KB ${r.type} ${r.url.split('/').pop().slice(0, 50)}`, '; ')}`);
  const im = d.media || {};
  add(`- Images: ${im.images ?? 0} total; formats ${JSON.stringify(im.formats || {})}; ${im.missingAlt ?? 0} without alt; ${im.withoutDimensions ?? 0} without width/height; ${im.lazyLoaded ?? 0} lazy-loaded`);
  if (im.broken?.length) add(`- BROKEN images: ${im.broken.join(', ')}`);
  if (im.oversized?.length) add(`- Oversized images: ${list(im.oversized, (o) => `${o.natural}px file shown at ${o.shown}px`)}`);
  if (im.upscaled?.length) add(`- Upscaled (likely blurry) images: ${list(im.upscaled, (o) => `${o.natural}px file stretched to ${o.shown}px (${o.src.split('/').pop().slice(0, 40)})`)}`);

  if (pf?.engines?.length) {
    sec('Other browsers');
    for (const e of pf.engines) add(`- ${e.engine}: ${e.ok ? `rendered; overflow ${e.overflowPx}px; page height ${e.pageHeight}px; fonts ${e.fonts.join(', ') || 'none loaded'}; ${e.consoleErrors.length + e.pageErrors.length} errors${e.pageErrors[0] ? ` e.g. "${e.pageErrors[0].slice(0, 100)}"` : ''}` : `FAILED: ${e.error}`}`);
  }

  sec('Errors and accessibility');
  const rt = d.runtime || {};
  add(`- Console errors: ${rt.consoleErrors?.length ? rt.consoleErrors.map((e) => `"${e.slice(0, 140)}"`).join('; ') : 'none'}`);
  if (rt.pageErrors?.length) add(`- Uncaught script errors: ${rt.pageErrors.map((e) => `"${e.slice(0, 140)}"`).join('; ')}`);
  if (rt.badResponses?.length) add(`- Failed responses: ${list(rt.badResponses.slice(0, 8), (r) => `${r.status} ${r.type} ${r.url.slice(0, 90)}`, '; ')}`);
  if (rt.failedRequests?.length) add(`- Requests that never completed: ${list(rt.failedRequests.slice(0, 6), (r) => `${r.type} ${r.url.slice(0, 80)} (${r.error})`, '; ')}`);
  const ax = [...(d.axe || []).map((v) => ({ ...v, vp: 'desktop' })), ...(m.axe || []).filter((v) => !(d.axe || []).some((x) => x.id === v.id)).map((v) => ({ ...v, vp: 'mobile only' }))];
  if (d.axe == null) add('- Automated accessibility scan did not run on this page.');
  else if (!ax.length) add('- Automated accessibility scan: no violations.');
  for (const v of ax.slice(0, 14)) add(`- a11y [${v.impact}] ${v.help} — ${v.nodes} element(s) (${v.vp}) e.g. ${v.samples[0]?.slice(0, 160) || ''}`);
  if (d.meta?.headingSkips?.length) add(`- Heading levels skipped: ${d.meta.headingSkips.join('; ')}`);

  sec('Search, sharing and trust basics');
  const mt = d.meta || {};
  add(`- Title (${mt.titleLength} chars): "${mt.title || ''}" · description (${(mt.description || '').length} chars): ${mt.description ? `"${mt.description.slice(0, 180)}"` : 'MISSING'}`);
  add(`- Social preview: og:title ${yes(mt.ogTitle)}, og:description ${yes(mt.ogDescription)}, og:image ${mt.ogImage ? mt.ogImage.slice(0, 120) : 'MISSING'}, twitter:card ${mt.twitterCard || 'MISSING'}`);
  add(`- Favicon ${yes(mt.favicon)} · lang "${mt.lang || 'MISSING'}" · canonical ${yes(mt.canonical)} · viewport meta ${yes(mt.viewport)} · structured data blocks ${mt.structuredData}${mt.robots ? ` · robots "${mt.robots}"` : ''}${mt.generator ? ` · generator "${mt.generator}"` : ''}`);
  const lk = d.links || {};
  add(`- Links: ${lk.unique ?? 0} distinct; ${lk.deadHashLinks ?? 0} go nowhere (href="#"); ${lk.emptyText ?? 0} have no text; privacy link ${yes(lk.privacy)}; terms link ${yes(lk.terms)}; contact link ${yes(lk.contact)}; email ${lk.mailto?.join(', ') || 'none'}; phone ${yes(lk.tel)}; social ${lk.social?.join(', ') || 'none'}`);
  const cp = d.copy || {};
  add(`- Copy: ${cp.words ?? 0} words${cp.placeholderHits?.length ? `; POSSIBLE PLACEHOLDER TEXT: ${cp.placeholderHits.map((h) => `"${h}"`).join(', ')}` : ''}${cp.copyrightYear ? `; footer copyright year ${cp.copyrightYear} (current year ${cp.currentYear})` : '; no copyright year found'}`);
  if (d.tech?.length) add(`- Built with / uses: ${d.tech.join(', ')}`);
  if (p.brokenLinks?.length) add(`- BROKEN LINKS on this page: ${list(p.brokenLinks.slice(0, 10), (b) => `${b.href} (${b.status || b.error})`, '; ')}`);

  const warn = [...(p.desktop?.errors || []).map((e) => `desktop ${e}`), ...(p.mobile?.errors || []).map((e) => `mobile ${e}`), ...(p.perfErrors || [])];
  if (warn.length) { sec('Capture gaps (things kiln could not check on this page)'); for (const w of warn.slice(0, 12)) add(`- ${w}`); }

  add(); add(`Full page copy: \`${p.files.text}\` · raw evidence: \`${p.files.evidence}\``);
  return L.join('\n');
}

export function siteDigest(man) {
  const L = [`# Site digest · ${man.origin}`, ''];
  L.push(`Probed ${man.pages.length} pages in ${man.mode} mode on ${man.finishedAt.slice(0, 10)}.${man.discovery.skipped.length ? ` ${man.discovery.skipped.length} discovered pages were left out (page cap or repeated templates); see manifest.json.` : ''}`);
  L.push('', '## Pages');
  for (const p of man.pages) L.push(`- ${p.id} ${p.url} — "${p.title}"${p.key ? ' (key page: full performance and cross-browser passes)' : ''}${p.failed ? ' — FAILED TO LOAD' : ''}`);
  const s = man.site;
  L.push('', '## Site-wide checks');
  L.push(`- sitemap.xml: ${s.sitemapFound ? 'found' : 'not found'}`);
  if (s.notFound) L.push(`- Unknown URL (${s.notFound.url}) returns HTTP ${s.notFound.status}${s.notFound.status === 200 ? ' — a missing page is served as if it exists (soft 404)' : ''}; screenshot \`${s.notFound.shot || 'n/a'}\`; links back to the home page: ${s.notFound.hasHomeLink ? 'yes' : 'no'}; text: "${(s.notFound.text || '').slice(0, 160)}"`);
  L.push(`- Privacy page linked: ${s.legal.privacy || 'NO'} · terms linked: ${s.legal.terms || 'NO'}`);
  L.push(`- Links checked: ${s.links.checked}; broken: ${s.links.broken.length}; refused by bot protection (not counted as broken): ${s.links.blockedByBotProtection}${s.links.notChecked ? `; not checked: ${s.links.notChecked}` : ''}`);
  for (const b of s.links.broken.slice(0, 25)) L.push(`  - ${b.status || b.error} ${b.href} — linked from ${b.foundOn}${b.text ? ` ("${b.text}")` : ''}`);
  L.push(`- Technology seen: ${s.tech.join(', ') || 'nothing identified'}`);
  L.push('', '## Consistency across pages (desktop, measured)');
  L.push('| Page | Fonts | Distinct sizes | Text colours | Button styles | Button radii | Title length | Description |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const r of s.consistency) L.push(`| ${r.id} ${r.path} | ${r.families} | ${r.sizes} | ${r.colors} | ${r.buttonStyles} | ${r.radii} | ${r.titleLength} | ${r.description} |`);
  L.push('', `Header button wording per page: ${s.headerCtas}`);
  if (s.duplicateTitles.length) L.push(`Duplicate titles: ${s.duplicateTitles.join('; ')}`);
  if (s.missingDescriptions.length) L.push(`Pages without a meta description: ${s.missingDescriptions.join(', ')}`);
  L.push(...designLines(s.design));
  if (s.componentSheets?.length) { L.push('', '### Component sheets (look at these)'); for (const c of s.componentSheets) L.push(`- \`${c.file}\` — ${c.what}`); }
  if (man.warnings.length) { L.push('', '## What this run did not cover'); for (const w of man.warnings) L.push(`- ${w}`); }
  return L.join('\n');
}
