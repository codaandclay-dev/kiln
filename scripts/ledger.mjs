#!/usr/bin/env node
// kiln ledger: the bookkeeping for findings, the debate and the grade.
// Rules live here, not in a prompt, so neither reviewer can bend them.
//
//   ledger.mjs collect --run DIR --who claude|codex     merge findings/<who>-batch-*.json -> findings/<who>.json
//   ledger.mjs init    --run DIR                        ledger-draft.json -> ledger.json (checks nothing was dropped)
//   ledger.mjs todo    --run DIR --round N --who W      items W must respond to this round (JSON on stdout)
//   ledger.mjs apply   --run DIR --round N              apply debate/round-N-{claude,codex}.json
//   ledger.mjs status  --run DIR
//   ledger.mjs grade   --run DIR [--finalize]           compare grades, list gaps, write grades.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readJson, writeJson, KILN_ROOT } from './lib/util.mjs';

export const RUBRIC = readJson(path.join(KILN_ROOT, 'schemas', 'rubric.json'));
const CATS = RUBRIC.categories.map((c) => c.key);
const SEV = RUBRIC.severities;
const OTHER = { claude: 'codex', codex: 'claude' };
const PREFIX = { claude: 'C', codex: 'X' };
const die = (msg) => { console.error(`kiln ledger: ${msg}`); process.exit(1); };
const out = (o) => console.log(JSON.stringify(o, null, 2));

export function loadManifest(run) { return readJson(path.join(run, 'manifest.json')); }

/** Normalise one raw finding; returns [finding, problems[]]. */
function cleanFinding(f, man, run) {
  const problems = [];
  const ids = new Set(man.pages.map((p) => p.id));
  const g = { ...f };
  for (const k of ['title', 'detail', 'evidence', 'fix', 'section', 'shot']) g[k] = typeof g[k] === 'string' ? g[k].trim() : '';
  if (!g.title) return [null, ['missing title']];
  if (g.page !== 'site' && !ids.has(g.page)) {
    const bySlug = man.pages.find((p) => p.slug === g.page || p.url === g.page);
    if (bySlug) g.page = bySlug.id; else { problems.push(`unknown page "${g.page}" -> site`); g.page = 'site'; }
  }
  g.also_on = [...new Set((Array.isArray(g.also_on) ? g.also_on : []).filter((x) => ids.has(x) && x !== g.page))];
  if (!CATS.includes(g.category)) { problems.push(`unknown category "${g.category}" -> visual`); g.category = 'visual'; }
  if (!SEV.includes(g.severity)) { problems.push(`unknown severity "${g.severity}" -> minor`); g.severity = 'minor'; }
  if (!['desktop', 'mobile', 'both'].includes(g.viewport)) g.viewport = 'both';
  if (g.shot && !fs.existsSync(path.join(run, g.shot))) { problems.push(`shot not found: ${g.shot}`); g.shot = ''; }
  return [g, problems];
}

function collect(run, who) {
  const man = loadManifest(run);
  const dir = path.join(run, 'findings');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => new RegExp(`^${who}-batch-\\d+\\.json$`).test(f)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0])) : [];
  if (!files.length) die(`no findings/${who}-batch-*.json files in ${run}`);
  const expected = man.batches.length;
  const have = new Set(files.map((f) => +f.match(/(\d+)\.json$/)[1]));
  const missing = Array.from({ length: expected }, (_, i) => i + 1).filter((n) => !have.has(n));
  const findings = [], problems = [];
  for (const f of files) {
    const raw = readJson(path.join(dir, f));
    for (const item of raw.findings || []) {
      const [g, p] = cleanFinding(item, man, run);
      if (p.length) problems.push(`${f}: ${p.join('; ')}`);
      if (g) findings.push({ id: `${PREFIX[who]}-${String(findings.length + 1).padStart(3, '0')}`, ...g });
    }
  }
  writeJson(path.join(dir, `${who}.json`), { who, findings });
  out({ ok: true, who, findings: findings.length, batchesFound: files.length, batchesExpected: expected, missingBatches: missing, problems });
}

