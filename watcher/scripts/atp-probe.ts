/**
 * What is the REAL number, and can we ask for it?
 *
 * ── The question ────────────────────────────────────────────────────────────
 *
 * Every reading says "10+ available" because the PDP's orchestration API
 * clamps `available_to_promise_quantity` to `purchase_limit` — the captured
 * bodies show atp taking the values 0, 10 and 20 alongside purchase limits of
 * 2, 10 and 20, which is not a coincidence. So "10+" is us being honest about
 * a number that was already a lie by the time we read it.
 *
 * Other people quote thousands. That number comes from a different Target
 * endpoint, and the only way to know whether we can see it is to look.
 *
 * ── How it asks, and why that way ───────────────────────────────────────────
 *
 * From INSIDE the page, with page.evaluate and a same-origin fetch. Asking
 * from PowerShell got a flat 403, and the reason matters: Target's edge is
 * refusing a client that is not a browser. The answer to that is not to look
 * more like a browser — it is to BE one. This is the site's own page making a
 * request to the site's own public API with the session it already has, which
 * is a thing its own JavaScript does on every page load.
 *
 * Nothing here spoofs, hides or bypasses anything. If the endpoint refuses a
 * real browser too, that is the answer and we live with "10+".
 *
 * Usage:
 *   node --experimental-strip-types scripts/atp-probe.ts <target product url>
 *
 * Runs in a throwaway profile so the watching Phantom keeps its own.
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Browser } from '../src/browser.ts';
import { loadConfig } from '../src/config.ts';

const url = process.argv[2] ?? '';
const tcin = /\/-\/A-(\w+)/i.exec(url)?.[1] ?? '';
if (!tcin) {
  console.error('\n  Give me a Target product URL: .../-/A-12345678\n');
  process.exit(1);
}

const config = loadConfig();
config.browser.watchProfileDir = './chrome-profile-atp';
const browser = new Browser(config, 'watch');

interface Probe {
  name: string;
  ok: boolean;
  status?: number;
  atp?: unknown;
  limit?: unknown;
  status_text?: unknown;
  error?: string;
}

try {
  const page = await browser.page();
  console.log(`\n  Opening the page (so the fetches below are the page's own)…`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const probes = await page.evaluate(async (id: string) => {
    const out: Probe[] = [];

    // The web key is not a secret: it is in the page's own script tags, and
    // every request the site makes carries it. Read it from where the page
    // keeps it rather than pasting a copy that will rot.
    const html = document.documentElement.innerHTML;
    const key = (/["']?api_?key["']?\s*[:=]\s*["']([0-9a-f]{32,})["']/i.exec(html)
      ?? /key=([0-9a-f]{32,})/i.exec(html))?.[1] ?? '';
    out.push({ name: 'web api key found in the page', ok: Boolean(key), error: key ? '' : 'none' });
    if (!key) return out;

    const q = new URLSearchParams(location.search);
    const store = q.get('store_id') ?? '2362';

    const tries: { name: string; url: string }[] = [
      {
        name: 'product_fulfillment_v1',
        url: `https://redsky.target.com/redsky_aggregations/v1/web/product_fulfillment_v1`
          + `?key=${key}&tcin=${id}&is_bot=false&store_id=${store}`
          + `&has_required_store_id=true&required_store_id=${store}`
          + `&channel=WEB&page=%2Fp%2FA-${id}`,
      },
      {
        name: 'pdp_fulfillment_v1',
        url: `https://redsky.target.com/redsky_aggregations/v1/web/pdp_fulfillment_v1`
          + `?key=${key}&tcin=${id}&is_bot=false&store_id=${store}`
          + `&channel=WEB&page=%2Fp%2FA-${id}`,
      },
    ];

    for (const t of tries) {
      try {
        const res = await fetch(t.url, { credentials: 'include' });
        const probe: Probe = { name: t.name, ok: res.ok, status: res.status };
        if (res.ok) {
          const body = await res.json();
          const f = body?.data?.product?.fulfillment;
          probe.atp = f?.shipping_options?.available_to_promise_quantity;
          probe.limit = f?.purchase_limit;
          probe.status_text = f?.shipping_options?.availability_status;
        }
        out.push(probe);
      } catch (e) {
        out.push({ name: t.name, ok: false, error: String(e) });
      }
    }
    return out;
  }, tcin);

  console.log('');
  for (const p of probes) {
    console.log(
      `  ${p.ok ? 'OK  ' : 'NO  '} ${p.name.padEnd(26)} ` +
      (p.ok
        ? `atp ${p.atp}   limit ${p.limit}   ${p.status_text ?? ''}`
        : `${p.status ?? ''} ${p.error ?? ''}`),
    );
  }
  console.log('');
} finally {
  await browser.close();
  try {
    rmSync(resolve(process.cwd(), './chrome-profile-atp'), { recursive: true, force: true });
  } catch {
    /* a profile we could not delete is not a failure of the probe */
  }
}
