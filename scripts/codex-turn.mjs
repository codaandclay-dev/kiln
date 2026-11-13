#!/usr/bin/env node
// kiln codex-turn: the bridge to Codex. Each subcommand builds the prompt for
// one stage, attaches the screenshots, runs `codex exec` read-only in the run
// folder, and writes Codex's structured answer to disk.
//
//   codex-turn.mjs first-impression --run DIR
//   codex-turn.mjs audit            --run DIR [--concurrency 3] [--only 2,5]
//   codex-turn.mjs debate           --run DIR --round N
//   codex-turn.mjs grade            --run DIR
//   codex-turn.mjs regrade          --run DIR
// Common: [--model ID] [--timeout-min 20]
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs, readJson, writeJson, KILN_ROOT, log, pool } from './lib/util.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
if (!cmd || !args.run) { console.error('usage: codex-turn.mjs <first-impression|audit|debate|grade|regrade> --run DIR'); process.exit(2); }
const run = path.resolve(args.run);
const TIMEOUT = (+args['timeout-min'] || 20) * 60000;
const prompt = (name) => fs.readFileSync(path.join(KILN_ROOT, 'prompts', `${name}.md`), 'utf8');
const schema = (name) => path.join(KILN_ROOT, 'schemas', `${name}.schema.json`);
const man = readJson(path.join(run, 'manifest.json'));
const pageById = Object.fromEntries(man.pages.map((p) => [p.id, p]));
const read = (rel, max = 0) => { try { const t = fs.readFileSync(path.join(run, rel), 'utf8'); return max && t.length > max ? t.slice(0, max) + '\n[…truncated]' : t; } catch { return ''; } };
const exists = (rel) => !!rel && fs.existsSync(path.join(run, rel));
const out = (o) => console.log(JSON.stringify(o, null, 2));

const PREAMBLE = `You are the Codex reviewer in "kiln", a tool in which two AI models (Claude and you) independently audit a marketing website and then argue to consensus. You are working inside the run folder; every path below is relative to it. The folder is read-only: do not try to modify files, browse the web or run the site. You may open any file or image in the folder to check something. Your final message must be only the JSON the output schema asks for.`;

