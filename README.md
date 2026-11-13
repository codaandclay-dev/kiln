# kiln

A Claude Code command that fires a marketing website in the kiln to see where
it cracks.

`/kiln https://example.com` crawls the site, captures every page on desktop and
mobile, and has **two AI reviewers, Claude and Codex, audit it independently**.
Their findings are merged, every disagreement is argued out over up to three
rounds, the site is graded against a fixed rubric, and the result is written to
a single self-contained HTML report.

Two models are used because each one misses things and each one over-reports.
Making them check each other's work, with the rules enforced by a script, removes
most of both.

## What you get

One file, `report.html`, that opens in any browser:

- **A letter grade and score**, with each reviewer's own score beside it.
- **A scorecard** of eleven categories, showing where the reviewers differed.
- **A blind first-impression test**: what each reviewer thought the site was,
  from the first screen alone.
- **Top fixes**, in priority order.
- **Every issue**, filterable by severity, category, page and agreement, each
  with its evidence screenshot, a suggested fix and the full debate thread.
- **Every page** on desktop and phone, with its measurements.
- **Design system**: declared tokens, inferred scales, the style of each role
  across pages, and component sheets.
- **Site-wide checks** and a plain list of what the run did not cover.

## What it checks

- **Design and polish** — layout, spacing, type, colour, imagery, hierarchy.
- **Messaging** — whether the first screen says what this is, who it is for and
  what to do next; copy quality, typos, placeholder text.
- **Conversion path** — calls to action, pricing, and anything that interrupts
  the visitor.
- **Forms** — kiln types into each form the way a visitor would: mistype, leave
  the field, correct it. It records when an error appears, its exact wording,
  whether it clears once the value is fixed, whether phone numbers are formatted,
  which keyboard a phone would show, and whether fields can be autofilled.
- **Popups** — detected, screenshotted, their forms tested the same way, how
  they close recorded, then closed so the page underneath can be captured.
- **Design system** — reads the CSS variables the site declares and flags
  colours and sizes that miss them; infers the type scale, spacing unit and
  corner radii from use and flags the strays; compares the same role (h1, h2,
  body text, buttons, fields, cards, icons, images, content columns) across
  every page; and lays every button, field, card and heading side by side at
  real size so drift is visible.
- **Modernness and trust** — proof, contact routes, legal pages, anything that
  makes the company look careless.
- **Mobile** — a full 390px pass: overflow, tap targets, the menu.
- **Motion and interaction** — page-load and scroll frame sequences, measured
  easing curves, hover and focus states, reduced-motion support, jank.
- **Hard evidence** — console errors, broken links and images, an axe-core
  accessibility scan, load timings (three clean runs plus a throttled phone),
  metadata and social previews, the 404 page, Safari-engine and Firefox renders.

## Requirements