function init(run) {
  const man = loadManifest(run);
  const src = {};
  for (const who of ['claude', 'codex']) for (const f of readJson(path.join(run, 'findings', `${who}.json`)).findings) src[f.id] = { ...f, who };
  const draft = readJson(path.join(run, 'ledger-draft.json'));
  const used = new Map(), errors = [];
  const items = [];
  if (draft.auto_singletons) {
    // Convenience: every finding not named in a merged item becomes its own item, unchanged.
    const named = new Set((draft.items || []).flatMap((d) => d.sources || []));
    draft.items = [...(draft.items || []), ...Object.keys(src).filter((id) => !named.has(id)).map((id) => ({ sources: [id] }))];
  }
  for (const [i, d] of (draft.items || []).entries()) {
    const sources = d.sources || [];
    if (!sources.length) { errors.push(`item ${i + 1} ("${d.title}") has no sources`); continue; }
    for (const s of sources) {
      if (!src[s]) errors.push(`item ${i + 1} cites unknown source ${s}`);
      else if (used.has(s)) errors.push(`${s} is used by two ledger items (${used.get(s)} and ${i + 1})`);
      else used.set(s, i + 1);
    }
    const from = sources.map((s) => src[s]).filter(Boolean);
    if (!from.length) continue;
    const base = from[0];
    const [g, p] = cleanFinding({ ...base, ...Object.fromEntries(Object.entries(d).filter(([k, v]) => v !== undefined && v !== null && k !== 'sources')) }, man, run);
    if (!g) { errors.push(`item ${i + 1}: ${p.join('; ')}`); continue; }
    const pages = [...new Set([g.page, ...(Array.isArray(d.pages) ? d.pages : []), ...from.flatMap((f) => [f.page, ...(f.also_on || [])])])].filter((x) => x === 'site' || man.pages.some((pg) => pg.id === x));
    const whos = [...new Set(from.map((f) => f.who))];
    const worst = (who) => Math.min(...from.filter((f) => f.who === who).map((f) => SEV.indexOf(f.severity)));
    const item = {
      id: '', page: pages.includes('site') && pages.length === 1 ? 'site' : g.page, pages: pages.filter((x) => x !== 'site').length ? pages.filter((x) => x !== 'site') : ['site'],
      viewport: g.viewport, section: g.section, category: g.category, severity: g.severity, title: g.title, detail: g.detail, evidence: g.evidence, fix: g.fix, shot: g.shot || from.map((f) => f.shot).find(Boolean) || '',
      sources, found_by: whos, originator: whos.length === 2 ? 'both' : whos[0], status: whos.length === 2 ? 'agreed' : 'open', resolved_in: whos.length === 2 ? 0 : null, thread: [], counter: null,
    };
    if (whos.length === 2) {
      const c = worst('claude'), x = worst('codex');
      item.source_severities = { claude: SEV[c], codex: SEV[x] };
      if (Math.abs(c - x) >= 2) {
        // The reviewers agree it exists but not how bad it is: that is a disagreement, so debate it.
        Object.assign(item, { severity: SEV[c], originator: 'claude', status: 'open', resolved_in: null });
        item.thread.push({ round: 0, who: 'kiln', stance: 'note', text: `Both reviewers reported this, but Claude rated it ${SEV[c]} and Codex rated it ${SEV[x]}. Sent to debate to settle the severity.` });
      } else item.severity = SEV[Math.min(c, x)];
    }
    items.push(item);
  }
  const unused = Object.keys(src).filter((s) => !used.has(s));
  if (unused.length) errors.push(`${unused.length} findings are missing from the draft (every finding must appear in exactly one item): ${unused.join(', ')}`);
  if (errors.length) { console.error(errors.map((e) => `- ${e}`).join('\n')); die(`ledger-draft.json has ${errors.length} problem(s); fix the draft and run init again`); }
  const order = (a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity) || CATS.indexOf(a.category) - CATS.indexOf(b.category);
  items.sort(order).forEach((it, i) => { it.id = `K-${String(i + 1).padStart(3, '0')}`; });
  writeJson(path.join(run, 'ledger.json'), { run: path.basename(run), round: 0, items });
  out({ ok: true, ...counts(items), fromClaude: Object.values(src).filter((s) => s.who === 'claude').length, fromCodex: Object.values(src).filter((s) => s.who === 'codex').length });
}

const counts = (items) => ({
  items: items.length, agreed: items.filter((i) => i.status === 'agreed').length, open: items.filter((i) => i.status === 'open').length,
  split: items.filter((i) => i.status === 'split').length, dropped: items.filter((i) => i.status === 'dropped').length,
  foundByBoth: items.filter((i) => i.found_by.length === 2).length,
});

/** Whose turn is it on this item in this round? Rounds 1 and 3: the reviewer. Round 2: the originator. */
const mover = (item, round) => (round === 2 ? item.originator : OTHER[item.originator]);
const ALLOWED = { 1: ['agree', 'amend', 'dispute'], 2: ['concede', 'rebut'], 3: ['agree', 'maintain'] };

