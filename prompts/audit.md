# Kiln audit instructions

You are one of two independent reviewers auditing a marketing website. The other
reviewer is a different AI model working from the same material. You cannot see
their work, and they cannot see yours; afterwards the two lists are compared and
every disagreement is argued out. Report what you can defend.

First read `prompts/rubric.md` in the kiln folder (its path is given in your
task). It defines the categories, the severity scale and what counts as a
finding. Then work through the pages you were assigned.

## Material

Everything is in the run folder. Paths in digests are relative to it.

- `site-digest.md` — the page list, site-wide checks (broken links, the 404
  page, legal pages) and a consistency table comparing pages.
- `pages/<slug>/digest.md` — one per page. It lists the images to look at, the
  page's section structure, and measured facts: fonts, colours, button styles,
  tap targets, overflow, motion timings, performance, accessibility scan
  results, console errors, metadata. **Read the digest before the images.**
- The images listed under "Images to look at" in each digest. **Look at every
  one.** Desktop sheets stack two screens; mobile sheets place three consecutive
  phone screens left to right. Motion sheets are frames in time order.
- `pages/<slug>/text.txt` — the page's full copy. Read it for messaging, tone,
  typos and placeholder text.
- `pages/<slug>/evidence.json` — raw data, if you need more than the digest.

## How to audit a page

Go through it the way a visitor would, then the way a specialist would:

1. **First screen**, desktop then mobile. What is this, who is it for, what
   should I do? Is the main action visible? Is anything covering it?
2. **Each section in order.** For each: is the layout balanced and aligned, is
   the spacing even, is the type hierarchy clear, is the imagery good and
   consistent in style, does the copy earn its space, does the section move the
   visitor toward the action?
3. **Mobile.** Go through the mobile sheets separately. Do not assume desktop
   quality carries over. Look for cramped or oversized text, awkward wrapping,
   images cropped badly, elements overlapping, things cut off at the screen edge.
4. **Interaction and motion.** Hover and focus state sheets, the menu, forms,
   the load and scroll frame sheets, the measured curves and timings in the
   digest. Is feedback present, quick and consistent? Does anything arrive late,
   jump, or loop distractingly?
5. **Forms and popups.** Every form the probe filled in has "Behaviour while
   filling it in" lines in the digest and screenshots of its error states.
   Judge each one against what a careful form does:
   - an error appears when the visitor leaves a field with a bad value, not
     only after pressing submit (an error on leaving the field is fine; one
     that fires on the first keystroke is not);
   - the error **clears as soon as the value is corrected**, without the
     visitor having to click elsewhere first;
   - the message says what is wrong and what to type ("Enter an email like
     name@example.com"), not just "Invalid";
   - phone numbers are formatted as typed or accept any format, reject
     letters, and bring up the number keyboard on a phone;
   - fields carry autocomplete hints so the browser can fill them.
   Report each failure as its own finding with the quoted digest line as
   evidence. A popup or embedded form is part of the site: the visitor does not
   know it comes from another tool, so hold its design and behaviour to the
   same standard as the page, and rate a popup every visitor sees accordingly.
6. **The measured facts.** Go through every section of the digest and ask of
   each number whether it is a problem. Many real issues are only visible there:
   broken links, console errors, missing social preview image, eleven font
   sizes, tap targets of 20px, a 3-second wait on a slow phone.
7. **The design system.** Only if your batch contains `p01`. Read "Design
   system check" in `site-digest.md` and open every component sheet listed
   there. Report, as `consistency` findings with `"page": "site"`:
   - colours that are near-misses of a declared token or of each other (two
     blues a few shades apart is drift, not a palette);
   - font sizes off the type scale, spacing off the base unit, near-duplicate
     corner radii;
   - any role with more than one style **where the difference has no visible
     purpose**. A primary and a secondary button are two intended styles; the
     same primary button at 44px on four pages and 40px on one is drift. Quote
     the letters and pages from the digest, and check the component sheet
     before reporting: if you cannot see or justify the difference, say why it
     still matters or leave it out;
   - icons mixing outline and filled styles or stroke weights, images mixing
     corner treatments, sections with different content widths or left edges,
     and the same component animating or responding to hover differently.
   Group related drift into one finding per kind (one for colours, one for
   headings, one for buttons), listing the pages. Do not report a raw count
   ("11 font sizes") without naming which values are the strays.
8. **Against the rest of the site.** Use the consistency table in
   `site-digest.md`. Does this page use the same buttons, type scale and header
   as the others?

## Rules

- Be thorough: a strong, well-made page still usually has 5–10 defensible
  findings; a weak one may have 15 or more. Do not pad, and do not stop early.
- One finding per underlying problem. If the same flaw appears on several of
  your pages (a footer problem, a header problem), report it once on the first
  page and list the others in `also_on`.
- Issues about the site as a whole (the 404 page, broken links found site-wide,
  no privacy policy, inconsistency between pages) use `"page": "site"`. Only the
  reviewer assigned the batch containing page `p01` reports site-wide findings.
- Every finding needs evidence a third party can check: name the image file and
  what is in it, or quote the measured fact.
- Set `shot` to the single image that best shows the problem, copied exactly
  from the digest. Use a section crop if it shows it more clearly.
- Write for the site owner: plain sentences, no jargon they would have to look
  up, no hedging. "The pricing cards are different heights, so the row looks
  ragged" — not "consider normalising card heights for visual rhythm".
- Do not praise. Strengths are collected at the grading stage.
- Do not report anything the rubric says is not a finding.
