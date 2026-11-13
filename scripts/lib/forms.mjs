// Form behaviour: what a visitor experiences while filling a form in. Types
// into the email, phone and first text field the way a person would and
// records when errors appear, what they say, whether they clear once the value
// is fixed, and whether phone numbers are formatted. Never submits.
//
// `root` is a Locator for the form (or the <body> of a popup's iframe), so the
// same probe works on the page and inside embedded popups.

const TEST_EMAIL = 'kiln-test@example.com';
const TEST_PHONE = '5550100199';

/** Visible text lines inside the form, and the field's own error signals. */
async function snap(root, field) {
  const lines = await root.evaluate((el) => (el.innerText || '').split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)).catch(() => []);
  const f = await field.evaluate((el) => {
    const cs = getComputedStyle(el), ps = el.parentElement ? getComputedStyle(el.parentElement) : cs;
    const described = (el.getAttribute('aria-describedby') || '').split(/\s+/).map((id) => id && document.getElementById(id)?.innerText?.trim()).filter(Boolean).join(' ');
    return {
      value: el.value, ariaInvalid: el.getAttribute('aria-invalid') === 'true', described, native: el.validationMessage || '',
      look: [cs.borderTopColor, cs.borderBottomColor, cs.outlineColor, cs.boxShadow, ps.borderTopColor, ps.borderBottomColor].join('|'),
      own: [el.placeholder, el.getAttribute('aria-label'), el.name].filter(Boolean).map((s) => s.trim().toLowerCase()),
    };
  }).catch(() => null);
  return { lines, f };
}

/** What changed since `base` that a visitor would read as an error. */
function signal(base, now, restingLook) {
  const had = new Set(base.lines);
  const own = new Set(now.f?.own || []);
  const texts = now.lines.filter((l) => !had.has(l) && !own.has(l.toLowerCase()) && l.length < 160);
  return { texts, ariaInvalid: !!now.f?.ariaInvalid, restyled: !!now.f && !!restingLook && now.f.look !== restingLook, shown: texts.length > 0 || !!now.f?.ariaInvalid };
}

const typeInto = async (field, text, page) => {
  await field.click({ timeout: 2500 });
  await field.press('ControlOrMeta+a').catch(() => {});
  await field.press('Backspace').catch(() => {});
  await field.pressSequentially(text, { delay: 35, timeout: 8000 });
  await page.waitForTimeout(450);
};
const leave = async (field, page) => { await field.blur().catch(() => {}); await page.waitForTimeout(550); };

/**
 * Type a bad value, leave, fix it, leave again. Returns when the error showed,
 * what it said and when it went away.
 */
async function errorCycle(root, field, page, bad, good, shot, name) {
  const base = await snap(root, field);
  await field.click({ timeout: 2500 }); await page.waitForTimeout(200);
  const restingLook = (await snap(root, field)).f?.look; // focused, before any input
  await typeInto(field, bad, page);
  const typing = signal(base, await snap(root, field), null);
  await leave(field, page);
  const leftSnap = await snap(root, field);
  const left = signal(base, leftSnap, null);
  const unfocusedBad = leftSnap.f?.look;
  if (shot) await shot(`form-${name}-invalid`, `${name} field holding "${bad}", after leaving the field`, left.texts.length ? `Message shown: "${left.texts.join(' / ')}"` : left.shown ? 'Marked invalid with no visible message' : 'No error shown');
  const errTexts = left.texts.length ? left.texts : typing.texts;
  await typeInto(field, good, page);
  const fixedSnap = await snap(root, field);
  const stillTyping = fixedSnap.lines.filter((l) => errTexts.includes(l));
  const clearedWhileTyping = stillTyping.length === 0 && !fixedSnap.f?.ariaInvalid;
  if (shot && !clearedWhileTyping) await shot(`form-${name}-fixed`, `${name} field corrected to "${good}", cursor still in the field`, 'The error is still showing although the value is now valid');
  await leave(field, page);
  const endSnap = await snap(root, field);
  const stillAfter = endSnap.lines.filter((l) => errTexts.includes(l));
  const clearedAfterLeaving = stillAfter.length === 0 && !endSnap.f?.ariaInvalid;
  const shown = typing.shown || left.shown;
  return {
    appears: typing.shown ? 'while typing' : left.shown ? 'on leaving the field' : 'not before submit',
    message: errTexts, markedInvalidForAssistiveTech: left.ariaInvalid || typing.ariaInvalid,
    fieldRestyled: !!unfocusedBad && !!endSnap.f?.look && unfocusedBad !== endSnap.f.look,
    nativeMessage: leftSnap.f?.native || null,
    clears: !shown ? null : clearedWhileTyping ? 'as soon as the value is corrected' : clearedAfterLeaving ? 'only after leaving the field again' : 'never (still shown with a valid value)',
    finalValue: endSnap.f?.value ?? null, restingLook: !!restingLook,
  };
}