/** Run one Codex turn. Returns {ok, data, threadId, error}. */
function codex({ text, images = [], schemaFile, outFile, resume = null, label }) {
  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.rmSync(outFile, { force: true });
    const imgs = [...new Set(images)].filter(exists);
    const flags = ['--skip-git-repo-check', '--output-schema', schemaFile, '-o', outFile, '--json'];
    if (args.model) flags.push('-m', String(args.model));
    for (const i of imgs) flags.push('-i', i);
    // `resume` has no -C/-s flags; it inherits the cwd of this process and the session's sandbox.
    const argv = resume ? ['exec', 'resume', ...flags, resume, '-'] : ['exec', '-s', 'read-only', '-C', run, ...flags, '-'];
    const child = spawn('codex', argv, { cwd: run, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', threadId = resume, usage = null;
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, TIMEOUT);
    child.stdout.on('data', (d) => {
      stdout += d;
      let nl;
      while ((nl = stdout.indexOf('\n')) > -1) {
        const line = stdout.slice(0, nl); stdout = stdout.slice(nl + 1);
        try { const ev = JSON.parse(line); if (ev.type === 'thread.started') threadId = ev.thread_id; if (ev.type === 'turn.completed') usage = ev.usage; if (ev.type === 'error' || ev.type === 'turn.failed') stderr += `\n${JSON.stringify(ev).slice(0, 400)}`; } catch {}
      }
    });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-10000); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: `could not start codex: ${e.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let data = null, error = null;
      try { data = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) { error = `no valid JSON answer (${e.message})`; }
      if (!data) {
        const real = stderr.split('\n').filter((l) => l.trim() && !/rmcp::transport|Reading prompt from stdin/.test(l)).slice(-4).join(' | ');
        resolve({ ok: false, threadId, error: `${label}: codex exited ${code}; ${error}. ${real.slice(0, 500)}` });
      } else resolve({ ok: true, data, threadId, usage, images: imgs.length });
    });
    child.stdin.end(text);
  });
}

async function withRetry(job) {
  let r = await codex(job);
  if (!r.ok) { log(`retrying ${job.label}: ${r.error}`); r = await codex(job); }
  return r;
}

function preflight() {
  const v = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  if (v.error) { out({ ok: false, error: 'The codex CLI is not installed or not on PATH. Install it and run `codex login`.' }); process.exit(1); }
  const s = spawnSync('codex', ['login', 'status'], { encoding: 'utf8' });
  if (!/logged in/i.test(`${s.stdout}${s.stderr}`)) { out({ ok: false, error: 'Codex is not logged in. Run `codex login` and try again.' }); process.exit(1); }
}

// ------------------------------------------------------------------ stages

async function firstImpression() {
  const home = man.pages[0];
  const images = [home.images.aboveFold.desktop, home.images.aboveFold.mobile].filter(Boolean);
  const text = `${PREAMBLE}\n\n${prompt('first-impression')}\n\nThe two images attached are the desktop first screen and the phone first screen, in that order. Do not open any file.`;
  const r = await withRetry({ text, images, schemaFile: schema('first-impression'), outFile: path.join(run, 'first-impression', 'codex.json'), label: 'first impression' });
  out(r.ok ? { ok: true, file: 'first-impression/codex.json' } : r);
  if (!r.ok) process.exit(1);
}

async function audit() {
  const only = args.only ? String(args.only).split(',').map(Number) : null;
  const jobs = man.batches.map((ids, i) => ({ n: i + 1, ids })).filter((b) => !only || only.includes(b.n));
  const results = await pool(jobs, Math.max(1, +(args.concurrency || 3)), async ({ n, ids }) => {
    const pages = ids.map((id) => pageById[id]);
    const siteWide = ids.includes(man.pages[0].id);
    const images = pages.flatMap((p) => p.images.audit.map((a) => a.file));
    const text = [
      PREAMBLE, prompt('rubric'), prompt('audit'),
      `# Your assignment\n\nBatch ${n} of ${man.batches.length}. Audit these pages: ${pages.map((p) => `${p.id} (${p.url})`).join(', ')}.`,
      siteWide ? 'Your batch contains p01, so you also report site-wide findings (`"page": "site"`) from the site digest.' : 'Your batch does not contain p01: do NOT report site-wide findings. Use the site digest only for context and for comparing pages.',
      `All ${images.length} images listed in the digests below are attached to this message in the same order as they are listed, page by page. Section crops and other files are on disk if you need a closer look.`,
      `# site-digest.md\n\n${read('site-digest.md')}`,
      ...pages.map((p) => `# Digest for ${p.id}\n\n${read(p.files.digest)}\n\n## Page copy for ${p.id} (${p.files.text})\n\n${read(p.files.text, 7000)}`),
      'Now audit every assigned page thoroughly and return the findings JSON.',
    ].join('\n\n---\n\n');
    const outFile = path.join(run, 'findings', `codex-batch-${n}.json`);
    const r = await withRetry({ text, images, schemaFile: schema('findings'), outFile, label: `audit batch ${n}` });
    log(r.ok ? `codex audit batch ${n}/${man.batches.length}: ${r.data.findings?.length ?? 0} findings from ${r.images} images` : `codex audit batch ${n} FAILED: ${r.error}`);
    return { n, ok: r.ok, findings: r.ok ? r.data.findings?.length ?? 0 : 0, error: r.error };
  });
  const failed = results.filter((r) => !r.ok);
  const merged = spawnSync(process.execPath, [path.join(KILN_ROOT, 'scripts', 'ledger.mjs'), 'collect', '--run', run, '--who', 'codex'], { encoding: 'utf8' });
  let collected = null; try { collected = JSON.parse(merged.stdout); } catch {}
  out({ ok: !failed.length && !!collected?.ok, batches: results, failedBatches: failed.map((f) => f.n), collected: collected || merged.stderr.trim(), retryHint: failed.length ? `Re-run with --only ${failed.map((f) => f.n).join(',')}` : undefined });
  if (failed.length || !collected?.ok) process.exit(1);
}

