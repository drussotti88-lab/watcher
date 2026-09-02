/**
 * Discord output. Two channels: discoveries, and ops.
 *
 * Ops exists so a broken source is visible without you going to look. A monitor
 * that fails silently is worse than no monitor — you keep trusting it.
 */
import type { Discovered, SweepResult } from './types.ts';

const COLOR_NEW = 0x1f6b4f;
const COLOR_OPS = 0x8a6410;
const COLOR_STAGED = 0xc0392b;

/** Discord caps embeds at 10 per message and 25 fields per embed. */
const MAX_FIELDS = 20;

interface Embed {
  title?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function buildDiscoveryEmbed(
  label: string,
  retailer: string,
  items: Discovered[],
  now: string,
): Embed {
  const shown = items.slice(0, MAX_FIELDS);
  const fields = shown.map((i) => ({
    name: clip(i.name || i.externalId, 240),
    value: clip(i.url ? `[${i.externalId}](${i.url})` : i.externalId, 1000),
  }));

  const extra = items.length - shown.length;
  return {
    title: `🆕 ${items.length} new ${items.length === 1 ? 'product' : 'products'} — ${retailer}`,
    description:
      `Seen for the first time in **${label}**.` +
      (extra > 0 ? `\n_${extra} more not listed._` : ''),
    color: COLOR_NEW,
    fields,
    footer: { text: 'catalog discovery · not a stock signal' },
    timestamp: now,
  };
}

export function buildOpsEmbed(results: SweepResult[], now: string): Embed | null {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return null;
  return {
    title: `⚠️ ${failed.length} source${failed.length === 1 ? '' : 's'} failed`,
    color: COLOR_OPS,
    fields: failed.slice(0, MAX_FIELDS).map((r) => ({
      name: clip(r.label, 240),
      value: clip(r.error ?? 'unknown error', 1000),
    })),
    timestamp: now,
  };
}

/**
 * Post to Discord, swallowing every failure.
 *
 * Notification is the least important thing a sweep does — the discovery is
 * already recorded in D1 by the time we get here. If Discord is down, or the
 * webhook URL is wrong, the sweep must still succeed. That means catching the
 * *thrown* case (bad host, DNS failure, timeout) and not just a non-2xx
 * response, which is the trap this originally fell into.
 */
async function post(url: string, embeds: Embed[]): Promise<void> {
  if (!url || embeds.length === 0) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: embeds.slice(0, 10) }),
    });
    if (!res.ok && res.status !== 204) {
      const detail = await res.text().catch(() => '');
      console.warn('discord rejected the post', res.status, detail.slice(0, 300));
    }
  } catch (err) {
    console.warn('discord unreachable', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Stock counted in a warehouse behind a listing the shop still refuses to sell.
 *
 * The one message in this file that is worth waking up for. Everything else
 * here reports something that already happened; this reports something that
 * has not happened yet, which is the only kind of warning you can act on.
 *
 * Red, and it says the number. "A drop looks near" without the size of the
 * load-in is a nudge; "31,000 units" is a decision.
 */
export function buildStagedEmbed(
  items: { name: string; retailer: string; quantity: number; url: string }[],
  now: string,
): Embed | null {
  if (items.length === 0) return null;
  return {
    title: `🚨 STOCK LOADED — a drop looks near`,
    description:
      items.length === 1
        ? 'Counted in the warehouse, and the shop is still saying no.'
        : `${items.length} listings are counted and not sellable yet.`,
    color: COLOR_STAGED,
    fields: items.slice(0, MAX_FIELDS).map((i) => ({
      name: clip(i.name || 'a watched listing', 240),
      value: clip(
        `**~${i.quantity.toLocaleString('en-US')} units** at ${i.retailer || 'the shop'}` +
          (i.url ? `\n[open the listing](${i.url})` : ''),
        1000,
      ),
    })),
    footer: { text: 'not buyable yet — this is the warning, not the drop' },
    timestamp: now,
  };
}

export async function announceStaged(
  webhookUrl: string,
  items: { name: string; retailer: string; quantity: number; url: string }[],
  now: string,
): Promise<void> {
  const embed = buildStagedEmbed(items, now);
  if (embed) await post(webhookUrl, [embed]);
}

export async function announce(
  webhookUrl: string,
  label: string,
  retailer: string,
  items: Discovered[],
  now: string,
): Promise<void> {
  if (items.length === 0) return;
  await post(webhookUrl, [buildDiscoveryEmbed(label, retailer, items, now)]);
}

export async function reportOps(
  webhookUrl: string,
  results: SweepResult[],
  now: string,
): Promise<void> {
  const embed = buildOpsEmbed(results, now);
  if (embed) await post(webhookUrl, [embed]);
}