function todo(run, round, who) {
  const led = readJson(path.join(run, 'ledger.json'));
  const man = loadManifest(run);
  const slug = Object.fromEntries(man.pages.map((p) => [p.id, p]));
  const items = led.items.filter((i) => i.status === 'open' && mover(i, round) === who).map((i) => ({
    id: i.id, your_role: round === 2 ? 'this is your finding; the other reviewer objected' : 'the other reviewer\'s finding',
    pages: i.pages, digests: i.pages.filter((p) => slug[p]).map((p) => slug[p].files.digest), viewport: i.viewport, section: i.section, category: i.category,
    severity: i.severity, title: i.title, detail: i.detail, evidence: i.evidence, fix: i.fix, shot: i.shot,
    ...(i.counter ? { objection_on_the_table: i.counter } : {}), thread: i.thread,
  }));
  out({ round, who, allowed_stances: ALLOWED[round], count: items.length, items });
}

function apply(run, round) {
  if (!ALLOWED[round]) die('round must be 1, 2 or 3');
  const file = path.join(run, 'ledger.json');
  const led = readJson(file);
  if (led.round !== round - 1) die(`ledger is at round ${led.round}; cannot apply round ${round}`);
  const responses = {};
  for (const who of ['claude', 'codex']) {
    const f = path.join(run, 'debate', `round-${round}-${who}.json`);
    for (const r of fs.existsSync(f) ? readJson(f).responses || [] : []) responses[`${who}:${r.id}`] = r;
  }
  const errors = [];
  const open = led.items.filter((i) => i.status === 'open');
  for (const it of open) {
    const who = mover(it, round);
    const r = responses[`${who}:${it.id}`];
    if (!r) { errors.push(`${it.id}: no response from ${who} (expected in debate/round-${round}-${who}.json)`); continue; }
    if (!ALLOWED[round].includes(r.stance)) errors.push(`${it.id}: ${who} answered "${r.stance}" but round ${round} allows only ${ALLOWED[round].join(', ')}`);
  }
  if (errors.length) { console.error(errors.map((e) => `- ${e}`).join('\n')); die(`round ${round} is incomplete or invalid; nothing was applied`); }

  const changes = (r) => { const c = {}; for (const k of ['severity', 'title', 'detail', 'fix']) if (r[k] && (k !== 'severity' || SEV.includes(r[k]))) c[k] = r[k]; return c; };
  for (const it of open) {
    const who = mover(it, round);
    const r = responses[`${who}:${it.id}`];
    const ch = changes(r);
    it.thread.push({ round, who, stance: r.stance, text: String(r.reasoning || '').trim(), ...(Object.keys(ch).length ? { proposes: ch } : {}) });
    const settle = (status) => { it.status = status; it.resolved_in = round; };
    if (round === 1) {
      if (r.stance === 'agree') settle('agreed');
      else it.counter = r.stance === 'amend' ? { kind: 'amend', by: who, ...ch } : { kind: 'dispute', by: who };
    } else if (round === 2) {
      if (r.stance === 'concede') {
        if (it.counter?.kind === 'amend') { const { kind, by, ...c } = it.counter; Object.assign(it, c); settle('agreed'); }
        else settle('dropped');
      } else Object.assign(it, ch); // rebut, possibly with a compromise that becomes the version on the table
    } else if (r.stance === 'agree') settle('agreed');
    else {
      settle('split');
      const origin = it.originator, rev = OTHER[origin];
      it.positions = {
        [origin]: `Report it as ${it.severity}: ${it.title}`,
        [rev]: it.counter?.kind === 'amend' ? `Report it differently${it.counter.severity ? ` (as ${it.counter.severity})` : ''}${it.counter.title ? `: ${it.counter.title}` : ''}` : 'Leave it out of the report',
      };
    }
  }
  led.round = round;
  if (round === 3) for (const it of led.items.filter((i) => i.status === 'open')) { it.status = 'split'; it.resolved_in = 3; }
  writeJson(file, led);
  const c = counts(led.items);
  out({ ok: true, round, ...c, nextRound: c.open && round < 3 ? round + 1 : null, done: !c.open });
}

export function overall(scores) {
  let sum = 0, wsum = 0;
  for (const c of RUBRIC.categories) if (typeof scores[c.key] === 'number') { sum += scores[c.key] * c.weight; wsum += c.weight; }
  return wsum ? Math.round(sum / wsum * 10) / 10 : null;
}
export const letter = (score) => (score == null ? '?' : RUBRIC.letters.find(([min]) => score >= min)[1]);

