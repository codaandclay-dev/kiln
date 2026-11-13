// Motion capture: screencast frames (Chromium only), contact sheets, and
// analysis of the per-frame element tracks recorded by the init script.
import { round } from './util.mjs';
import { esc } from './compose.mjs';

/** Collects screencast frames. Chromium emits a frame whenever the picture changes. */
export class Screencast {
  constructor() { this.frames = []; this.cdp = null; this.on = false; }

  async start(context, page, { maxWidth = 640 } = {}) {
    try {
      this.cdp = await context.newCDPSession(page);
      this.cdp.on('Page.screencastFrame', (f) => {
        if (this.frames.length < 900) this.frames.push({ data: f.data, ts: f.metadata.timestamp * 1000, w: f.metadata.deviceWidth, h: f.metadata.deviceHeight });
        this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      });
      await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth, maxHeight: 1000, everyNthFrame: 1 });
      this.on = true;
    } catch { this.on = false; }
  }

  /** Remove and return everything captured so far. */
  take() { return this.frames.splice(0); }

  async stop() { if (this.on) await this.cdp.send('Page.stopScreencast').catch(() => {}); this.on = false; }
}

/** Pick up to `n` frames spread across the list (by index, so busy moments get more frames). */
export function pickFrames(frames, n = 12) {
  if (frames.length <= n) return frames;
  const out = [];
  for (let i = 0; i < n; i++) out.push(frames[Math.round(i * (frames.length - 1) / (n - 1))]);
  return out;
}

export async function frameSheet(composer, frames, out, { title, originMs, cols = 4, n = 12 }) {
  const picked = pickFrames(frames, n);
  if (picked.length < 2) return null;
  await composer.grid(picked.map((f) => ({ dataUrl: `data:image/jpeg;base64,${f.data}`, label: `${Math.round(f.ts - originMs)} ms` })), out, { cols, title });
  return out;
}

