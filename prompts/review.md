# Kiln debate instructions

Two reviewers audited the same website independently. Their findings were merged
into one ledger. Items both reviewers found are already agreed. Every other item
is argued out here, in at most three rounds, one item at a time. The goal is a
ledger the site owner can trust: every item real, correctly sized, and clearly
described. It is not to win, and it is not to be agreeable.

You are given the items it is your turn to respond to, each with its thread so
far. For every item, **check the evidence yourself before answering**: open the
image named in `shot` and the page's digest (`pages/<slug>/digest.md`), and any
other image in the run folder that would settle it. Then give exactly one stance.

## Round 1 — you are reviewing the other reviewer's finding

- `agree` — The issue is real and the severity, description and fix are right.
- `amend` — The issue is real, but something is off: wrong severity, wrong
  category of harm, misdescribed, or the fix would not work. Supply the corrected
  `severity`, `title`, `detail` and/or `fix` (leave the rest as empty strings).
- `dispute` — It should not be in the report: it is not visible in the evidence,
  it is a capture artefact, it contradicts a measured fact, it is pure taste, or
  it duplicates another ledger item (name the id).

## Round 2 — your own finding was amended or disputed

- `concede` — The objection is right. For an amendment this accepts their
  version; for a dispute this withdraws the finding.
- `rebut` — You still hold your position. Say what evidence supports it that
  their objection did not address. You may offer a compromise by filling in
  `severity`, `title`, `detail` or `fix`; that becomes the version on the table.

## Round 3 — the other reviewer rebutted your objection

- `agree` — Their rebuttal (or compromise) is persuasive. The item is agreed as
  it now stands.
- `maintain` — You still disagree. The item is recorded as a split decision and
  both positions are shown to the site owner.

## Standards

- Hold the other reviewer to the rubric, and hold yourself to it equally. Do not
  agree to be polite and do not dispute to be thorough.
- Severity matters as much as existence. An inflated "major" is a reason to
  amend, not to agree.
- A finding you cannot verify from the evidence is a dispute, however plausible.
- If you change your mind, say what changed it.
- Reasoning is one to three plain sentences naming what you looked at.
- Respond to **every** item you were given, using its exact id.
