---
description: Fire a marketing site in the kiln - Claude and Codex audit every page, argue to consensus, grade it and write an HTML report
argument-hint: <url> [--quick] [--max-pages N] [--urls /a,/b] [--submit-forms] [--headless]
---

# /kiln

Arguments: `$ARGUMENTS`

You are running **kiln**: a probe that captures every page of a marketing
website, has you and Codex audit it independently, makes the two of you argue
out every disagreement, grades the site, and writes one HTML report.

Kiln's scripts, prompts and schemas live in its install folder (called `KILN`
below; Phase 0 finds it — use that absolute path wherever `$KILN` or `KILN` appears). The scripts do the bookkeeping and enforce the rules; your job is the
judgement: auditing, merging, debating and grading. Work through the phases in
order. Tell the user in one short line when each phase starts and what it
found; do not narrate individual tool calls.

## Rules that hold for the whole run

1. **Independence.** Your audit, your first-impression answer and your grades
   must each be written to disk *before* you read Codex's version of the same
   thing. Never open `findings/codex*.json`, `first-impression/codex.json` or
   `grades/codex*.json` until the phase below says to.
2. **Nothing is dropped silently.** You may not delete, soften or re-rate a
   Codex finding when merging. If you think one is wrong, say so in the debate.
   `ledger.mjs init` rejects a draft that leaves any finding out.
3. **Debate honestly.** Hold Codex's findings and your own to the same standard
   (`KILN/prompts/review.md`). Concede when the evidence is against you. Do not
   agree to save time, and do not dispute to look rigorous.
4. **Look before you judge.** Every finding, stance and score must rest on an
   image you opened or a measured fact in a digest.
5. **Long commands run in the background** (`run_in_background`). Capture takes
   10–25 minutes; each Codex stage takes 2–15. Do your own part of the phase
   while Codex works, then wait for its completion notice.
6. If a script prints `"ok": false` or exits non-zero, read its message, fix
   what it names and re-run that step. If Codex is not installed or not logged
   in, stop and tell the user: kiln needs both reviewers.

## Phase 0 — Set up

- Parse the arguments. The first non-flag argument is the URL; if it is missing,
  ask for it. Pass `--quick`, `--max-pages N`, `--urls a,b` (probe only these pages), `--submit-forms` and `--headless`
  through to the capture script unchanged.
- Check the install:
  ```bash
  KILN="$(kiln root 2>/dev/null || echo "$HOME/.claude/kiln")"; echo "KILN=$KILN"; ls "$KILN/scripts/capture.mjs" && node --version && codex login status
  [ -d "$KILN/node_modules/playwright" ] || (cd "$KILN" && npm run setup)
  ```
  The first-ever run downloads browsers, which takes a few minutes.
- Choose the run folder: `./kiln-runs/<host>-<YYYY-MM-DD-HHmm>` under the
  current directory (`RUN` below). Use absolute paths in every command.

## Phase 1 — Capture

```bash
node "$KILN/scripts/capture.mjs" <url> --out "$RUN" [flags]     # background
```

Unless `--headless` was given, Chrome windows open and close on screen while
this runs; tell the user that once. When it finishes, its stdout is a JSON
summary (`pages`, `batches`, `images`, `warnings`). If `ok` is false, stop and
report the error.

## Phase 2 — First impression (blind)

Before reading anything else in the run folder, get the two first-screen image
paths and look at **only** those two images:

```bash
node -e 'const m=require(process.argv[1]+"/manifest.json");console.log(JSON.stringify({home:m.pages[0].images.aboveFold,batches:m.batches,pages:m.pages.map(p=>[p.id,p.url])}))' "$RUN"
```

Read `KILN/prompts/first-impression.md`, then write
`RUN/first-impression/claude.json`:

```json
{ "what_is_it": "", "who_is_it_for": "", "what_to_do_next": "", "clarity": "clear | partly clear | unclear", "mobile_differs": "", "notes": "" }
```

## Phase 3 — Two independent audits

Start Codex in the background:

```bash
node "$KILN/scripts/codex-turn.mjs" first-impression --run "$RUN" && node "$KILN/scripts/codex-turn.mjs" audit --run "$RUN"
```

Then run your own audit. The manifest's `batches` lists groups of page ids;
Codex audits the same groups. Launch **one subagent per batch, all in a single
message** so they run in parallel, each with this brief (fill in the values):

> You are the Claude reviewer in a two-model website audit. Read
> `KILN/prompts/rubric.md` and `KILN/prompts/audit.md` in full and follow them
> exactly. Run folder: `RUN`. You are auditing batch N: pages `<ids and URLs>`.
> `<This batch contains p01, so you also report site-wide findings. | This batch
> does not contain p01: do not report site-wide findings.>` Read
> `RUN/site-digest.md`, then for each page its `digest.md` and `text.txt`, and
> open **every** image listed under "Images to look at" in the digest. Do not
> read anything under `RUN/findings/`. Write your findings to
> `RUN/findings/claude-batch-N.json` as `{"findings":[…]}` where each finding
> has exactly the fields in `KILN/schemas/findings.schema.json`. Reply with
> only the number of findings you wrote.