async function debate() {
  const round = +args.round;
  const t = spawnSync(process.execPath, [path.join(KILN_ROOT, 'scripts', 'ledger.mjs'), 'todo', '--run', run, '--round', String(round), '--who', 'codex'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (t.status !== 0) { out({ ok: false, error: t.stderr.trim() }); process.exit(1); }
  const todo = JSON.parse(t.stdout);
  const outFile = path.join(run, 'debate', `round-${round}-codex.json`);
  if (!todo.count) { writeJson(outFile, { responses: [] }); out({ ok: true, round, responses: 0, note: 'Nothing for Codex to respond to this round.' }); return; }
  const sessionFile = path.join(run, 'debate', 'codex-session.txt');
  const session = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8').trim() : null;
  // Evidence images: each item's own shot first, then the first desktop and mobile sheet of each page involved.
  const images = [];
  for (const it of todo.items) if (exists(it.shot)) images.push(it.shot);
  for (const it of todo.items) for (const id of it.pages) {
    const p = pageById[id]; if (!p) continue;
    const a = p.images.audit.map((x) => x.file);
    for (const f of [a.find((x) => /desktop-01/.test(x)), a.find((x) => /mobile-01/.test(x))]) if (f) images.push(f);
  }
  const attach = [...new Set(images)].slice(0, 30);
  const chunks = [];
  for (let i = 0; i < todo.items.length; i += 40) chunks.push(todo.items.slice(i, i + 40));
  const all = []; let threadId = session;
  for (const [ci, items] of chunks.entries()) {
    const text = [
      ...(threadId ? [`Debate round ${round}${chunks.length > 1 ? `, part ${ci + 1} of ${chunks.length}` : ''}. Same rules as before (repeated below).`] : [PREAMBLE, prompt('rubric')]),
      prompt('review'),
      `# Round ${round}${chunks.length > 1 ? ` (part ${ci + 1} of ${chunks.length})` : ''}: ${items.length} item(s) for you\n\nAllowed stances this round: ${todo.allowed_stances.join(', ')}.\n\n${ci === 0 ? `${attach.length} evidence images are attached: ${attach.map((f) => `\`${f}\``).join(', ')}. ` : ''}Every other image and digest is on disk in the run folder: open whatever you need to verify an item, starting with its \`shot\` and the files in its \`digests\`.`,
      '```json\n' + JSON.stringify(items, null, 1) + '\n```',
      'Respond to every item above with exactly one stance each, using its id.',
    ].join('\n\n---\n\n');
    const part = path.join(run, 'debate', `.round-${round}-codex-part-${ci + 1}.json`);
    const r = await withRetry({ text, images: ci === 0 ? attach : [], schemaFile: schema('review'), outFile: part, resume: threadId, label: `debate round ${round}` });
    if (!r.ok) { out(r); process.exit(1); }
    threadId = r.threadId || threadId;
    if (threadId) fs.writeFileSync(sessionFile, threadId);
    all.push(...(r.data.responses || []));
    fs.rmSync(part, { force: true });
  }
  writeJson(outFile, { responses: all });
  const tally = {}; for (const r of all) tally[r.stance] = (tally[r.stance] || 0) + 1;
  out({ ok: true, round, expected: todo.count, responses: all.length, stances: tally, file: `debate/round-${round}-codex.json` });
}

function ledgerForGrading() {
  const led = readJson(path.join(run, 'ledger.json'));
  return led.items.filter((i) => i.status !== 'dropped').map((i) => ({ id: i.id, status: i.status, pages: i.pages, viewport: i.viewport, category: i.category, severity: i.severity, title: i.title, detail: i.detail, fix: i.fix, found_by: i.found_by, ...(i.positions ? { positions: i.positions } : {}) }));
}

async function grade() {
  const home = man.pages[0];
  const images = [home.images.aboveFold.desktop, home.images.aboveFold.mobile, ...home.images.audit.filter((a) => /sheets\/(desktop|mobile)-\d+/.test(a.file)).map((a) => a.file).slice(0, 10), ...man.pages.slice(1, 16).map((p) => p.images.thumb.desktop)].filter(Boolean);
  const text = [
    PREAMBLE, prompt('rubric'), prompt('grade'),
    `# Material\n\nAttached: the home page first screen (desktop, then mobile), the home page sheets, then a full-page thumbnail of each other page in manifest order. Everything else is on disk.`,
    `# site-digest.md\n\n${read('site-digest.md')}`,
    `# First-impression test (each reviewer saw only the first screen)\n\nClaude: ${read('first-impression/claude.json') || 'n/a'}\n\nCodex: ${read('first-impression/codex.json') || 'n/a'}`,
    '# Final ledger\n\n```json\n' + JSON.stringify(ledgerForGrading(), null, 1) + '\n```',
    'Grade the site now. One entry for every category key.',
  ].join('\n\n---\n\n');
  const r = await withRetry({ text, images, schemaFile: schema('grades'), outFile: path.join(run, 'grades', 'codex.json'), label: 'grading' });
  if (!r.ok) { out(r); process.exit(1); }
  if (r.threadId) fs.writeFileSync(path.join(run, 'grades', 'codex-session.txt'), r.threadId);
  out({ ok: true, file: 'grades/codex.json' });
}

async function regrade() {
  const gaps = readJson(path.join(run, 'grades', 'gaps.json')).gaps;
  if (!gaps.length) { out({ ok: true, note: 'No categories differ by more than the reconcile gap.' }); return; }
  const sf = path.join(run, 'grades', 'codex-session.txt');
  const session = fs.existsSync(sf) ? fs.readFileSync(sf, 'utf8').trim() : null;
  const text = [
    ...(session ? [] : [PREAMBLE, prompt('rubric'), '# Final ledger\n\n```json\n' + JSON.stringify(ledgerForGrading(), null, 1) + '\n```']),
    `# Reconciliation\n\nYou and the other reviewer (Claude) graded independently. In the categories below your scores differ by more than 10 points. Read Claude's rationale, check it against the ledger and the evidence, and give your final score for each of these categories only. Move toward Claude's score where their reasoning shows you over- or under-weighted something; hold your score where it does not, and say why. Do not split the difference just to agree.`,
    '```json\n' + JSON.stringify(gaps.map((g) => ({ key: g.key, label: g.label, your_score: g.codex.score, your_rationale: g.codex.rationale, claude_score: g.claude.score, claude_rationale: g.claude.rationale })), null, 1) + '\n```',
  ].join('\n\n---\n\n');
  const r = await withRetry({ text, schemaFile: schema('regrade'), outFile: path.join(run, 'grades', 'codex-final.json'), resume: session, label: 'grade reconciliation' });
  if (!r.ok) { out(r); process.exit(1); }
  out({ ok: true, file: 'grades/codex-final.json', categories: r.data.categories.map((c) => `${c.key}: ${c.score}`) });
}

preflight();
if (cmd === 'first-impression') await firstImpression();
else if (cmd === 'audit') await audit();
else if (cmd === 'debate') await debate();
else if (cmd === 'grade') await grade();
else if (cmd === 'regrade') await regrade();
else { console.error(`unknown stage "${cmd}"`); process.exit(2); }