export async function probeFormBehaviour(root, page, shot) {
  const out = { tested: [] };
  const vis = async (loc) => (await loc.count().catch(() => 0)) > 0 && await loc.first().isVisible().catch(() => false);
  const guard = async (label, fn) => { try { await fn(); out.tested.push(label); } catch (e) { (out.errors ||= []).push(`${label}: ${String(e.message).split('\n')[0].slice(0, 120)}`); } };

  // Keyboard and autofill hints, which decide the phone keyboard and whether the browser can fill the form.
  out.fields = await root.evaluate((el) => {
    const fs = [...el.querySelectorAll('input, textarea, select')].filter((x) => !['hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(x.type) && x.getBoundingClientRect().width > 0);
    return { total: fs.length, withAutocomplete: fs.filter((x) => x.getAttribute('autocomplete') && x.getAttribute('autocomplete') !== 'off').length, required: fs.filter((x) => x.required || x.getAttribute('aria-required') === 'true').length };
  }).catch(() => null);

  const text = root.locator('input[type=text]:visible, input:not([type]):visible').first();
  const email = root.locator('input[type=email]:visible, input[name*="email" i]:visible, input[placeholder*="email" i]:visible, input[autocomplete="email"]:visible').first();
  const phone = root.locator('input[type=tel]:visible, input[name*="phone" i]:visible, input[placeholder*="phone" i]:visible, input[name*="mobile" i]:visible, input[placeholder*="mobile" i]:visible, input[autocomplete^="tel"]:visible').first();

  if (await vis(text)) await guard('empty field', async () => {
    const base = await snap(root, text);
    await text.click({ timeout: 2500 }); await page.waitForTimeout(150);
    await leave(text, page);
    const s = signal(base, await snap(root, text), null);
    out.emptyField = { field: (base.f?.own || [])[0] || 'first text field', errorOnLeaving: s.shown, message: s.texts };
  });

  if (await vis(email)) await guard('email', async () => {
    const attrs = await email.evaluate((el) => ({ type: el.type, inputmode: el.getAttribute('inputmode'), autocomplete: el.getAttribute('autocomplete') }));
    out.email = { ...attrs, ...(await errorCycle(root, email, page, 'kiln-test', TEST_EMAIL, shot, 'email')) };
  });

  if (await vis(phone)) await guard('phone', async () => {
    const attrs = await phone.evaluate((el) => ({ type: el.type, inputmode: el.getAttribute('inputmode'), autocomplete: el.getAttribute('autocomplete'), maxlength: el.getAttribute('maxlength'), placeholder: el.placeholder || null }));
    await typeInto(phone, TEST_PHONE, page);
    const shownAs = await phone.inputValue();
    await typeInto(phone, 'abc', page);
    const letters = await phone.inputValue();
    const cycle = await errorCycle(root, phone, page, '12', TEST_PHONE, shot, 'phone');
    out.phone = {
      ...attrs, typed: TEST_PHONE, shownAs, formatsAsTyped: /[\s().-]/.test(shownAs.replace(/^\+\d{1,3}\s?/, '')) && shownAs.replace(/\D/g, '').endsWith(TEST_PHONE), addsCountryCode: /^\+\d/.test(shownAs),
      acceptsLetters: /[a-z]/i.test(letters), numericKeyboard: attrs.type === 'tel' || ['tel', 'numeric'].includes(attrs.inputmode), ...cycle,
    };
  });
  return out;
}

/** Find the form inside a popup tagged by findBlocker, including one inside an iframe. */
export async function popupFormRoot(page) {
  const main = page.locator('[data-kiln-blocker]').first();
  if (await main.locator('input:visible').count().catch(() => 0)) return main;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    let top = frame; while (top.parentFrame() && top.parentFrame() !== page.mainFrame()) top = top.parentFrame();
    const el = await top.frameElement().catch(() => null);
    if (!el || !(await el.evaluate((n) => !!n.closest('[data-kiln-blocker]')).catch(() => false))) continue;
    if (await frame.locator('input:visible').count().catch(() => 0)) return frame.locator('body');
  }
  return null;
}

/** Digest lines for one probed form. */
export function behaviourLines(b, where) {
  if (!b) return [];
  const L = [], q = (xs) => xs.map((s) => `"${s}"`).join(' / ');
  const cycle = (c, what) => {
    if (c.appears === 'not before submit') return `${what}: NO error shown while typing or on leaving the field (any validation happens only on submit, which kiln did not do)`;
    const msg = c.message.length ? `message ${q(c.message)}` : 'NO visible message, the field is only marked or restyled';
    return `${what}: error appears ${c.appears}; ${msg}; after correcting the value the error clears ${c.clears}${c.markedInvalidForAssistiveTech ? '' : '; not marked invalid for screen readers'}`;
  };
  if (b.email) L.push(`- ${where} — email typed as "kiln-test" then corrected. ${cycle(b.email, 'Result')}. Field type=${b.email.type}, autocomplete=${b.email.autocomplete || 'none'}.`);
  if (b.phone) {
    const p = b.phone;
    L.push(`- ${where} — phone: typing ${p.typed} displays "${p.shownAs}" (${p.formatsAsTyped ? 'digits grouped as typed' : p.addsCountryCode ? 'country code added, digits NOT grouped' : 'NO formatting or input mask'}); letters ${p.acceptsLetters ? 'ARE accepted' : 'are rejected'}; phone keyboard on mobile: ${p.numericKeyboard ? 'numeric' : 'NOT numeric'} (type=${p.type}, inputmode=${p.inputmode || 'none'}); placeholder ${p.placeholder ? `"${p.placeholder}"` : 'none'}; autocomplete=${p.autocomplete || 'none'}.`);
    L.push(`- ${where} — phone typed as "12" then corrected. ${cycle(p, 'Result')}.`);
  }
  if (b.emptyField) L.push(`- ${where} — required-field check: clicking into "${b.emptyField.field}" and leaving it empty ${b.emptyField.errorOnLeaving ? `shows ${b.emptyField.message.length ? q(b.emptyField.message) : 'an invalid state with no message'}` : 'shows nothing'}.`);
  if (b.fields) L.push(`- ${where} — ${b.fields.withAutocomplete} of ${b.fields.total} fields carry an autocomplete hint (browser autofill); ${b.fields.required} marked required in code.`);
  if (b.errors?.length) L.push(`- ${where} — could not test: ${b.errors.join('; ')}`);
  return L;
}