- [Claude Code](https://claude.com/claude-code)
- Node.js 20 or newer
- The [Codex CLI](https://github.com/openai/codex), logged in (`codex login`)
- Google Chrome (optional; the bundled Chromium is used if it is missing)
- macOS or Linux. Windows is untested.

## Install

```bash
git clone https://github.com/codaandclay-dev/kiln.git
cd kiln && ./install.sh
```

The script links this folder to `~/.claude/kiln`, links the command to
`~/.claude/commands/kiln.md`, installs dependencies and downloads the
Playwright browsers (a few minutes the first time). Re-run it if you move the
folder. To uninstall, delete those two links.

## Use

In Claude Code, from the folder where you want the results:

```
/kiln https://example.com
```

| Flag | Effect |
|---|---|
| `--max-pages N` | Probe at most N pages. Default 25. |
| `--urls /pricing,/signup` | Probe only these pages; no crawl. |
| `--quick` | Screenshots and measurements only: no motion, interaction, form, video or cross-browser passes. |
| `--headless` | No visible browser windows. By default Chrome opens on screen, which is closer to what visitors get. |
| `--submit-forms` | Really submit lead forms. Off by default. See "Use it responsibly". |

A full run on a 25-page site takes roughly 30 to 60 minutes and a large number
of model tokens on both your Claude and Codex accounts: every page is looked at
by two reviewers, and every disputed issue is looked at again. Use
`--max-pages` or `--urls` to try it on a few pages first.

### Output

Results land in `./kiln-runs/<host>-<date>/`:

| File | What it is |
|---|---|
| `report.html` | The report. Self-contained; safe to send to someone. |
| `ledger.json` | Every issue, its status and the full debate thread |
| `grades.json` | Scores per category from each reviewer and the final grade |
| `site-digest.md` | Site-wide checks, the consistency table and the design-system measurements |
| `site/` | Component sheets and the 404 screenshot |
| `pages/<page>/` | Screenshots, state and motion sheets, video, `digest.md` and raw `evidence.json` for each page |
| `manifest.json` | What was captured, and what was left out |

## How a run works

1. **Capture.** A script crawls from the home page (navigation first, then the
   sitemap), loads each page on desktop and phone, scrolls it, exercises menus,
   accordions, tabs, carousels, forms and hover states, records motion, and
   measures it. No model is involved.
2. **First impression.** Each reviewer sees only the first screen and says what
   the site is and who it is for.
3. **Two audits.** Each reviewer audits the same screenshots and measurements
   without seeing the other's work.
4. **Merge.** Findings are merged into one ledger. Anything both found is
   agreed. A script checks that no finding was left out.
5. **Debate.**
   - Round 1: each reviewer checks the other's findings: agree, amend or
     dispute.
   - Round 2: each answers objections to their own findings: concede or rebut.
   - Round 3: each answers the rebuttals: agree, or maintain the objection.
     Anything still unsettled is reported as a split decision with both
     positions.
6. **Grade.** Each reviewer scores every category alone. Categories more than
   10 points apart get one reconciliation round. The final score is the average.
7. **Report.**

The round rules, the merge check and the grade arithmetic live in
`scripts/ledger.mjs`, not in a prompt, so neither model can bend them.

### Grading

| Category | Weight |
|---|---|
| Visual design and polish | 20 |
| Messaging and first-screen clarity | 15 |
| Conversion path | 15 |
| Modernness | 10 |
| Trust and professionalism | 10 |
| Mobile experience | 10 |
| Motion and interaction quality | 5 |
| Consistency across pages | 5 |
| Performance | 5 |
| Accessibility | 3 |
| Search and share basics | 2 |

Issues are rated critical, major, minor or polish. Weights and the letter scale
are in `schemas/rubric.json`; what the reviewers are told is in `prompts/`. Both
are plain files you can edit.

## Use it responsibly

Kiln behaves like an unusually thorough visitor, and a site owner will notice it.

- **Only run it on sites you own or have permission to test.**
- It loads every probed page several times in real browsers and requests every
  link once.
- It types test data into forms (`Kiln Test`, `kiln-test@example.com`) but does
  not submit them unless you pass `--submit-forms`. With that flag, real
  submissions reach the site's CRM or inbox.
- It triggers the site's analytics, chat widgets and ad pixels like any visit.
- Screenshots and page text are sent to Claude and to Codex for review.

## Limits

- Public pages only: nothing behind a login, payment or CAPTCHA.
- Without `--submit-forms`, validation that only happens on submit, success
  states and server errors are not seen.
- Embedded third-party flows on other domains (a quiz on Typeform, a scheduler)
  are not crawled.
- Up to three pages per repeated template (blog posts, case studies) are probed,
  and the same path with a different query string counts as one page.
- The clean three-run performance figures, the throttled-phone load and the
  Safari/Firefox renders are taken for the first five pages only.
- Design-system measurements are taken on desktop only. Token checks need the
  site to declare CSS variables on its root; otherwise only inferred scales are
  reported. Card and content-column detection is heuristic.
- Motion is judged from frame sequences and measured curves, not by watching
  video. The session videos are saved so a person can.
- Playwright's WebKit is close to Safari but is not Safari on an iPhone.
- Two models agreeing is strong evidence, not proof. Treat the report as a
  well-argued review, and check an issue before spending money on it.

## Troubleshooting

- **"Codex: NOT ready"** — install the Codex CLI and run `codex login`. Kiln
  stops without both reviewers.
- **Browsers missing** — run `npm run setup` in this folder.
- **`/kiln` not found** — re-run `./install.sh`, then restart Claude Code.
- **A page failed or looks wrong** — check `warnings` in `manifest.json` and
  "Capture gaps" in that page's `digest.md`; kiln records what it could not do.
- **A Codex batch failed** — re-run just that part:
  `node ~/.claude/kiln/scripts/codex-turn.mjs audit --run <run folder> --only <batch numbers>`

## Layout

```
commands/kiln.md          the /kiln command: orchestrates the phases
prompts/                  rubric and instructions shared by both reviewers
schemas/                  JSON shapes for findings, debate turns and grades; rubric weights
scripts/capture.mjs       crawl and capture
scripts/codex-turn.mjs    bridge to the Codex CLI
scripts/ledger.mjs        merge check, debate rounds, grade arithmetic
scripts/report.mjs        report.html
scripts/lib/
  discover.mjs            page discovery
  page-capture.mjs        per-page capture, popups
  evidence.mjs            in-page measurements
  interact.mjs            hover, focus, menus, accordions, tabs, carousels
  forms.mjs               form behaviour
  tokens.mjs              design-system checks and component sheets
  motion.mjs              frame capture and motion curves
  perf.mjs                performance runs, other engines, link checks
  digest.mjs              plain-language digests for the reviewers
  compose.mjs             image sheets
```

Each script can be run on its own; `node scripts/<name>.mjs` with no arguments
prints its usage.

## Licence

No licence has been chosen yet, so all rights are reserved until one is added.
