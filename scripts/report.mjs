#!/usr/bin/env node
// kiln report: ledger + grades + screenshots -> one self-contained report.html
//   node scripts/report.mjs --run DIR [--no-embed]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, readJson, KILN_ROOT } from './lib/util.mjs';

const args = parseArgs(process.argv.slice(2), ['no-embed']);
if (!args.run) { console.error('usage: report.mjs --run DIR [--no-embed]'); process.exit(2); }
const run = path.resolve(args.run);
const embed = !args['no-embed'];
const RUBRIC = readJson(path.join(KILN_ROOT, 'schemas', 'rubric.json'));
const man = readJson(path.join(run, 'manifest.json'));
const led = readJson(path.join(run, 'ledger.json'));
const grades = readJson(path.join(run, 'grades.json'));
const fi = { claude: readJson(path.join(run, 'first-impression', 'claude.json'), null), codex: readJson(path.join(run, 'first-impression', 'codex.json'), null) };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const NAME = { claude: 'Claude', codex: 'Codex' };
const catLabel = Object.fromEntries(RUBRIC.categories.map((c) => [c.key, c.label]));
const pageById = Object.fromEntries(man.pages.map((p) => [p.id, p]));
const pagePath = (id) => (id === 'site' ? 'Whole site' : (() => { const u = new URL(pageById[id].url); const q = u.search ? decodeURIComponent(u.search).slice(0, 48) : ''; return u.pathname === '/' && !q ? 'Home' : u.pathname + q; })());

// ---------- images ----------
const images = {}; let imgBytes = 0;
function img(rel) {
  if (!rel) return null;
  const abs = path.join(run, rel);
  if (!fs.existsSync(abs)) return null;
  if (!embed) return { src: rel.split('/').map(encodeURIComponent).join('/') };
  if (!images[rel]) { const b = fs.readFileSync(abs); imgBytes += b.length; images[rel] = `data:image/jpeg;base64,${b.toString('base64')}`; }
  return { key: rel };
}
const imgTag = (rel, alt, cls = '') => {
  const i = img(rel);
  if (!i) return '';
  return i.src ? `<img class="${cls}" loading="lazy" src="${esc(i.src)}" alt="${esc(alt)}">` : `<img class="${cls} lazy" data-k="${esc(i.key)}" alt="${esc(alt)}">`;
};

// ---------- data ----------
const live = led.items.filter((i) => i.status !== 'dropped');
const dropped = led.items.filter((i) => i.status === 'dropped');
const SEV = RUBRIC.severities;
const bySev = Object.fromEntries(SEV.map((s) => [s, live.filter((i) => i.severity === s).length]));
const both = live.filter((i) => i.found_by.length === 2).length;
const split = live.filter((i) => i.status === 'split').length;
const debated = led.items.filter((i) => i.thread.some((t) => t.who !== 'kiln')).length;
const changed = led.items.filter((i) => i.thread.some((t) => ['amend', 'dispute'].includes(t.stance))).length;

function statusLine(i) {
  if (i.status === 'split') return 'Split decision';
  if (i.found_by.length === 2 && i.resolved_in === 0) return 'Found independently by both';
  if (i.found_by.length === 2) return `Found by both; severity settled in round ${i.resolved_in}`;
  const a = NAME[i.found_by[0]], b = NAME[i.found_by[0] === 'claude' ? 'codex' : 'claude'];
  return i.resolved_in === 1 ? `Found by ${a}, confirmed by ${b}` : `Found by ${a}, agreed after debate (round ${i.resolved_in})`;
}
const STANCE = { agree: 'agrees', amend: 'proposes a change', dispute: 'disputes it', concede: 'concedes', rebut: 'holds their position', maintain: 'still disagrees', note: 'note' };

