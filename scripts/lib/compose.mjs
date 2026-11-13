// Image composition without native image libraries: lay images out in an HTML
// page inside a headless browser and screenshot the result.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export class Composer {
  constructor(browser) { this.browser = browser; this.ctx = null; this.tmp = null; }

  async init(tmpDir) {
    this.tmp = tmpDir;
    fs.mkdirSync(tmpDir, { recursive: true });
    this.ctx = await this.browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  }

  async close() { await this.ctx?.close().catch(() => {}); }

  /** Render an HTML body fragment and screenshot the #root element to `out` (jpeg). */
  async render(bodyHtml, out, { width = 1600, quality = 72, background = '#fff' } = {}) {
    const page = await this.ctx.newPage();
    try {
      await page.setViewportSize({ width, height: 900 });
      // Written to disk so file:// images are same-scheme and allowed to load.
      const file = path.join(this.tmp, `c-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
      fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><style>
        *{box-sizing:border-box}html,body{margin:0;background:${background};font:12px/1.3 -apple-system,Helvetica,Arial,sans-serif;color:#111}
        #root{display:inline-block;max-width:${width}px;vertical-align:top}
        img{display:block}
      </style><body><div id="root">${bodyHtml}</div></body>`);
      await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
      await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await page.locator('#root').screenshot({ path: out, type: 'jpeg', quality });
      fs.rmSync(file, { force: true });
      return out;
    } finally { await page.close().catch(() => {}); }
  }

  /** Stack or row images into one sheet. `items`: [{file, label}] */
  async sheet(items, out, { direction = 'column', width = 1600, quality = 72 } = {}) {
    const n = items.length;
    const cell = direction === 'row' ? Math.floor((width - (n - 1) * 6) / n) : width;
    const html = `<div style="display:flex;flex-direction:${direction};gap:6px;background:#d33;width:${direction === 'row' ? 'auto' : width + 'px'}">` +
      items.map((it) => `<div style="position:relative;background:#fff">
          <img src="${pathToFileURL(it.file).href}" style="width:${cell}px;height:auto">
          ${it.label ? `<span style="position:absolute;right:0;top:0;background:#d33;color:#fff;padding:2px 6px;font-size:11px;font-weight:600">${esc(it.label)}</span>` : ''}
        </div>`).join('') + '</div>';
    return this.render(html, out, { width, quality });
  }

  /** Grid of small frames with captions (motion contact sheets). `frames`: [{file|dataUrl, label, crop?}] */
  async grid(frames, out, { cols = 4, width = 1600, title = '', quality = 70 } = {}) {
    const cell = Math.floor((width - (cols + 1) * 6) / cols);
    const html = `<div style="width:${width}px;padding:6px;background:#111">` +
      (title ? `<div style="color:#fff;font-size:14px;font-weight:600;padding:2px 2px 8px">${esc(title)}</div>` : '') +
      `<div style="display:grid;grid-template-columns:repeat(${cols},${cell}px);gap:6px">` +
      frames.map((f) => {
        const src = f.dataUrl || pathToFileURL(f.file).href;
        let img = `<img src="${src}" style="width:${cell}px;height:auto">`;
        if (f.crop) {
          // crop = {x,y,w,h, srcW} in source-image pixels
          const s = cell / f.crop.w;
          img = `<div style="width:${cell}px;height:${Math.round(f.crop.h * s)}px;overflow:hidden;position:relative;background:#fff">
            <img src="${src}" style="position:absolute;left:${-f.crop.x * s}px;top:${-f.crop.y * s}px;width:${f.crop.srcW * s}px;height:auto"></div>`;
        }
        return `<div style="background:#fff">${img}<div style="background:#111;color:#fff;padding:2px 4px;font-size:12px">${esc(f.label || '')}</div></div>`;
      }).join('') + '</div></div>';
    return this.render(html, out, { width, quality, background: '#111' });
  }

  /** Downscale a single image to `width` px wide. */
  async thumb(file, out, { width = 800, quality = 62 } = {}) {
    return this.render(`<img src="${pathToFileURL(file).href}" style="width:${width}px;height:auto">`, out, { width, quality });
  }
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