function grade(run, finalize) {
  const dir = path.join(run, 'grades');
  const load = (who) => {
    const f = readJson(path.join(dir, `${who}.json`));
    const map = Object.fromEntries((f.categories || []).map((c) => [c.key, c]));
    const missing = CATS.filter((k) => typeof map[k]?.score !== 'number');
    if (missing.length) die(`grades/${who}.json is missing scores for: ${missing.join(', ')}`);
    return { ...f, map };
  };
  const G = { claude: load('claude'), codex: load('codex') };
  const finals = {};
  for (const who of ['claude', 'codex']) {
    const f = path.join(dir, `${who}-final.json`);
    finals[who] = fs.existsSync(f) ? Object.fromEntries((readJson(f).categories || []).map((c) => [c.key, c])) : {};
  }
  const gaps = RUBRIC.categories.filter((c) => Math.abs(G.claude.map[c.key].score - G.codex.map[c.key].score) > RUBRIC.reconcileGap).map((c) => ({
    key: c.key, label: c.label, claude: { score: G.claude.map[c.key].score, rationale: G.claude.map[c.key].rationale }, codex: { score: G.codex.map[c.key].score, rationale: G.codex.map[c.key].rationale },
  }));
  writeJson(path.join(dir, 'gaps.json'), { gaps });
  const reconciled = gaps.every((g) => finals.claude[g.key] && finals.codex[g.key]);
  if (gaps.length && !reconciled && !finalize) {
    out({ ok: true, needsReconcile: gaps.map((g) => g.key), gapsFile: 'grades/gaps.json', note: 'Each reviewer sees the other\'s score and rationale for these categories and writes grades/<who>-final.json; then run grade again.' });
    return;
  }
  const cats = RUBRIC.categories.map((c) => {
    const first = { claude: G.claude.map[c.key].score, codex: G.codex.map[c.key].score };
    const fin = { claude: finals.claude[c.key]?.score ?? first.claude, codex: finals.codex[c.key]?.score ?? first.codex };
    const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
    return {
      key: c.key, label: c.label, weight: c.weight, score: clamp((fin.claude + fin.codex) / 2), claude: clamp(fin.claude), codex: clamp(fin.codex),
      first, reconciled: !!(finals.claude[c.key] || finals.codex[c.key]), split: Math.abs(fin.claude - fin.codex) > RUBRIC.reconcileGap,
      rationale: { claude: finals.claude[c.key]?.rationale || G.claude.map[c.key].rationale, codex: finals.codex[c.key]?.rationale || G.codex.map[c.key].rationale },
    };
  });
  const score = overall(Object.fromEntries(cats.map((c) => [c.key, c.score])));
  const per = (who) => overall(Object.fromEntries(cats.map((c) => [c.key, c[who]])));
  const led = readJson(path.join(run, 'ledger.json'));
  const valid = new Set(led.items.filter((i) => i.status !== 'dropped').map((i) => i.id));
  // Top fixes: items either reviewer named, those named by both first, in each reviewer's order.
  const rank = new Map();
  for (const who of ['claude', 'codex']) (G[who].top_fixes || []).forEach((t, i) => {
    if (!valid.has(t.id)) return;
    const e = rank.get(t.id) || { id: t.id, by: [], pos: 0, why: {} };
    e.by.push(who); e.pos += i; e.why[who] = t.why; rank.set(t.id, e);
  });
  const topFixes = [...rank.values()].sort((a, b) => b.by.length - a.by.length || a.pos / a.by.length - b.pos / b.by.length).slice(0, 8);
  const result = {
    score, letter: letter(score), claude: { score: per('claude'), letter: letter(per('claude')) }, codex: { score: per('codex'), letter: letter(per('codex')) },
    categories: cats, verdict: { claude: G.claude.verdict || '', codex: G.codex.verdict || '' }, strengths: { claude: G.claude.strengths || [], codex: G.codex.strengths || [] }, topFixes,
  };
  writeJson(path.join(run, 'grades.json'), result);
  out({ ok: true, score, letter: result.letter, claude: result.claude, codex: result.codex, reconciledCategories: cats.filter((c) => c.reconciled).map((c) => c.key), stillSplit: cats.filter((c) => c.split).map((c) => c.key) });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest, ['finalize']);
  if (!a.run) die('--run <dir> is required');
  const run = path.resolve(a.run);
  if (cmd === 'collect') collect(run, a.who);
  else if (cmd === 'init') init(run);
  else if (cmd === 'todo') todo(run, +a.round, a.who);
  else if (cmd === 'apply') apply(run, +a.round);
  else if (cmd === 'status') { const led = readJson(path.join(run, 'ledger.json')); out({ round: led.round, ...counts(led.items) }); }
  else if (cmd === 'grade') grade(run, !!a.finalize);
  else die(`unknown command "${cmd}"`);
}
