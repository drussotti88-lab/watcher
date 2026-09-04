/**
 * Sites this machine will not contact at all.
 *
 * ── Why this is separate from the shop toggle ───────────────────────────────
 *
 * Turning a shop off in the app already stops missions and sweeps for it, and
 * that is the right control for "not now". It is the wrong control for "not
 * from my computer, until I say so", for three reasons:
 *
 *   1. It lives in the Hub. One click in Settings, by anyone with the account,
 *      turns it back on — including a future me who is tidying something else.
 *   2. It is a decision about WATCHING. A probe, a diagnostic script, a sweep
 *      written next month, or `npm run browser` do not consult it.
 *   3. It is remote. If the Hub is unreachable the watcher falls back to its
 *      cached mission list, which is exactly the moment nobody is watching the
 *      settings.
 *
 * This is local, it lives in the machine's own config file, and it is enforced
 * at the one place every request in this program goes through: the browser
 * context. Nothing above it has to remember.
 *
 * Roberto asked for it on 4 Sep 2026, after Pokémon Center answered his own
 * browser with an Imperva "Error 15 — access denied". The reasonable response
 * to a site saying go away is to go away, and to be able to say so in one
 * place with confidence rather than by auditing every code path.
 *
 * ── This blocks by HOST, and that is not the other thing ────────────────────
 *
 * `lighten.ts` blocks by resource type and is forbidden from naming a vendor,
 * because refusing to run somebody's bot check would be defeating a control.
 * This module names hosts on purpose, and it is the opposite act: it refuses
 * to CONTACT a site at all. Asking for nothing is not evasion. The two modules
 * are kept apart so that neither one's rule can drift into the other's.
 */
import type { BrowserContext } from 'playwright';

/**
 * Does this URL belong to a host we have been told to leave alone?
 *
 * Matches the host and any subdomain of it, so "pokemoncenter.com" covers
 * "www.pokemoncenter.com" without anybody having to think about it. Matching
 * is on the parsed HOST, never on the whole URL as a string — otherwise a
 * product name or a redirect parameter containing the word would block an
 * unrelated request, and the failure would look like a network fault.
 */
export function isBlocked(url: string, hosts: readonly string[]): boolean {
  if (hosts.length === 0) return false;
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((raw) => {
    const want = String(raw ?? '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    if (!want) return false;
    return host === want || host.endsWith('.' + want);
  });
}

/**
 * A retailer name, as the Hub spells it, turned into the host it lives on.
 *
 * So the config can say "Pokemon Center" — which is what somebody reading the
 * app would think to write — as well as a bare hostname.
 */
const RETAILER_HOSTS: Record<string, string> = {
  'pokemon center': 'pokemoncenter.com',
  'pokémon center': 'pokemoncenter.com',
  pokemoncenter: 'pokemoncenter.com',
  target: 'target.com',
  walmart: 'walmart.com',
};

/** Normalise whatever the config said into hostnames. */
export function hostsFrom(entries: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const raw of entries ?? []) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value) continue;
    out.add(RETAILER_HOSTS[value] ?? value.replace(/^https?:\/\//, '').split('/')[0]!);
  }
  return [...out];
}

/**
 * Refuse every request to those hosts, for every page in this context.
 *
 * Aborted rather than answered with an empty body: an abort is the honest
 * outcome and it is what a network-level block looks like, so anything that
 * mishandles it will do so loudly here rather than quietly in a drop.
 */
export async function refuseHosts(
  context: BrowserContext,
  hosts: readonly string[],
): Promise<void> {
  if (hosts.length === 0) return;
  await context.route('**/*', (route) => {
    if (isBlocked(route.request().url(), hosts)) {
      route.abort('blockedbyclient').catch(() => {});
      return;
    }
    route.continue().catch(() => {});
  });
}