function issueCard(i) {
  const pages = i.pages.map((p) => `<span class="chip">${esc(pagePath(p))}</span>`).join('');
  const thread = i.thread.map((t) => `<li><b>${t.who === 'kiln' ? 'Kiln' : `Round ${t.round} · ${NAME[t.who]} ${STANCE[t.stance] || t.stance}`}</b> ${esc(t.text)}${t.proposes ? ` <span class="prop">Proposed: ${esc(Object.entries(t.proposes).map(([k, v]) => `${k} → ${v}`).join('; '))}</span>` : ''}</li>`).join('');
  const shot = i.shot ? imgTag(i.shot, `Evidence for ${i.id}`, 'shot') : '';
  return `<article class="issue sev-${i.severity}" id="${i.id}" data-sev="${i.severity}" data-cat="${i.category}" data-status="${i.status === 'split' ? 'split' : i.found_by.length === 2 ? 'both' : 'one'}" data-pages="${esc(i.pages.join(' '))}" data-text="${esc(`${i.id} ${i.title} ${i.detail} ${i.fix}`.toLowerCase())}">
  <div class="issue-head"><span class="sev">${cap(i.severity)}</span><h3>${esc(i.title)}</h3><a class="iid" href="#${i.id}">${i.id}</a></div>
  <div class="issue-meta"><span>${esc(catLabel[i.category])}</span><span>${i.viewport === 'both' ? 'Desktop and mobile' : cap(i.viewport)}</span>${i.section ? `<span>${esc(i.section)}</span>` : ''}<span class="st st-${i.status}">${esc(statusLine(i))}</span></div>
  <div class="issue-pages">${pages}</div>
  <p>${esc(i.detail)}</p>
  <p class="fix"><b>Fix</b> ${esc(i.fix)}</p>
  ${i.positions ? `<div class="positions">${Object.entries(i.positions).map(([w, t]) => `<div><b>${NAME[w]}</b> ${esc(t)}</div>`).join('')}</div>` : ''}
  <details><summary>Evidence${thread ? ' and discussion' : ''}</summary>
    <p class="ev">${esc(i.evidence)}</p>
    ${shot ? `<div class="shotwrap">${shot}</div>` : ''}
    ${thread ? `<ol class="thread">${thread}</ol>` : ''}
  </details>
</article>`;
}

const ring = (score, letter) => {
  const r = 86, c = 2 * Math.PI * r, off = c * (1 - (score ?? 0) / 100);
  return `<svg class="ring" viewBox="0 0 200 200" role="img" aria-label="Grade ${esc(letter)}, ${score} out of 100"><circle cx="100" cy="100" r="${r}" class="ring-bg"/><circle cx="100" cy="100" r="${r}" class="ring-fg" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 100 100)"/><text x="100" y="108" class="ring-letter" text-anchor="middle">${esc(letter)}</text><text x="100" y="142" class="ring-score" text-anchor="middle">${score} / 100</text></svg>`;
};

const catRows = grades.categories.map((c) => `<details class="cat"><summary>
    <span class="cat-name">${esc(c.label)}<small>${c.weight}% of grade${c.split ? ' · reviewers still apart' : c.reconciled ? ' · reconciled' : ''}</small></span>
    <span class="bar"><span class="fill band-${c.score >= 90 ? 'a' : c.score >= 80 ? 'b' : c.score >= 70 ? 'c' : c.score >= 60 ? 'd' : 'f'}" style="width:${c.score}%"></span><i class="tick tc" style="left:${c.claude}%" title="Claude ${c.claude}"></i><i class="tick tx" style="left:${c.codex}%" title="Codex ${c.codex}"></i></span>
    <span class="cat-score">${c.score}</span></summary>
    <div class="cat-body"><div><b>Claude · ${c.claude}${c.first.claude !== c.claude ? ` (first scored ${c.first.claude})` : ''}</b><p>${esc(c.rationale.claude)}</p></div><div><b>Codex · ${c.codex}${c.first.codex !== c.codex ? ` (first scored ${c.first.codex})` : ''}</b><p>${esc(c.rationale.codex)}</p></div></div>
  </details>`).join('');

const home = man.pages[0];
const fiCol = (who) => {
  const f = fi[who];
  if (!f) return `<div class="fi-col"><h4>${NAME[who]}</h4><p class="muted">Not recorded.</p></div>`;
  return `<div class="fi-col"><h4>${NAME[who]} <span class="pill pill-${f.clarity === 'clear' ? 'ok' : f.clarity === 'unclear' ? 'bad' : 'mid'}">${esc(f.clarity)}</span></h4>
    <dl><dt>What is it?</dt><dd>${esc(f.what_is_it)}</dd><dt>Who is it for?</dt><dd>${esc(f.who_is_it_for)}</dd><dt>What should I do next?</dt><dd>${esc(f.what_to_do_next)}</dd>${f.mobile_differs ? `<dt>On a phone</dt><dd>${esc(f.mobile_differs)}</dd>` : ''}</dl><p>${esc(f.notes)}</p></div>`;
};

const topFixes = grades.topFixes.map((t) => {
  const i = led.items.find((x) => x.id === t.id);
  if (!i) return '';
  return `<li><a href="#${i.id}" class="jump"><span class="sev sev-${i.severity}-b">${cap(i.severity)}</span><b>${esc(i.title)}</b></a><p>${esc(i.fix)}</p><small>${esc(Object.entries(t.why).map(([w, y]) => `${NAME[w]}: ${y}`).join(' '))}${t.by.length === 2 ? ' · picked by both reviewers' : ''}</small></li>`;
}).join('');

const strengths = (who) => (grades.strengths[who] || []).map((s) => `<li>${esc(s)}</li>`).join('');

