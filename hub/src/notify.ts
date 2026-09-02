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
const COLOR_IN = 0x1f8b4c;

/** Discord caps embeds at 10 per message and 25 fields per embed. */
const MAX_FIELDS = 20;

interface Embed {
  title?: string;
  /** Makes the title a link. One click from the alert to the buy button. */
  url?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  /** The product photo, small and to the right — how you recognise it at 3am. */
  thumbnail?: { url: string };
  footer?: { text: string };
  timestamp?: string;
}

/** Discord lays out at most three inline fields per row. */
const inline = (name: string, value: string) => ({ name, value, inline: true });

const dollars = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : `$${Number(n).toFixed(2)}`;

/**
 * What to say about a count, in the same words the page uses.
 *
 * The rule is duplicated from isCapped() in page.ts rather than shared, because
 * one is server-side TypeScript and the other is a string of browser JavaScript
 * inside a template literal. If the rule changes, both change — the tests on
 * each side say so.
 *
 * The plus means the number is a ceiling and the truth is at least that. See
 * claude/why-stock-says-ten-plus.md for what we do and do not know about why.
 */
export function stockPhrase(
  quantity: number | null | undefined,
  orderLimit: number | null | undefined,
  sellable: boolean,
): string {
  if (quantity === null || quantity === undefined) return sellable ? 'in stock' : 'not sellable';
  const capped =
    quantity > 0 &&
    ((orderLimit !== null && orderLimit !== undefined && orderLimit > 0 && quantity === orderLimit) ||
      quantity === 10 ||
      quantity === 20);
  const n = capped ? `${quantity}+` : String(quantity);
  return sellable ? `${n} available` : `${n} staged`;
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
 * Something a mission is watching just became buyable.
 *
 * ── One post per product, not one post per batch ────────────────────────────
 *
 * This used to be a single embed with a field per item, which reads as a
 * digest: fine for a nightly summary, wrong for the thing you are racing. A
 * drop alert has one job — say WHAT, HOW MUCH, and WHERE in the time it takes
 * to glance at a phone — and a product sharing a card with four others has to
 * be found before it can be read.
 *
 * So each item gets its own embed: the name as the title and a link, the photo
 * as the thumbnail so it is recognised before it is read, and the numbers laid
 * out three across. Discord takes up to ten in one message, so a batch still
 * arrives as one notification rather than ten pings.
 *
 * Before this it reused the DISCOVERY template, and what actually went out was
 * titled "1 new product --" with the raw reader note as a field name and a bare
 * listing id as its value. A discovery is "this product exists". This is "the
 * thing you asked us to watch is on sale right now". Not the same message.
 *
 * ── Who this is written for ─────────────────────────────────────────────────
 *
 * People in a Discord server who are going to click through and buy it
 * themselves. Not the owner, and not the machine. So the card carries what a
 * buyer needs to decide — what it is, what it costs, whether that is a fair
 * price, who is actually selling it, and a link — and nothing about how
 * Phantom is configured.
 *
 * Whether the mission is armed is deliberately NOT carried here. Whether the owner's machine intends to
 * buy this one is his business, it tells a reader nothing they can act on, and
 * announcing to a room that a bot is about to compete with them for the same
 * box is a strange thing to put in an alert you are sending them as a favour.
 */
export interface StockItem {
  name: string;
  retailer: string;
  price: number | null;
  msrp: number | null;
  url: string;
  imageUrl: string;
  seller: string;
  sellerName: string;
  quantity: number | null;
  orderLimit: number | null;
}

export function buildStockEmbeds(items: StockItem[], now: string, note?: string): Embed[] {
  return items.slice(0, 10).map((i) => {
    const fields = [
      inline('Price', dollars(i.price)),
      inline('Stock', stockPhrase(i.quantity, i.orderLimit, true)),
      inline('Retailer', i.retailer || '—'),
    ];

    // MSRP and the gap to it, which is the whole question on a resale-priced
    // listing. Shown as a pair so the second number has something to mean.
    fields.push(inline('MSRP', dollars(i.msrp)));
    if (i.price !== null && i.msrp !== null && i.msrp > 0) {
      const over = i.price - i.msrp;
      fields.push(inline('vs MSRP', over > 0.005 ? `+${dollars(over)}` : 'at or under'));
    } else {
      fields.push(inline('vs MSRP', '—'));
    }

    // The one fact a price cannot tell you. Every mission refuses a reseller by
    // default, so an alert that does not name one invites a bad click.
    fields.push(
      inline(
        'Seller',
        i.seller === 'marketplace'
          ? `⚠️ ${i.sellerName || 'marketplace seller'}`
          : i.retailer || 'the shop',
      ),
    );

    return {
      title: clip(i.name || 'a watched listing', 240),
      ...(i.url ? { url: i.url } : {}),
      color: COLOR_IN,
      ...(i.imageUrl ? { thumbnail: { url: i.imageUrl } } : {}),
      fields,
      ...(note ? { footer: { text: note } } : {}),
      timestamp: now,
    };
  });
}

export async function announceStock(
  webhookUrl: string,
  items: StockItem[],
  now: string,
  note?: string,
): Promise<void> {
  const embeds = buildStockEmbeds(items, now, note);
  if (embeds.length) await post(webhookUrl, embeds);
}

/**
 * Proof the wiring works, sent on demand.
 *
 * Setting up a webhook is the one moment where silence is ambiguous: nothing
 * arriving could mean the URL is wrong, the channel is wrong, the deploy has
 * not picked up the variable, or simply that nothing has happened yet. A
 * button that makes a message appear collapses all four into one answer.
 */
export async function announceTest(webhookUrl: string, now: string): Promise<void> {
  await post(webhookUrl, [
    {
      title: '✅ Phantom is connected',
      description:
        'This is a test message. Real alerts arrive one card per product: in stock ' +
        'on a watched listing, stock staged before a drop, and sources that stopped working.',
      color: COLOR_IN,
      footer: { text: 'sent from Settings' },
      timestamp: now,
    },
  ]);
}

/**
 * Stock counted in a warehouse behind a listing the shop still refuses to sell.
 *
 * The one message in this file worth waking up for. Everything else here
 * reports something that already happened; this reports something that has
 * not happened yet, which is the only kind of warning you can act on.
 *
 * One embed per product, same as the in-stock alert, and red — because the
 * decision it asks for ("be at a screen in three hours") is a different
 * decision from "click now", and the two must not look alike at a glance.
 */
export interface StagedItem {
  name: string;
  retailer: string;
  quantity: number;
  url: string;
  imageUrl: string;
  releaseDate: string;
}

export function buildStagedEmbeds(items: StagedItem[], now: string, note?: string): Embed[] {
  return items.slice(0, 10).map((i) => {
    const fields = [
      inline('Stock staged', `**${i.quantity.toLocaleString('en-US')}** units`),
      inline('Retailer', i.retailer || '—'),
      inline('Buyable', 'not yet'),
    ];
    // A date turns "soon" into a plan. Only when the retailer published one.
    if (i.releaseDate) fields.push(inline('On sale', i.releaseDate));
    return {
      title: clip(i.name || 'a watched listing', 240),
      ...(i.url ? { url: i.url } : {}),
      description: 'Counted in the warehouse, and the shop is still saying no.',
      color: COLOR_STAGED,
      ...(i.imageUrl ? { thumbnail: { url: i.imageUrl } } : {}),
      fields,
      footer: { text: note ?? 'not buyable yet — this is the warning, not the drop' },
      timestamp: now,
    };
  });
}

export async function announceStaged(
  webhookUrl: string,
  items: StagedItem[],
  now: string,
  note?: string,
): Promise<void> {
  const embeds = buildStagedEmbeds(items, now, note);
  if (embeds.length) await post(webhookUrl, embeds);
}

/**
 * Somebody telling you something is wrong with your own app.
 *
 * It goes to the ops webhook when there is one, and the main one otherwise:
 * feedback is closer to "a source stopped working" than to "something is in
 * stock", and it should not land in the middle of a drop alert.
 *
 * The handle is included because "the page is broken" from a member and from
 * the owner are two different problems, and the first thing you would ask is
 * who. Nothing else about them is sent.
 */
export function buildFeedbackEmbed(who: string, text: string, now: string): Embed {
  return {
    title: '💬 Feedback',
    description: clip(text, 3800),
    color: COLOR_OPS,
    fields: [inline('From', who || 'someone signed in')],
    timestamp: now,
  };
}

export async function sendFeedback(
  webhookUrl: string,
  who: string,
  text: string,
  now: string,
): Promise<void> {
  if (!text.trim()) return;
  await post(webhookUrl, [buildFeedbackEmbed(who, text, now)]);
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
