#!/usr/bin/env node
// The `kiln` command line. Day to day you run /kiln inside Claude Code; this
// exists to install that command (`kiln setup`) and to let it find and run
// kiln's scripts wherever npm put them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const [cmd, ...rest] = process.argv.slice(2);
const SCRIPTS = { capture: 'capture.mjs', codex: 'codex-turn.mjs', ledger: 'ledger.mjs', report: 'report.mjs' };
const run = (bin, args, opts = {}) => spawnSync(bin, args, { stdio: 'inherit', ...opts });

function setup() {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const major = +process.versions.node.split('.')[0];
  if (major < 20) { console.error(`kiln needs Node.js 20 or newer; found ${process.version}`); process.exit(1); }

  // 1. the /kiln command
  const dest = path.join(claudeDir, 'commands', 'kiln.md');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const stat = fs.lstatSync(dest, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) fs.unlinkSync(dest); // left by install.sh from a cloned copy
  fs.copyFileSync(path.join(ROOT, 'commands', 'kiln.md'), dest);
  console.log(`Installed the /kiln command: ${dest}`);
  const oldLink = path.join(claudeDir, 'kiln');
  if (fs.lstatSync(oldLink, { throwIfNoEntry: false })?.isSymbolicLink() && fs.realpathSync(oldLink) !== fs.realpathSync(ROOT)) {
    console.log(`Note: ${oldLink} links to another copy of kiln (${fs.realpathSync(oldLink)}). It is only used if the kiln command is not on your PATH; delete the link if you no longer want it.`);
  }

  // 2. browsers
  if (!rest.includes('--skip-browsers')) {
    console.log('Downloading browsers for capture (first time only: a few minutes)…');
    const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
    const r = run(process.execPath, [cli, 'install', 'chromium', 'webkit', 'firefox']);
    if (r.status !== 0) { console.error('Browser download failed. Re-run: kiln setup'); process.exit(1); }
  }

  // 3. the second reviewer
  const codex = spawnSync('codex', ['login', 'status'], { encoding: 'utf8' });
  const ready = !codex.error && /logged in/i.test(`${codex.stdout}${codex.stderr}`);
  console.log(ready ? 'Codex: installed and logged in.' : "Codex: NOT ready. Install the Codex CLI and run 'codex login' before using /kiln.");
  console.log(`\nkiln ${pkg.version} is set up. In Claude Code, run:  /kiln https://example.com`);
}

if (cmd === 'setup') setup();
else if (cmd === 'root') console.log(ROOT);
else if (cmd === '--version' || cmd === '-v' || cmd === 'version') console.log(pkg.version);
else if (SCRIPTS[cmd]) process.exit(run(process.execPath, [path.join(ROOT, 'scripts', SCRIPTS[cmd]), ...rest]).status ?? 1);
else {
  console.log(`kiln ${pkg.version} — two-reviewer marketing site audit for Claude Code

  kiln setup [--skip-browsers]   install the /kiln command and the capture browsers
  kiln root                      print where kiln is installed
  kiln --version

Then, inside Claude Code:  /kiln https://example.com

Individual stages (normally run for you by /kiln):
  kiln capture <url> --out <dir> [--max-pages N] [--urls a,b] [--quick] [--headless] [--submit-forms]
  kiln codex <first-impression|audit|debate|grade|regrade> --run <dir>
  kiln ledger <collect|init|todo|apply|status|grade> --run <dir>
  kiln report --run <dir>`);
  process.exit(cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h' ? 2 : 0);
}