const pageCards = man.pages.map((p) => {
  const mine = live.filter((i) => i.pages.includes(p.id));
  const counts = SEV.map((s) => [s, mine.filter((i) => i.severity === s).length]).filter(([, n]) => n);
  const f = p.facts;
  const fact = (label, v, bad) => (v == null ? '' : `<span class="fact${bad ? ' bad' : ''}"><b>${esc(v)}</b>${esc(label)}</span>`);
  return `<article class="page" id="page-${p.id}">
    <div class="page-shots"><div class="frame desk">${imgTag(p.images.thumb.desktop, `${pagePath(p.id)} on desktop`)}</div><div class="frame phone">${imgTag(p.images.thumb.mobile, `${pagePath(p.id)} on a phone`)}</div></div>
    <div class="page-info"><h3>${esc(pagePath(p.id))}</h3><a class="url" href="${esc(p.url)}" rel="noopener">${esc(p.url)}</a><p class="muted">${esc(p.title)}</p>
      <div class="facts">${fact(' ms to main content', f.lcp, f.lcp > 2500)}${fact(' ms on a slow phone', f.lcpThrottled, f.lcpThrottled > 4000)}${fact(' KB', f.transferKb, f.transferKb > 3000)}${fact(' layout shift', f.cls, f.cls > 0.1)}${fact(' accessibility rule failures', f.a11yViolations, f.a11yViolations > 0)}${fact(' script errors', f.consoleErrors, f.consoleErrors > 0)}${fact(' broken links', f.brokenLinks, f.brokenLinks > 0)}${f.mobileOverflowPx ? fact(' px sideways scroll on mobile', f.mobileOverflowPx, true) : ''}</div>
      <div class="page-issues">${counts.length ? counts.map(([s, n]) => `<span class="sev sev-${s}-b">${n} ${s}</span>`).join('') : '<span class="muted">No page-specific issues</span>'}${mine.length ? `<button class="link" data-filter-page="${p.id}">Show these ${mine.length}</button>` : ''}</div>
      <div class="page-links">${p.images.full.desktop ? `<a href="${esc(p.images.full.desktop)}">Full desktop screenshot</a>` : ''}${p.images.full.mobile ? `<a href="${esc(p.images.full.mobile)}">Full mobile screenshot</a>` : ''}${p.images.video ? `<a href="${esc(p.images.video)}">Session video</a>` : ''}<a href="${esc(p.files.digest)}">Measurements</a></div>
      ${p.warnings.length ? `<details class="gaps"><summary>${p.warnings.length} thing(s) the probe could not check here</summary><ul>${p.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
    </div></article>`;
}).join('');

const s = man.site;
// ---------- design system ----------
const designSection = (() => {
  const D = s.design; if (!D) return '';
  const pg = (str) => esc(String(str).replace(/\bp\d\d\b/g, (id) => (pageById[id] ? pagePath(id) : id)));
  const t = D.tokens, sw = (c) => `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;border:1px solid var(--line);background:${esc(c)};vertical-align:-1px"></span> <code>${esc(c)}</code>`;
  const facts = [];
  facts.push(t.usable ? `<p><b>Design tokens.</b> The site declares ${t.colourCount} colour and ${t.lengthCount} size variables. ${t.colourOnTokenPct}% of colour uses match one exactly${t.lengthOnTokenPct ? `; font sizes ${t.lengthOnTokenPct.fontSizes}%, spacing ${t.lengthOnTokenPct.spacing}%, corner radii ${t.lengthOnTokenPct.radii}%` : ''}.</p>` : `<p><b>Design tokens.</b> The site declares too few CSS variables to check against (${t.colourCount} colours, ${t.lengthCount} sizes), so the scales below are inferred from what is used.</p>`);
  const off = (t.offTokenColours || []).filter((o) => o.distance < 8);
  if (off.length) facts.push(`<p><b>Colours that miss a token.</b></p><ul class="plain">${off.map((o) => `<li>${sw(o.value)} ${esc(o.kind)}, ${o.uses} use(s) on ${pg(o.pages)}: near <code>${esc(o.nearest)}</code> ${sw(o.nearestValue)}</li>`).join('')}</ul>`);
  if (D.nearDuplicateColours.length) facts.push(`<p><b>Near-duplicate colours.</b></p><ul class="plain">${D.nearDuplicateColours.slice(0, 8).map((n) => `<li>${sw(n.main)} (${n.mainUses} uses) and ${sw(n.stray)} (${n.strayUses} uses, ${pg(n.strayPages)}), ${esc(n.kind)}</li>`).join('')}</ul>`);
  facts.push(`<p><b>Type scale.</b> ${D.typeScale.length} sizes: ${D.typeScale.map((x) => `${x.px}px`).join(', ')}.${D.offScaleSizes.length ? ` Strays: ${D.offScaleSizes.map((x) => `${x.px}px beside ${x.near.join('/')}px (${pg(x.pageIds)})`).join('; ')}.` : ''}</p>`);
  facts.push(`<p><b>Spacing.</b> ${D.spacing.distinct} distinct values; ${D.spacing.base ? `${D.spacing.onBasePct}% sit on a ${D.spacing.base}px grid` : `no consistent base unit (${D.spacing.onBasePct}% are multiples of 4px)`}.${D.spacing.off.length ? ` Most used off-grid values: ${D.spacing.off.slice(0, 6).map((o) => `${o.px}px ×${o.uses}`).join(', ')}.` : ''} <b>Corner radii:</b> ${D.radii.slice(0, 8).map((r) => esc(r.value)).join(', ')}${D.nearDuplicateRadii.length ? ` (near-duplicates: ${esc(D.nearDuplicateRadii.slice(0, 3).join('; '))})` : ''}. <b>Shadows:</b> ${D.shadowCount}.</p>`);
  const order = ['h1', 'h2', 'h3', 'h4', 'body text', 'nav link', 'text link', 'filled button', 'outline button', 'tinted button', 'form field', 'card', 'icon', 'image', 'section'];
  const rows = order.filter((r) => D.roles[r]).map((role) => { const r = D.roles[role]; return `<tr><td><b>${esc(role)}</b></td><td style="white-space:nowrap">${r.distinct === 1 ? 'Consistent' : `${r.distinct} styles`}</td><td>${r.styles.map((x) => `<div><b>${x.letter}</b> ×${x.uses} · ${pg(x.pages)}: ${esc(x.differs ? (x.differs.join('; ') || 'same values') : x.key)}</div>`).join('')}${r.distinct > r.styles.length ? `<div>…and ${r.distinct - r.styles.length} more</div>` : ''}</td></tr>`; }).join('');
  const sheets = (s.componentSheets || []).map((c) => `<p class="ev">${esc(c.what)}</p><div class="shotwrap">${imgTag(c.file, c.what)}</div>`).join('');
  return `<section id="design"><h2>Design system</h2><p class="lede">Measured on desktop across every probed page. A is the most widespread style for each role; later letters list only what differs from A. These are measurements, not verdicts: the issues the reviewers drew from them are in the list above under Consistency.</p><div class="card pad">${facts.join('')}
  <details><summary>Same role across pages</summary><table><tr><th>Role</th><th>Result</th><th>Styles</th></tr>${rows}</table></details>
  ${sheets ? `<details><summary>Component sheets</summary>${sheets}</details>` : ''}</div></section>`;
})();
const broken = s.links.broken.slice(0, 40).map((b) => `<tr><td>${esc(b.status || b.error)}</td><td><a href="${esc(b.href)}" rel="noopener">${esc(b.href)}</a></td><td>${esc(new URL(b.foundOn).pathname)}</td></tr>`).join('');
const droppedList = dropped.map((i) => `<li><b>${esc(i.title)}</b> <span class="muted">(${NAME[i.found_by[0]]}, ${i.severity}, ${esc(pagePath(i.pages[0]))})</span><br>${esc(i.thread.filter((t) => t.who !== 'kiln').map((t) => `${NAME[t.who]} ${STANCE[t.stance]}: ${t.text}`).join(' → '))}</li>`).join('');
const host = new URL(man.origin).host.replace(/^www\./, '');
const date = new Date(man.finishedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const opt = (v, l) => `<option value="${esc(v)}">${esc(l)}</option>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kiln report · ${esc(host)} · ${esc(grades.letter)}</title>
<style>
:root{--bg:#f6f1ea;--card:#fffdf9;--ink:#221d18;--muted:#6f655b;--line:#e3d9cc;--clay:#b4532a;--clay-soft:#f3e2d6;--crit:#b3261e;--major:#c2560c;--minor:#96700a;--polish:#4b6584;--ok:#2f6f4f;--shadow:0 1px 2px rgba(60,40,20,.06),0 8px 24px rgba(60,40,20,.06);--serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#171411;--card:#211d19;--ink:#f0e9e0;--muted:#a3978a;--line:#39322b;--clay:#e0845a;--clay-soft:#3a271d;--crit:#f2776f;--major:#f0965a;--minor:#d9b24a;--polish:#8fb0d6;--ok:#6fbf95;--shadow:0 1px 2px rgba(0,0,0,.4)}}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
a{color:var(--clay)}img{max-width:100%;display:block}.muted{color:var(--muted)}
.wrap{max-width:1120px;margin:0 auto;padding:0 20px}
header.top{padding:28px 0 0}.brand{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;font-size:13px;color:var(--muted);letter-spacing:.04em;text-transform:uppercase}.brand b{color:var(--clay);letter-spacing:.14em}
h1,h2,h3,h4{font-family:var(--serif);font-weight:600;line-height:1.2;margin:0;text-wrap:balance}
h1{font-size:clamp(30px,5vw,46px);margin:10px 0 6px;overflow-wrap:anywhere}h2{font-size:28px;margin:0 0 6px}h3{font-size:19px}
section{padding:44px 0 0}.lede{color:var(--muted);margin:0 0 20px;max-width:70ch}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}
.hero{display:grid;grid-template-columns:230px 1fr;gap:32px;padding:28px;align-items:center;margin-top:22px}
.ring{width:210px;height:210px}.ring-bg{fill:none;stroke:var(--line);stroke-width:12}.ring-fg{fill:none;stroke:var(--clay);stroke-width:12;stroke-linecap:round}.ring-letter{font:600 74px var(--serif);fill:var(--ink)}.ring-score{font:500 15px var(--sans);fill:var(--muted)}
.verdicts{display:grid;grid-template-columns:1fr 1fr;gap:18px}.verdicts h4{font:600 12px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}.verdicts p{margin:0}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}.stat{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:8px 12px;font-size:13px;color:var(--muted)}.stat b{display:block;font:600 20px var(--serif);color:var(--ink)}
.sev{display:inline-block;font:600 11px var(--sans);letter-spacing:.06em;text-transform:uppercase;padding:3px 8px;border-radius:999px;color:#fff;white-space:nowrap}
.sev-critical .sev,.sev-critical-b{background:var(--crit)}.sev-major .sev,.sev-major-b{background:var(--major)}.sev-minor .sev,.sev-minor-b{background:var(--minor)}.sev-polish .sev,.sev-polish-b{background:var(--polish)}
@media (prefers-color-scheme:dark){.sev{color:#171411}}
.cat{border-bottom:1px solid var(--line)}.cat:last-child{border:0}.cat summary{display:grid;grid-template-columns:minmax(180px,1.1fr) 2fr 44px;gap:16px;align-items:center;padding:14px 22px;cursor:pointer;list-style:none}.cat summary::-webkit-details-marker{display:none}
.cat-name{font-weight:600}.cat-name small{display:block;font-weight:400;color:var(--muted);font-size:12px}.cat-score{font:600 22px var(--serif);text-align:right;font-variant-numeric:tabular-nums}
.bar{position:relative;height:10px;background:var(--line);border-radius:999px}.fill{position:absolute;inset:0 auto 0 0;border-radius:999px}.band-a{background:var(--ok)}.band-b{background:#6f9a52}.band-c{background:var(--minor)}.band-d{background:var(--major)}.band-f{background:var(--crit)}
.tick{position:absolute;top:-5px;width:3px;height:20px;border-radius:2px;transform:translateX(-50%)}.tc{background:var(--ink)}.tx{background:var(--clay)}
.cat-body{display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:0 22px 18px;font-size:14px}.cat-body p{margin:4px 0 0;color:var(--muted)}
.legend{font-size:12px;color:var(--muted);padding:10px 22px;display:flex;gap:16px;border-top:1px solid var(--line)}.legend i{display:inline-block;width:3px;height:12px;border-radius:2px;margin-right:5px;vertical-align:-2px}
.fi{display:grid;grid-template-columns:1.25fr 1fr;gap:24px;padding:22px}.fi-shots{display:grid;grid-template-columns:1fr 30%;gap:12px;align-items:start}.fi-shots img{border:1px solid var(--line);border-radius:8px}
.fi-cols{display:grid;gap:18px}.fi-col h4{font:600 15px var(--sans);margin-bottom:6px}.fi-col dl{margin:0;font-size:14px}.fi-col dt{color:var(--muted);font-size:12px;margin-top:6px}.fi-col dd{margin:0}.fi-col p{font-size:14px;color:var(--muted);margin:8px 0 0}
.pill{font:600 11px var(--sans);padding:2px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:.05em;vertical-align:2px}.pill-ok{background:var(--ok);color:#fff}.pill-mid{background:var(--minor);color:#fff}.pill-bad{background:var(--crit);color:#fff}
.two{display:grid;grid-template-columns:1.4fr 1fr;gap:20px;align-items:start}.pad{padding:22px}
ol.fixes{margin:0;padding:0;list-style:none;counter-reset:f}ol.fixes li{counter-increment:f;position:relative;padding:14px 0 14px 44px;border-bottom:1px solid var(--line)}ol.fixes li:last-child{border:0}ol.fixes li::before{content:counter(f);position:absolute;left:0;top:12px;width:30px;height:30px;border-radius:50%;background:var(--clay-soft);color:var(--clay);font:600 15px/30px var(--serif);text-align:center}
ol.fixes a{text-decoration:none;color:var(--ink);display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}ol.fixes a:hover b{text-decoration:underline}ol.fixes p{margin:4px 0;font-size:14px}ol.fixes small{color:var(--muted)}
ul.plain{margin:6px 0 0;padding-left:18px;font-size:14px}ul.plain li{margin:4px 0}
.filters{position:sticky;top:0;z-index:5;background:var(--bg);padding:12px 0;display:flex;flex-wrap:wrap;gap:8px;align-items:center;border-bottom:1px solid var(--line)}
.filters button.f,.filters select,.filters input{font:500 13px var(--sans);padding:7px 12px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--ink);min-height:36px}.filters button.f{cursor:pointer}.filters button.f[aria-pressed=true]{background:var(--ink);color:var(--bg);border-color:var(--ink)}.filters input{flex:1;min-width:150px}
#count{font-size:13px;color:var(--muted);margin-left:auto}
.issues{display:grid;gap:12px;margin-top:16px}.issue{background:var(--card);border:1px solid var(--line);border-left:5px solid var(--polish);border-radius:10px;padding:16px 18px}.issue.sev-critical{border-left-color:var(--crit)}.issue.sev-major{border-left-color:var(--major)}.issue.sev-minor{border-left-color:var(--minor)}
.issue[hidden]{display:none}.issue:target{outline:2px solid var(--clay);outline-offset:2px}
.issue-head{display:flex;gap:10px;align-items:baseline}.issue-head h3{flex:1;font-size:18px}.iid{font:500 12px ui-monospace,Menlo,monospace;color:var(--muted);text-decoration:none}
.issue-meta{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12.5px;color:var(--muted);margin:6px 0}.st-split{color:var(--crit);font-weight:600}.st-agreed{color:var(--ok)}
.chip{display:inline-block;font-size:12px;padding:1px 8px;border-radius:6px;background:var(--bg);border:1px solid var(--line);margin:0 4px 4px 0}
.issue p{margin:8px 0;max-width:80ch}.fix{background:var(--clay-soft);border-radius:8px;padding:8px 12px}.fix b{font:600 11px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--clay);margin-right:6px}
.positions{display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:14px;margin:8px 0}.positions div{border:1px dashed var(--line);border-radius:8px;padding:8px 10px}
details summary{cursor:pointer;font-size:13px;color:var(--muted)}.ev{font-size:14px;color:var(--muted)}.shotwrap{max-height:520px;overflow:auto;border:1px solid var(--line);border-radius:8px;background:#fff}
.thread{font-size:14px;padding-left:18px}.thread li{margin:6px 0}.prop{display:block;color:var(--muted);font-size:13px}
.pages{display:grid;gap:14px}.page{display:grid;grid-template-columns:330px 1fr;gap:20px;padding:16px;background:var(--card);border:1px solid var(--line);border-radius:12px}
.page-shots{display:grid;grid-template-columns:1fr 72px;gap:8px;align-items:start}.frame{max-height:250px;overflow:auto;border:1px solid var(--line);border-radius:6px;background:#fff}
.url{font-size:13px;overflow-wrap:anywhere}.facts{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.fact{font-size:12.5px;color:var(--muted);border:1px solid var(--line);border-radius:6px;padding:2px 8px}.fact b{color:var(--ink);font-variant-numeric:tabular-nums}.fact.bad b{color:var(--crit)}
.page-issues{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.page-links{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:13px;margin-top:10px}.gaps{margin-top:8px}.gaps ul{font-size:13px;color:var(--muted)}
button.link{background:none;border:0;color:var(--clay);font:500 13px var(--sans);cursor:pointer;text-decoration:underline;padding:6px 4px}
table{width:100%;border-collapse:collapse;font-size:13.5px}td,th{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}th{color:var(--muted);font-weight:500}
footer{padding:40px 0 60px;color:var(--muted);font-size:13px}
:focus-visible{outline:2px solid var(--clay);outline-offset:2px}
@media (max-width:820px){.hero,.fi,.two,.page,.verdicts,.cat-body,.positions{grid-template-columns:1fr}.ring{margin:0 auto}.cat summary{grid-template-columns:1fr 44px}.cat summary .bar{grid-column:1/-1;order:3}.page-shots{max-width:420px}#count{margin-left:0;width:100%}}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
@media print{.filters{position:static}details>*{display:block}.frame,.shotwrap{max-height:none}}
</style></head><body>
<header class="top"><div class="wrap">
  <div class="brand"><b>Kiln report</b><span>${esc(date)} · ${man.pages.length} pages · reviewed by Claude and Codex</span></div>
  <h1>${esc(host)}</h1>
  <div class="card hero">${ring(grades.score, grades.letter)}
    <div><div class="verdicts"><div><h4>Claude · ${esc(grades.claude.letter)} (${grades.claude.score})</h4><p>${esc(grades.verdict.claude)}</p></div><div><h4>Codex · ${esc(grades.codex.letter)} (${grades.codex.score})</h4><p>${esc(grades.verdict.codex)}</p></div></div>
      <div class="stats">${SEV.map((x) => `<div class="stat"><b>${bySev[x]}</b>${x}</div>`).join('')}<div class="stat"><b>${both}</b>found by both</div><div class="stat"><b>${changed}</b>challenged in debate</div><div class="stat"><b>${dropped.length}</b>withdrawn</div><div class="stat"><b>${split}</b>split decisions</div></div>
    </div></div>
</div></header>
<main class="wrap">
<section><h2>Scorecard</h2><p class="lede">Each reviewer scored every category on its own. Where they were more than ${RUBRIC.reconcileGap} points apart they saw each other's reasoning and scored again. The final score is the average of the two.</p>
  <div class="card">${catRows}<div class="legend"><span><i style="background:var(--ink)"></i>Claude's score</span><span><i style="background:var(--clay)"></i>Codex's score</span><span>Select a row for the reasoning</span></div></div></section>
<section><h2>First impression</h2><p class="lede">Each reviewer was shown only the first screen of the home page and asked what a first-time visitor would take from it.</p>
  <div class="card fi"><div class="fi-shots">${imgTag(home.images.aboveFold.desktop, 'Home page first screen on desktop')}${imgTag(home.images.aboveFold.mobile, 'Home page first screen on a phone')}</div><div class="fi-cols">${fiCol('claude')}${fiCol('codex')}</div></div></section>
<section><div class="two"><div><h2>Fix these first</h2><p class="lede">The changes both reviewers think are worth the most.</p><div class="card pad"><ol class="fixes">${topFixes || '<li>No top fixes were nominated.</li>'}</ol></div></div>
  <div><h2>What works</h2><p class="lede">Worth keeping as you change things.</p><div class="card pad"><b>Claude</b><ul class="plain">${strengths('claude')}</ul><br><b>Codex</b><ul class="plain">${strengths('codex')}</ul></div></div></div></section>
<section id="issues"><h2>All issues</h2><p class="lede">${live.length} issues made it into the report. ${both} were found by both reviewers independently; ${debated} were argued over, and ${dropped.length} were withdrawn as a result.</p>
  <div class="filters" role="group" aria-label="Filter issues">${SEV.map((x) => `<button class="f" data-sev="${x}" aria-pressed="false">${cap(x)} ${bySev[x]}</button>`).join('')}
    <select id="f-cat" aria-label="Category">${opt('', 'All categories')}${RUBRIC.categories.map((c) => opt(c.key, c.label)).join('')}</select>
    <select id="f-page" aria-label="Page">${opt('', 'All pages')}${opt('site', 'Whole site')}${man.pages.map((p) => opt(p.id, pagePath(p.id))).join('')}</select>
    <select id="f-status" aria-label="Agreement">${opt('', 'Any agreement')}${opt('both', 'Found by both')}${opt('one', 'Found by one, then agreed')}${opt('split', 'Split decisions')}</select>
    <input id="f-q" type="search" placeholder="Search issues" aria-label="Search issues"><span id="count" aria-live="polite"></span></div>
  <div class="issues">${live.map(issueCard).join('\n')}</div></section>
<section id="pages"><h2>Pages</h2><p class="lede">Every page that was probed, as it looked on a 1440px desktop and a 390px phone. Scroll inside a screenshot to see the whole page.</p><div class="pages">${pageCards}</div></section>
${designSection}
<section><h2>Site-wide checks</h2><div class="card pad">
  <p><b>Links.</b> ${s.links.checked} checked, ${s.links.broken.length} broken${s.links.blockedByBotProtection ? `, ${s.links.blockedByBotProtection} could not be checked because the destination refuses automated visits` : ''}.</p>
  ${broken ? `<table><tr><th>Result</th><th>Link</th><th>Found on</th></tr>${broken}</table>` : ''}
  ${s.notFound ? `<p><b>Missing-page handling.</b> A made-up address returned HTTP ${esc(s.notFound.status)}${s.notFound.status === 200 ? ', which tells search engines the page exists' : ''}; it ${s.notFound.hasHomeLink ? 'links' : 'does not link'} back to the home page.</p><div class="shotwrap" style="max-width:560px">${imgTag(s.notFound.shot, 'The page shown for an address that does not exist')}</div>` : ''}
  <p><b>Legal pages.</b> Privacy policy: ${s.legal.privacy ? 'linked' : 'not found'}. Terms: ${s.legal.terms ? 'linked' : 'not found'}. <b>Sitemap:</b> ${s.sitemapFound ? 'found' : 'not found'}. <b>Built with:</b> ${esc(s.tech.join(', ') || 'not identified')}.</p></div></section>
<section><h2>How this was produced</h2><div class="card pad">
  <p>Kiln loaded each page in ${esc(man.browser)}, scrolled it, exercised its menus, forms and hover states, recorded its motion and measured it. Claude and Codex then audited the same screenshots and measurements without seeing each other's work. Their lists were merged; every issue only one of them raised went to the other for review, with up to three rounds of argument. Issues they could not settle are shown as split decisions.</p>
  <p><b>What this run did not cover</b></p><ul class="plain">${man.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}${man.discovery.skipped.length ? `<li>Pages left out: ${esc(man.discovery.skipped.slice(0, 30).map((u) => new URL(u).pathname).join(', '))}${man.discovery.skipped.length > 30 ? ' …' : ''}</li>` : ''}</ul>
  ${droppedList ? `<details style="margin-top:14px"><summary>${dropped.length} issue(s) withdrawn during the debate</summary><ul class="plain">${droppedList}</ul></details>` : ''}</div></section>
</main>
<footer><div class="wrap">Generated by kiln · ${esc(man.url)} · run ${esc(path.basename(run))}</div></footer>
<script type="application/json" id="imgs">${JSON.stringify(images).replace(/</g, '\\u003c')}</script>
<script>
(function(){
  var IM=JSON.parse(document.getElementById('imgs').textContent||'{}');
  var io=('IntersectionObserver' in window)?new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){load(e.target);io.unobserve(e.target);}});},{rootMargin:'400px'}):null;
  function load(el){var k=el.getAttribute('data-k');if(k&&IM[k]){el.src=IM[k];el.classList.remove('lazy');}}
  document.querySelectorAll('img.lazy').forEach(function(el){if(el.closest('details')||!io)return;io.observe(el);});
  if(!io)document.querySelectorAll('img.lazy').forEach(load);
  document.addEventListener('toggle',function(e){if(e.target.open)e.target.querySelectorAll('img.lazy').forEach(load);},true);
  window.addEventListener('beforeprint',function(){document.querySelectorAll('img.lazy').forEach(load);});
  var sev=new Set(),cards=[].slice.call(document.querySelectorAll('.issue')),cat=document.getElementById('f-cat'),pg=document.getElementById('f-page'),st=document.getElementById('f-status'),q=document.getElementById('f-q'),count=document.getElementById('count');
  function apply(){var n=0,t=q.value.trim().toLowerCase();cards.forEach(function(c){var ok=(!sev.size||sev.has(c.dataset.sev))&&(!cat.value||c.dataset.cat===cat.value)&&(!pg.value||c.dataset.pages.split(' ').indexOf(pg.value)>-1)&&(!st.value||c.dataset.status===st.value)&&(!t||c.dataset.text.indexOf(t)>-1);c.hidden=!ok;if(ok)n++;});count.textContent='Showing '+n+' of '+cards.length;}
  document.querySelectorAll('button.f').forEach(function(b){b.addEventListener('click',function(){var s=b.dataset.sev;if(sev.has(s)){sev.delete(s);b.setAttribute('aria-pressed','false');}else{sev.add(s);b.setAttribute('aria-pressed','true');}apply();});});
  [cat,pg,st].forEach(function(e){e.addEventListener('change',apply);});q.addEventListener('input',apply);
  document.querySelectorAll('[data-filter-page]').forEach(function(b){b.addEventListener('click',function(){pg.value=b.getAttribute('data-filter-page');apply();document.getElementById('issues').scrollIntoView();});});
  document.querySelectorAll('a.jump').forEach(function(a){a.addEventListener('click',function(){var el=document.querySelector(a.getAttribute('href'));if(el&&el.hidden){sev.clear();document.querySelectorAll('button.f').forEach(function(b){b.setAttribute('aria-pressed','false');});cat.value=pg.value=st.value=q.value='';apply();}});});
  apply();
})();
</script>
</body></html>`;

const outFile = path.join(run, 'report.html');
fs.writeFileSync(outFile, html);
console.log(JSON.stringify({ ok: true, report: outFile, sizeMb: +(Buffer.byteLength(html) / 1048576).toFixed(1), issues: live.length, images: Object.keys(images).length, grade: `${grades.letter} (${grades.score})` }, null, 2));