If subagents are not available, audit the batches yourself one at a time to
the same standard. Then:

```bash
node "$KILN/scripts/ledger.mjs" collect --run "$RUN" --who claude
```

If it reports `missingBatches`, redo those batches. Wait for the Codex audit to
finish; if it reports `failedBatches`, re-run it with `--only <numbers>`.

## Phase 4 — Merge into one ledger

Now, and only now, read `RUN/findings/claude.json` and `RUN/findings/codex.json`.
Write `RUN/ledger-draft.json`:

```json
{ "items": [
  { "sources": ["C-004", "X-011"], "title": "…", "detail": "…", "fix": "…", "pages": ["p01", "p03"] },
  { "sources": ["X-002"] }
] }
```

- Every finding id from both files appears in **exactly one** item.
- Put two findings in one item only when they describe the **same underlying
  problem** (same cause, same fix), including the same problem reported on
  different pages. Related-but-different problems stay separate.
- An item with a single source needs only `sources`; its fields are copied from
  the finding. To save writing those out, add `"auto_singletons": true` at the
  top level: every finding you did not name in a merged item then becomes its
  own item, unchanged. List only the merged items yourself.
- The same reviewer often reports one site-wide problem once per batch (a heavy
  script bundle, a small menu button, a chat bubble on every page). Merge those
  into one item too, and list all the pages. For merged items, write the clearest `title`, `detail` and `fix`
  from the two (and `category`/`viewport`/`shot` if you need to choose); do not
  set `severity` — the script takes it from the sources, and sends the item to
  debate if the two reviewers rated it two or more levels apart.

```bash
node "$KILN/scripts/ledger.mjs" init --run "$RUN"
```

Fix whatever it rejects and re-run until `ok`. Items both reviewers found are
now `agreed`; everything else is `open`.

## Phase 5 — Debate (up to three rounds)

For round N = 1, 2, 3:

1. Start Codex's turn in the background:
   `node "$KILN/scripts/codex-turn.mjs" debate --run "$RUN" --round N`
2. Get your own items: `node "$KILN/scripts/ledger.mjs" todo --run "$RUN" --round N --who claude`
3. Read `KILN/prompts/review.md` (once). For **each** item, open its `shot` and
   the relevant part of its page digest, check the claim, and choose one of the
   round's allowed stances. With more than about 25 items, split them between
   parallel subagents (give each the items JSON, the path to `review.md` and
   the run folder, and have each return its responses as JSON), then combine.
4. Write `RUN/debate/round-N-claude.json`:
   ```json
   { "responses": [ { "id": "K-014", "stance": "amend", "reasoning": "…", "severity": "minor", "title": "", "detail": "", "fix": "" } ] }
   ```
   Empty strings mean "leave unchanged". If you have no items, write `{"responses":[]}`.
5. When Codex's turn has finished: `node "$KILN/scripts/ledger.mjs" apply --run "$RUN" --round N`
6. If the result says `"done": true`, the debate is over. Otherwise go to the
   next round. After round 3 anything unresolved is recorded as a split
   decision automatically.

Round 1: each reviewer reviews the other's findings (`agree`, `amend`,
`dispute`). Round 2: each answers objections to their own findings (`concede`,
`rebut`). Round 3: each answers the rebuttals (`agree`, `maintain`).

## Phase 6 — Grade

1. Start Codex in the background: `node "$KILN/scripts/codex-turn.mjs" grade --run "$RUN"`
2. Read `KILN/prompts/grade.md` and the rubric's score anchors. Read
   `RUN/ledger.json`, look again at the home page first screens and sheets and
   at each page's `thumb-desktop.jpg`, then write `RUN/grades/claude.json`:
   ```json
   { "categories": [ { "key": "visual", "score": 0, "rationale": "…" } ], "verdict": "…", "strengths": ["…"], "top_fixes": [ { "id": "K-003", "why": "…" } ] }
   ```
   One entry for each of the eleven category keys in `KILN/schemas/rubric.json`.
3. When Codex has finished: `node "$KILN/scripts/ledger.mjs" grade --run "$RUN"`
4. If it prints `needsReconcile`, read `RUN/grades/gaps.json` (this is the first
   time you see Codex's scores). Start `node "$KILN/scripts/codex-turn.mjs" regrade --run "$RUN"`
   in the background, and write `RUN/grades/claude-final.json` as
   `{"categories":[{"key":"…","score":0,"rationale":"…"}]}` for the listed
   categories only: move where Codex's reasoning shows you over- or
   under-weighted something, hold where it does not, and say which. Then run
   `ledger.mjs grade` again; add `--finalize` if it still asks.

## Phase 7 — Report

```bash
node "$KILN/scripts/report.mjs" --run "$RUN" && open "$RUN/report.html"
```

(`open` is macOS; use `xdg-open` on Linux, or skip it.) Then tell the user, briefly:

- the grade and score, and each reviewer's own score;
- how many issues by severity, how many both found, how many were withdrawn or split;
- the top three fixes in one line each;
- the full path to `report.html`;
- anything in the manifest's `warnings` that limits what the grade means.
