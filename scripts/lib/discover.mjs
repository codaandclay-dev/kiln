// Page discovery: breadth-first link following from the start URL, topped up
// from sitemap.xml. Navigation order wins, so the pages a visitor is steered
// to are probed before long tails like blog archives.
import { normalizeUrl, log, pool } from './util.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function fetchText(url, ms = 10000) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

async function sitemapUrls(origin) {
  const seen = new Set();
  const queue = [`${origin}/sitemap.xml`];
  const robots = await fetchText(`${origin}/robots.txt`);
  for (const m of (robots || '').matchAll(/^\s*sitemap:\s*(\S+)/gim)) queue.push(m[1]);
  const urls = [];
  let fetched = 0;
  while (queue.length && fetched < 6) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm); fetched++;
    const xml = await fetchText(sm);
    if (!xml) continue;
    const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
    if (/<sitemapindex/i.test(xml)) queue.push(...locs); else urls.push(...locs);
  }
  return { urls, found: urls.length > 0 };
}

/** Group key used to stop one template (blog posts, case studies) eating the page budget. */
function sectionKey(url) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  return parts.length >= 2 ? parts[0] : null;
}

export async function discover(browser, startUrl, { maxPages = 25, perSection = 3 } = {}) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
  await ctx.route('**/*', (route) => (['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue()));

  // Resolve redirects (http -> https, apex -> www) so the origin is the real one.
  const first = await ctx.newPage();
  let origin, home;
  try {
    await first.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    origin = new URL(first.url()).origin;
    home = normalizeUrl(first.url(), first.url(), origin);
  } finally { await first.close().catch(() => {}); }

  const order = [];            // accepted pages in priority order
  const depth = new Map([[home, 0]]);
  const sectionCount = new Map();
  const skipped = [];
  const titles = new Map();
  const seenPaths = new Set();
  const accept = (url) => {
    // The same path with a different query string is the same page in another state, not a new page.
    const pathname = new URL(url).pathname;
    if (seenPaths.has(pathname)) { skipped.push(url); return false; }
    seenPaths.add(pathname);
    const key = sectionKey(url);
    if (key) {
      const n = sectionCount.get(key) || 0;
      if (n >= perSection) { skipped.push(url); return false; }
      sectionCount.set(key, n + 1);
    }
    order.push(url);
    return true;
  };
  accept(home);

  let frontier = [home];
  const visited = new Set();
  const visitBudget = maxPages * 2;
  while (frontier.length && order.length < maxPages && visited.size < visitBudget) {
    const batch = frontier.splice(0, 4).filter((u) => !visited.has(u));
    const found = await pool(batch, 4, async (url) => {
      visited.add(url);
      const page = await ctx.newPage();
      try {
        const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        if (!res || res.status() >= 400) return [];
        await page.waitForTimeout(1200); // let client-rendered navs mount
        titles.set(url, await page.title().catch(() => ''));
        return await page.evaluate(() => {
          const inNav = (a) => !!a.closest('header, nav, [role=navigation]');
          const inFooter = (a) => !!a.closest('footer');
          return [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, rank: inNav(a) ? 0 : inFooter(a) ? 2 : 1 }));
        });
      } catch { return []; }
      finally { await page.close().catch(() => {}); }
    });
    const next = [];
    batch.forEach((from, i) => {
      for (const l of (found[i] || []).sort((a, b) => a.rank - b.rank)) {
        const n = normalizeUrl(l.href, from, origin);
        if (!n || depth.has(n)) continue;
        depth.set(n, depth.get(from) + 1);
        next.push(n);
      }
    });
    for (const n of next) {
      if (order.length >= maxPages) { skipped.push(n); continue; }
      if (accept(n)) frontier.push(n);
    }
  }
  await ctx.close().catch(() => {});

  const sm = await sitemapUrls(origin);
  let fromSitemap = 0;
  for (const raw of sm.urls) {
    const n = normalizeUrl(raw, origin, origin);
    if (!n || depth.has(n)) continue;
    depth.set(n, 99);
    if (order.length >= maxPages) { skipped.push(n); continue; }
    if (accept(n)) fromSitemap++;
  }

  log(`discovered ${order.length} pages (${fromSitemap} only in sitemap, ${skipped.length} left out)`);
  return {
    origin, home,
    pages: order.map((url) => ({ url, depth: depth.get(url), title: titles.get(url) || '' })),
    skipped: [...new Set(skipped)],
    sitemapFound: sm.found,
  };
}
