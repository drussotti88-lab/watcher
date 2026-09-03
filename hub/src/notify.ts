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
// The queue gets its own colour, brighter than the staged red. A load-in is
// "this will happen"; a waiting room is "this is happening, and you are late".
const COLOR_QUEUE = 0xe67e22;
// Gold. The only colour on this list that is not a warning, a status or a
// category: it is the one message that means the whole system did its job.
const COLOR_WIN = 0xf5c542;

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
  /** The product photo, full width. Only the win uses it. */
  image?: { url: string };
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
  /**
   * Whether the retailer will actually put it in a cart. null = did not say.
   *
   * Only Walmart states it, and it is the difference between an alert that is
   * true and an alert that is useful.
   */
  addToCart?: boolean | null;
}

/**
 * In stock, or in stock AND buyable?
 *
 * Learned at 8pm on 2 Sep 2026, from Walmart's own page data during a live
 * drop: `IN_STOCK`, sold by `Walmart.com`, `canAddToCart: false`, all true at
 * the same instant. The item was real and it was behind a per-item waiting
 * room that only a signed-in person could join.
 *
 * A competing tracker alerted "In Stock" on that data, and it was not wrong —
 * it was just not useful, because it sent a room full of people to a page with
 * no button on it. Saying which of the two states this is costs one field and
 * is the whole difference.
 */
export function buyablePhrase(addToCart: boolean | null | undefined): string | null {
  if (addToCart === true) return '✅ add to cart works';
  if (addToCart === false) return '⏳ NOT addable — queue or hold';
  // Target and Pokémon Center never say. Silence is not "no", and a field
  // reading "unknown" on two retailers out of three is noise.
  return null;
}

export function buildStockEmbeds(items: StockItem[], now: string, note?: string): Embed[] {
  return items.slice(0, 10).map((i) => {
    const fields = [
      inline('Price', dollars(i.price)),
      inline('Stock', stockPhrase(i.quantity, i.orderLimit, true)),
      inline('Retailer', i.retailer || '—'),
    ];

    // Directly after Stock, because it qualifies it. A reader who sees "In
    // stock" and stops reading has to hit this next.
    const buyable = buyablePhrase(i.addToCart);
    if (buyable) fields.push(inline('Buyable', buyable));

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

/** Where to go when a shop puts a queue up. Home page: the queue is site-wide. */
const SHOP_HOME: Record<string, string> = {
  Walmart: 'https://www.walmart.com',
  Target: 'https://www.target.com',
  'Pokemon Center': 'https://www.pokemoncenter.com',
};

/**
 * A waiting room went up.
 *
 * The one alert that asks a person to do something immediately, so it is
 * written as an instruction rather than a status. There is no product here on
 * purpose: a queue is site-wide, it is not attached to a listing, and while it
 * is up the product page still says sold out — so naming a product would put
 * the reader on the one page that is lying to them.
 *
 * What is scarce is a place in the line, and it is scarce from the second the
 * queue opens. Everything about this message serves getting the reader there.
 */
export function buildQueueEmbed(retailer: string, at: string, now: string): Embed {
  const home = SHOP_HOME[retailer] ?? '';
  return {
    title: `WAITING ROOM UP AT ${(retailer || 'A SHOP').toUpperCase()}`,
    ...(home ? { url: home } : {}),
    description:
      'A drop is very likely live right now. **Get in line yourself** — a place ' +
      'in the queue is the scarce thing, and it stops being available the ' +
      'longer this sits.',
    color: COLOR_QUEUE,
    fields: [
      inline('Shop', retailer || '—'),
      inline('Seen', at ? new Date(at).toLocaleTimeString('en-US') : 'just now'),
      inline('Product pages', 'will say sold out — ignore that'),
    ],
    footer: {
      text: 'Phantom does not join queues or answer bot checks. This one is yours.',
    },
    timestamp: now,
  };
}

export async function announceQueues(
  webhookUrl: string,
  sightings: { retailer: string; at: string }[],
  now: string,
): Promise<void> {
  if (sightings.length === 0) return;
  await post(
    webhookUrl,
    sightings.slice(0, 3).map((q) => buildQueueEmbed(q.retailer, q.at, now)),
  );
}

/**
 * Something was bought.
 *
 * The one message everything else exists to make possible, and until 3 Sep
 * 2026 it was never sent: a confirmed order wrote a row and said nothing. The
 * staged alert, the stock alert and the queue alert had all been built, and
 * the only event with no channel was the win.
 *
 * Written to be read once and felt, not scanned. The title is the verb. The
 * description says the price actually paid, because a number in a field is a
 * fact and a number in a sentence is a result. The photo is large rather than
 * a thumbnail — this is the card you screenshot.
 */
export interface BoughtItem {
  name: string;
  retailer: string;
  /** Per unit, as charged. */
  price: number | null;
  /** The whole order, when the cart said so. */
  total: number | null;
  quantity: number | null;
  msrp: number | null;
  url: string;
  imageUrl: string;
}

export function buildBoughtEmbed(i: BoughtItem, now: string): Embed {
  const qty = i.quantity && i.quantity > 1 ? `${i.quantity} × ` : '';
  const paid = i.total !== null && i.total !== undefined ? dollars(i.total) : dollars(i.price);
  const saved =
    i.price !== null && i.msrp !== null && i.msrp > 0 && i.price <= i.msrp + 0.005
      ? ' at retail'
      : '';
  return {
    title: `BOUGHT — ${clip(i.name || 'a watched listing', 200)}`,
    ...(i.url ? { url: i.url } : {}),
    description: `**${qty}${paid}${saved}** from ${i.retailer || 'the shop'}. The retailer confirmed the order.`,
    color: COLOR_WIN,
    // Full-width image, not a thumbnail. See the note above.
    ...(i.imageUrl ? { image: { url: i.imageUrl } } : {}),
    fields: [
      inline('Paid', paid),
      inline('MSRP', dollars(i.msrp)),
      inline('Retailer', i.retailer || '—'),
    ],
    footer: { text: 'Phantom · confirmed by the retailer, not by a click that seemed to work' },
    timestamp: now,
  };
}

export async function announceBought(webhookUrl: string, item: BoughtItem, now: string): Promise<void> {
  await post(webhookUrl, [buildBoughtEmbed(item, now)]);
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
 * A tester's Phantom has filed a report.
 *
 * Deliberately thin: the note, the one-line summary, and where to read the
 * rest. The report body is a console dump, and a chat room is neither the
 * place to read one nor the place to test how well it was scrubbed.
 */
export function buildReportEmbed(input: {
  id: number;
  handle: string;
  note: string;
  summary: string;
}): Embed {
  return {
    title: `REPORT #${input.id} FROM ${(input.handle || 'someone').toUpperCase()}`,
    description: input.note.slice(0, 400) || '(they did not add a note)',
    color: COLOR_QUEUE,
    fields: [
      { name: 'What the machine says', value: input.summary.slice(0, 900) || 'nothing obvious', inline: false },
      { name: 'Read it', value: `npm run reports ${input.id}`, inline: false },
    ],
  };
}

export async function announceReport(
  webhookUrl: string,
  input: { id: number; handle: string; note: string; summary: string },
): Promise<void> {
  await post(webhookUrl, [buildReportEmbed(input)]);
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