/** Turn raw per-frame samples into something a reviewer can reason about. */
export function analyseTracks(raw) {
  const out = [];
  for (const tr of raw || []) {
    const s = tr.samples;
    if (!s || s.length < 4) continue;
    const first = s[0], last = s[s.length - 1];
    const dx = last[1] - first[1], dy = last[2] - first[2], dScale = first[3] ? last[3] / first[3] : 1, dOp = last[5] - first[5];
    const dist = Math.hypot(dx, dy);
    // dominant channel: whichever changed most, in comparable units
    const channels = [
      { key: 'position', mag: dist, val: (p) => (dist ? ((p[1] - first[1]) * dx + (p[2] - first[2]) * dy) / (dist * dist) : 0) },
      { key: 'opacity', mag: Math.abs(dOp) * 100, val: (p) => (dOp ? (p[5] - first[5]) / dOp : 0) },
      { key: 'size', mag: Math.abs(last[3] - first[3]) + Math.abs(last[4] - first[4]), val: (p) => { const d = (last[3] - first[3]) || (last[4] - first[4]); const i = (last[3] - first[3]) ? 3 : 4; return d ? (p[i] - first[i]) / d : 0; } },
    ].sort((a, b) => b.mag - a.mag);
    const ch = channels[0];
    if (ch.mag < 3) continue; // nothing visibly changed
    const prog = s.map((p) => [p[0], ch.val(p)]);
    // settle time: last moment progress was still >2% away from final
    let endIdx = 0;
    for (let i = 0; i < prog.length; i++) if (Math.abs(prog[i][1] - 1) > 0.02) endIdx = i;
    endIdx = Math.min(prog.length - 1, endIdx + 1);
    let startIdx = 0;
    for (let i = 0; i < prog.length; i++) { if (Math.abs(prog[i][1]) > 0.02) { startIdx = Math.max(0, i - 1); break; } }
    const t0 = prog[startIdx][0], t1 = prog[endIdx][0], dur = t1 - t0;
    if (dur < 30) continue;
    const at = (frac) => { const t = t0 + dur * frac; let k = startIdx; while (k < endIdx && prog[k + 1][0] <= t) k++; return prog[k][1]; };
    const p25 = at(0.25), p50 = at(0.5), p75 = at(0.75);
    let easing = 'ease-in-out';
    if (Math.abs(p25 - 0.25) < 0.08 && Math.abs(p50 - 0.5) < 0.08 && Math.abs(p75 - 0.75) < 0.08) easing = 'linear';
    else if (p50 > 0.62) easing = 'ease-out (fast start, gentle stop)';
    else if (p50 < 0.38) easing = 'ease-in (slow start, abrupt stop)';
    let reversals = 0;
    for (let i = startIdx + 2; i <= endIdx; i++) { const a = prog[i - 1][1] - prog[i - 2][1], b = prog[i][1] - prog[i - 1][1]; if (a * b < 0 && Math.abs(a) > 0.03 && Math.abs(b) > 0.03) reversals++; }
    if (reversals > 3) { out.push({ el: tr.el, cause: tr.cause, name: tr.name, startMs: tr.startMs, abs: tr.abs, looping: true, channel: ch.key, durationMs: Math.round(dur), delayMs: Math.round(t0), movedPx: [0, 0], opacity: [round(first[5], 2), round(last[5], 2)], scale: 1, easing: 'continuous loop', overshoot: null, maxFrameGapMs: null, droppedFrames: 0, progress: [], box: { x: first[1], y: first[2], w: first[3], h: first[4] } }); continue; }
    const peak = Math.max(...prog.slice(startIdx, endIdx + 1).map((p) => p[1]));
    const gaps = []; for (let i = startIdx + 1; i <= endIdx; i++) gaps.push(s[i][0] - s[i - 1][0]);
    out.push({
      el: tr.el, cause: tr.cause, name: tr.name, startMs: tr.startMs, abs: tr.abs,
      channel: ch.key, durationMs: Math.round(dur), delayMs: Math.round(t0),
      movedPx: [round(dx), round(dy)], opacity: [round(first[5], 2), round(last[5], 2)], scale: round(dScale, 2),
      easing, overshoot: peak > 1.06 ? round(peak, 2) : null,
      maxFrameGapMs: gaps.length ? Math.round(Math.max(...gaps)) : null, droppedFrames: gaps.filter((g) => g > 34).length,
      progress: prog.slice(startIdx, endIdx + 1).map(([t, v]) => [t - t0, round(v, 3)]),
      box: { x: Math.min(first[1], last[1]), y: Math.min(first[2], last[2]), w: Math.max(first[3], last[3]) + Math.abs(dx), h: Math.max(first[4], last[4]) + Math.abs(dy) },
    });
  }
  return out;
}

/** One small chart per tracked element: progress (0..1) against time. */
export async function curvesSheet(composer, tracks, out, title) {
  const use = tracks.filter((t) => !t.looping).slice(0, 8);
  if (!use.length) return null;
  const W = 380, H = 190, pad = 26;
  const charts = use.map((t) => {
    const dur = t.durationMs || 1;
    const lo = Math.min(0, ...t.progress.map((p) => p[1])), hi = Math.max(1, ...t.progress.map((p) => p[1]));
    const x = (ms) => pad + (ms / dur) * (W - pad - 8), y = (v) => H - pad - ((v - lo) / (hi - lo)) * (H - pad - 12);
    const pts = t.progress.map(([ms, v]) => `${x(ms).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    return `<div style="background:#fff;border:1px solid #ccc;padding:6px;width:${W + 14}px">
      <div style="font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.el)}</div>
      <div style="font-size:11px;color:#444">${esc(t.cause)}${t.name ? ' "' + esc(t.name) + '"' : ''} · ${esc(t.channel)} · ${t.durationMs} ms · starts ${t.startMs} ms</div>
      <svg width="${W}" height="${H}" style="display:block">
        <line x1="${pad}" y1="${y(0)}" x2="${W - 8}" y2="${y(0)}" stroke="#bbb"/><line x1="${pad}" y1="${y(1)}" x2="${W - 8}" y2="${y(1)}" stroke="#bbb" stroke-dasharray="3 3"/>
        <line x1="${x(0)}" y1="${y(0)}" x2="${x(dur)}" y2="${y(1)}" stroke="#ddd"/>
        <polyline points="${pts}" fill="none" stroke="#1d4ed8" stroke-width="2"/>
        ${t.progress.map(([ms, v]) => `<circle cx="${x(ms).toFixed(1)}" cy="${y(v).toFixed(1)}" r="1.6" fill="#1d4ed8"/>`).join('')}
        <text x="2" y="${y(1) + 4}" font-size="10" fill="#555">end</text><text x="2" y="${y(0) + 4}" font-size="10" fill="#555">start</text>
        <text x="${W - 8}" y="${H - 6}" font-size="10" fill="#555" text-anchor="end">${dur} ms</text>
      </svg>
      <div style="font-size:11px;color:#111">${esc(t.easing)}${t.overshoot ? ` · overshoots to ${t.overshoot}` : ''} · worst frame gap ${t.maxFrameGapMs} ms</div>
    </div>`;
  }).join('');
  await composer.render(`<div style="width:1600px;padding:8px;background:#f3f3f3">
    <div style="font-size:14px;font-weight:600;padding:0 0 8px">${esc(title)} — each dot is one rendered frame; the grey diagonal is linear motion</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">${charts}</div></div>`, out, { width: 1600, quality: 80 });
  return out;
}

/** Contact sheet of screencast frames cropped to one animated element, during its animation. */
export async function elementStrip(composer, frames, track, viewport, out) {
  if (!frames.length) return null;
  const t0 = track.abs, t1 = track.abs + track.delayMs + track.durationMs + 80;
  const win = frames.filter((f) => f.ts >= t0 - 40 && f.ts <= t1);
  if (win.length < 3) return null;
  const srcW = Math.round(win[0].w ? Math.min(640, win[0].w) : 640);
  const scale = srcW / viewport.width; // screencast pixels per CSS pixel
  const padPx = 24;
  // box is in page coordinates; entrance animations on load happen at scrollY 0.
  const crop = {
    x: Math.max(0, (track.box.x - padPx) * scale), y: Math.max(0, (track.box.y - padPx) * scale),
    w: Math.min(srcW, (track.box.w + padPx * 2) * scale), h: Math.min(viewport.height * scale, (track.box.h + padPx * 2) * scale), srcW,
  };
  if (crop.w < 20 || crop.h < 20 || track.box.y > viewport.height) return null;
  const picked = pickFrames(win, 12);
  const cols = crop.w / crop.h > 2.2 ? 3 : 6;
  await composer.grid(picked.map((f) => ({ dataUrl: `data:image/jpeg;base64,${f.data}`, label: `+${Math.round(f.ts - t0)} ms`, crop })), out,
    { cols, title: `${track.el} — ${track.cause}, ${track.durationMs} ms, ${track.easing}` });
  return out;
}

/** Collapse repeated animation snapshots into one inventory with plain flags. */
export function summariseAnimations(snapshots) {
  const map = new Map();
  for (const a of snapshots.flat()) {
    const key = `${a.type}|${a.name}|${a.target}`;
    if (!map.has(key)) map.set(key, a);
  }
  const all = [...map.values()];
  const LAYOUT = /^(top|left|right|bottom|width|height|margin|padding|max-?height|max-?width|inset)/i;
  const groups = new Map();
  for (const a of all) {
    const k = `${a.type}|${a.name}|${a.duration}|${a.easing}|${a.iterations}`;
    const g = groups.get(k) || { ...a, targets: 0, sample: a.target };
    g.targets++; groups.set(k, g);
  }
  const list = [...groups.values()].sort((a, b) => b.targets - a.targets).slice(0, 30).map((g) => ({
    type: g.type, name: g.name, duration: g.duration, delay: g.delay, easing: g.easing, iterations: g.iterations, props: g.props.slice(0, 6), targets: g.targets, sample: g.sample,
  }));
  return {
    total: all.length, distinct: groups.size,
    infinite: all.filter((a) => a.iterations === 'infinite').length,
    longerThan1s: all.filter((a) => a.iterations !== 'infinite' && a.duration > 1000).length,
    linearMovement: all.filter((a) => a.easing === 'linear' && a.iterations !== 'infinite' && a.props.some((p) => /transform|translate|top|left|opacity/i.test(p)) && a.duration > 120).length,
    layoutProperties: all.filter((a) => a.props.some((p) => LAYOUT.test(p))).length,
    list,
  };
}
