/**
 * Discord output. Two channels: discoveries, and ops.
 *
 * Ops exists so a broken source is visible without you going to look. A monitor
 * that fails silently is worse than no monitor — you keep trusting it.
 *
 * Since 19 Oct 2026 the same cards also go to the owner's phone (ntfy) and
 * inbox (Resend), through deliver() - see "Phone push and email" below.
 */
import type { Discovered, SweepResult } from './types.ts';

const COLOR_NEW = 0x1f6b4f;
const COLOR_OPS = 0x8a6410;
const COLOR_STAGED = 0xc0392b;
const COLOR_IN = 0x1f8b4c;
/**
 * A pre-order is not a restock, and the card must not look like one.
 *
 * Both are worth a message — Roberto, 11 Sep 2026: "preorders should push a
 * Discord post like stocked items" — but they ask for different behaviour from
 * whoever reads them. A restock is a race you might already have lost. A
 * pre-order is a queue that will still be open after you finish your coffee,
 * and it takes your money for something arriving in weeks.
 *
 * On a phone, at a glance, the two things that separate one card from another
 * are its colour and the first few words of its title. A footer is the
 * smallest text on a Discord embed and nobody racing reads it.
 */
const COLOR_PRE = 0x5865f2;
/**
 * A drawing is not a drop, and must not ring like one.
 *
 * Walmart picks at RANDOM after the window closes, so there is nothing to race
 * and nobody should be sprinting at this card. It gets its own colour so that
 * a glance tells you which kind of thing just happened — and a card that reads
 * "go now" about a lottery is a card that spends somebody's adrenaline on
 * nothing and makes the next real drop alert worth less.
 */
const COLOR_DRAW = 0x7c5cd6;
// The queue gets its own colour, brighter than the staged red. A load-in is
// "this will happen"; a waiting room is "this is happening, and you are late".
const COLOR_QUEUE = 0xe67e22;
// Gold. The only colour on this list that is not a warning, a status or a
// category: it is the one message that means the whole system did its job.
const COLOR_WIN = 0xf5c542;
/**
 * A wall is grey, not red.
 *
 * Every other colour in this file is an instruction to move. This one is an
 * admission that the machine has been benched, and it should not sit in the
 * feed wearing a drop's clothes.
 */
const COLOR_WALL = 0x707986;

/** Discord caps embeds at 10 per message and 25 fields per embed. */
const MAX_FIELDS = 20;

export interface Embed {
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
 * How long one send may take, and how long a rate limit may make us wait.
 *
 * ── Why these exist ─────────────────────────────────────────────────────────
 *
 * Every alert is sent from inside a request the app must answer within 12
 * seconds (server.ts), and the reading that caused it has already been
 * written as "changed" by the time we post. Before 19 Oct 2026 a send had no
 * timeout and no retry: a Discord that was slow ate the whole request, and a
 * Discord that answered 429 lost the card for good, because the next reading
 * is no longer a change and nothing fires again. Four seconds, one retry and a
 * two-second cap on the wait keeps the worst case of one send (4 + 2 + 4) under
 * the deadline with room for the database.
 *
 * Mutable only so the tests can shrink them; nothing in src/ writes to it.
 */
export const sendLimits = { timeoutMs: 4_000, retryCapMs: 2_000 };

/**
 * How long a 429 asks us to wait, in ms, or null when it is longer than we
 * can afford inside one request.
 *
 * Discord says it in the JSON body as `retry_after` (seconds, fractional);
 * ntfy and Resend use the standard Retry-After header. Either is honoured.
 * A wait longer than the cap is not worth taking: the request would be over
 * before the retry landed, so the card is logged as lost instead.
 */
async function retryWaitMs(res: Response): Promise<number | null> {
  let seconds = Number.NaN;
  const header = res.headers.get('retry-after');
  if (header !== null && header.trim() !== '') seconds = Number(header);
  if (!Number.isFinite(seconds)) {
    const body = (await res.json().catch(() => null)) as { retry_after?: unknown } | null;
    seconds = Number(body?.retry_after);
  }
  // A 429 that does not say how long is given one second, which is what
  // Discord's own per-webhook bucket usually resets in.
  const ms = Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : 1_000;
  return ms <= sendLimits.retryCapMs ? ms : null;
}

/**
 * One HTTP send with a timeout and a single retry on 429, swallowing every
 * failure. Returns whether it landed.
 *
 * Shared by Discord, ntfy and Resend because all three fail the same ways:
 * slow, rate-limited, or down. `label` names the service in the log and is
 * the only thing about the destination that is ever logged - a webhook URL
 * and a push topic are both credentials.
 */
async function send(label: string, url: string, init: RequestInit): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(sendLimits.timeoutMs) });
      if (res.ok || res.status === 204) return true;
      if (res.status === 429 && attempt === 0) {
        const wait = await retryWaitMs(res);
        if (wait !== null) {
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        console.warn(`${label} rate-limited for longer than we can wait; this alert is lost`);
        return false;
      }
      const detail = await res.text().catch(() => '');
      console.warn(`${label} rejected the send`, res.status, detail.slice(0, 300));
      return false;
    } catch (err) {
      console.warn(`${label} unreachable`, err instanceof Error ? err.message : String(err));
      return false;
    }
  }
  return false;
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
async function post(url: string, embeds: Embed[]): Promise<boolean> {
  if (!url || embeds.length === 0) return false;
  return send('discord', url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: embeds.slice(0, 10) }),
  });
}

// ── Phone push and email ─────────────────────────────────────────────────────
//
// Discord is a room for a community. It is not a pager: on 19 Oct 2026 the
// owner asked for the drop-time alerts to ring his phone even when Discord is
// muted, and for the slow ones (a drawing announced days ahead, a win, a
// tester's report) to land in his inbox where they can be found again.
//
// Push goes through ntfy (a free app; you subscribe to a private topic name),
// email through Resend. Both reuse the Discord cards through embedToText, so
// there is one wording of each alert, not three that drift apart.

/** Every kind of alert the app can send, as the per-channel settings name them. */
export const ALERT_KINDS = [
  'stock',
  'preorder',
  'stillIn',
  'staged',
  'queue',
  'wall',
  'blind',
  'drawOpened',
  'drawSoon',
  'drawAnnounced',
  'drawClosing',
  'bought',
  'report',
  // 19 Oct 2026.
  'ceiling',
  'drawEve',
  'drawEnded',
  'inviteOpen',
  'inviteReminder',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** Words for the settings page. */
export const ALERT_KIND_LABELS: Record<AlertKind, string> = {
  stock: 'In stock',
  preorder: 'Pre-order opened',
  stillIn: 'Still in stock (follow-ups)',
  staged: 'Stock staged before a drop',
  queue: 'Waiting room up',
  wall: 'Human check (wall) up',
  blind: 'Phantom is blind at a shop',
  drawOpened: 'Drawing open',
  drawSoon: 'Drawing opens soon',
  drawAnnounced: 'Drawing announced',
  drawClosing: 'Drawing closing',
  bought: 'Bought',
  report: 'Tester report',
  ceiling: 'Dropped under your ceiling',
  drawEve: 'Drawing opens within a day',
  drawEnded: 'Drawing ended (watch your email)',
  inviteOpen: 'Invite window open (Best Buy)',
  inviteReminder: 'Invite running out (Best Buy)',
};

/**
 * What rings the phone when nobody has chosen: everything that asks a person
 * to move within the hour. Follow-ups are left out because the first ring was
 * the message; a drawing announced days ahead is left out because it is mail.
 */
export const DEFAULT_PUSH_KINDS: readonly AlertKind[] = [
  'stock', 'preorder', 'staged', 'queue', 'wall', 'blind',
  'drawOpened', 'drawSoon', 'drawClosing', 'bought',
  // A price falling to the ceiling is a buy decision with a clock on it; an
  // invite window is first-come; an invite running out is money left on the
  // table. All three are "move within the hour".
  'ceiling', 'inviteOpen', 'inviteReminder', 'drawEve',
];

/**
 * What goes to the inbox when nobody has chosen: the things worth finding
 * again later. In-stock is off by default because it is over before the mail
 * is read; the owner can switch it on.
 */
export const DEFAULT_EMAIL_KINDS: readonly AlertKind[] = [
  'drawAnnounced', 'bought', 'report',
  // "Watch your email for a win" belongs where the win will arrive.
  'drawEnded',
];

/** ntfy priorities: 5 rings through Do Not Disturb on most phones, 3 is normal. */
const PUSH_STYLE: Record<AlertKind, { priority: number; tags: string }> = {
  stock: { priority: 5, tags: 'rotating_light,shopping_cart' },
  queue: { priority: 5, tags: 'rotating_light,hourglass' },
  preorder: { priority: 4, tags: 'calendar' },
  staged: { priority: 4, tags: 'package' },
  wall: { priority: 4, tags: 'no_entry' },
  blind: { priority: 4, tags: 'see_no_evil' },
  drawOpened: { priority: 4, tags: 'ticket' },
  drawClosing: { priority: 4, tags: 'ticket,alarm_clock' },
  bought: { priority: 4, tags: 'tada' },
  drawSoon: { priority: 3, tags: 'ticket' },
  stillIn: { priority: 3, tags: 'repeat' },
  drawAnnounced: { priority: 3, tags: 'ticket' },
  report: { priority: 3, tags: 'memo' },
  ceiling: { priority: 5, tags: 'rotating_light,moneybag' },
  inviteOpen: { priority: 5, tags: 'rotating_light,envelope' },
  inviteReminder: { priority: 4, tags: 'alarm_clock,envelope' },
  drawEve: { priority: 3, tags: 'ticket,calendar' },
  drawEnded: { priority: 3, tags: 'ticket,email' },
};

/**
 * A string that can travel in an HTTP header.
 *
 * Headers are bytes, not text: fetch throws on anything above U+00FF, and the
 * cards are full of em dashes, middle dots, accents (Pokémon) and emoji. A
 * title that throws is a push that never sends, so it is folded to plain
 * ASCII - accents dropped, dashes and dots made into hyphens - and anything
 * left over is removed.
 */
export function asciiHeader(s: string, max = 200): string {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‒-―·•]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * "9:29 PM CT". Times shown to the owner are Central, whatever the server runs in.
 *
 * Newer ICU puts a narrow no-break space before "PM", which is invisible on a
 * screen and not ASCII in a header, so it is made an ordinary space.
 */
function centralTime(ms: number): string {
  return (
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      hour: 'numeric',
      minute: '2-digit',
    })
      .format(new Date(ms))
      .replace(/[\u202f\u00a0]/g, ' ') + ' CT'
  );
}

/**
 * A Discord card as plain words, for a push or an email.
 *
 * Discord markdown is taken out rather than translated: bold and italics
 * become plain text, a [label](link) becomes "label (link)", and Discord's own
 * <t:...> time tag - which only Discord can render - becomes a Central time.
 */
export function embedToText(e: Embed): { title: string; body: string; url: string } {
  const plain = (s: string | undefined): string =>
    String(s ?? '')
      .replace(/<t:(\d+):[a-zA-Z]>/g, (_, sec: string) => centralTime(Number(sec) * 1000))
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,;:!?])/g, '$1$2')
      .trim();
  const lines: string[] = [];
  if (e.description) lines.push(plain(e.description));
  for (const f of e.fields ?? []) lines.push(`${plain(f.name)}: ${plain(f.value)}`);
  if (e.footer?.text) lines.push(plain(e.footer.text));
  return { title: plain(e.title) || 'Phantom', body: lines.join('\n'), url: e.url ?? '' };
}

export interface PushTarget {
  /** The ntfy server, no trailing slash. https://ntfy.sh unless NTFY_URL says otherwise. */
  server: string;
  /** The private topic the owner subscribed to. Treated as a credential. */
  topic: string;
  /** Only for a protected topic or a self-hosted server. */
  token?: string;
}

export interface EmailTarget {
  apiKey: string;
  from: string;
  to: string;
}

/** One phone notification. Returns whether ntfy took it. */
export async function sendPush(
  target: PushTarget,
  kind: AlertKind | 'test',
  msg: { title: string; body: string; url: string },
): Promise<boolean> {
  if (!target.topic) return false;
  const style = kind === 'test' ? { priority: 3, tags: 'white_check_mark' } : PUSH_STYLE[kind];
  const headers: Record<string, string> = {
    Title: asciiHeader(msg.title) || 'Phantom',
    Priority: String(style.priority),
    Tags: style.tags,
  };
  // Tapping the notification opens the product. Only an ASCII https link can
  // go in a header; anything else is left off rather than breaking the send.
  if (/^https?:\/\/[\x21-\x7e]+$/.test(msg.url)) headers.Click = msg.url;
  if (target.token) headers.Authorization = `Bearer ${target.token}`;
  const server = String(target.server || 'https://ntfy.sh').replace(/\/+$/, '');
  return send('ntfy', `${server}/${encodeURIComponent(target.topic)}`, {
    method: 'POST',
    headers,
    body: msg.body.slice(0, 3_500),
  });
}

/** One email through Resend. Returns whether Resend accepted it. */
export async function sendEmail(
  target: EmailTarget,
  subject: string,
  text: string,
): Promise<boolean> {
  if (!target.apiKey || !target.from || !target.to) return false;
  return send('email', 'https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: target.from,
      to: [target.to],
      subject: subject.slice(0, 200),
      text,
    }),
  });
}

/** Everywhere one account's alerts can go, resolved once per request. */
export interface Outlets {
  rooms: Rooms;
  push: PushTarget | null;
  email: EmailTarget | null;
  pushKinds: readonly string[];
  emailKinds: readonly string[];
}

/** Is there anywhere at all to send? Asked before doing work to build a card. */
export function anyOutlet(out: Outlets | null | undefined): boolean {
  return Boolean(out && (out.rooms.main || out.push || out.email));
}

/**
 * Send one batch of cards everywhere it should go, at once.
 *
 * ── Why one function for every channel ──────────────────────────────────────
 *
 * Every alert in app.ts is decided before it gets here: edge-triggered on a
 * change, claimed in the database, muted per mission, cooled down per shop.
 * Putting push and email behind the same call means all of that applies to
 * them unchanged. A phone that buzzed for something Discord was told to keep
 * quiet about would be a second set of rules nobody wrote down.
 *
 * ── Why in parallel ─────────────────────────────────────────────────────────
 *
 * Sent one after another, three rooms, a push and an email could take five
 * timeouts end to end, inside a request with a 12 second deadline. Sent
 * together, the whole fan-out costs about as long as its slowest send, and
 * one channel being down never holds the others back.
 *
 * `room` overrides the shop routing for alerts that have their own channel
 * (wins, reports). An empty `room` means "no Discord for this one".
 */
export async function deliver<T extends { retailer?: string | null }>(
  out: Outlets,
  kind: AlertKind,
  items: readonly T[],
  build: (group: T[]) => Embed[],
  opts: { room?: string } = {},
): Promise<{ discord: number; push: number; email: number }> {
  const sent = { discord: 0, push: 0, email: 0 };
  if (items.length === 0) return sent;
  const jobs: Promise<void>[] = [];

  const groups =
    opts.room !== undefined
      ? opts.room ? [{ url: opts.room, items: [...items] }] : []
      : splitByRoom(items, out.rooms);
  for (const g of groups) {
    jobs.push(post(g.url, build(g.items)).then((ok) => { if (ok) sent.discord++; }));
  }

  const wantsPush = out.push !== null && out.pushKinds.includes(kind);
  const wantsEmail = out.email !== null && out.emailKinds.includes(kind);
  if (wantsPush || wantsEmail) {
    const texts = build([...items]).map(embedToText);
    if (wantsPush) {
      // Three at most: a phone that buzzes ten times in a second is a phone
      // that gets the app muted. Discord still carries the full batch.
      for (const t of texts.slice(0, 3)) {
        jobs.push(sendPush(out.push!, kind, t).then((ok) => { if (ok) sent.push++; }));
      }
    }
    if (wantsEmail && texts.length > 0) {
      const subject =
        texts[0]!.title + (texts.length > 1 ? ` (+${texts.length - 1} more)` : '');
      const text = texts
        .map((t) => [t.title, t.body, t.url].filter(Boolean).join('\n'))
        .join('\n\n') + '\n\n- Phantom';
      jobs.push(sendEmail(out.email!, subject, text).then((ok) => { if (ok) sent.email++; }));
    }
  }

  await Promise.allSettled(jobs);
  return sent;
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
/**
 * ── Which room a card goes to ───────────────────────────────────────────────
 *
 * One Discord channel was fine while one shop was being watched. It stops
 * being fine the moment two are, because the shops are not alike: Target is a
 * race decided in seconds, and Walmart in September 2026 is a lottery decided
 * by a coin toss days later plus a press-and-hold in front of the front door.
 * Those belong in different rooms not for tidiness but because they ask
 * different things of the person reading them — one says run, the other says
 * make a note — and a feed that mixes the two teaches you to skim both.
 *
 * The routing is by RETAILER and not by message kind, so a Walmart stock alert
 * and a Walmart drawing land in the same place. That is the whole point: the
 * room is "what is Walmart doing", and a person muting it is muting one shop
 * rather than one flavour of notification.
 *
 * ── The failure mode this is shaped around ──────────────────────────────────
 *
 * A retailer with no room of its own falls back to `main`, and so does a room
 * whose variable is unset or empty. That is deliberate and it is the whole
 * safety argument: the way this goes wrong is a typo in an environment
 * variable name, and the difference between "your Walmart alerts arrive in the
 * old channel" and "your Walmart alerts are silently discarded" is the
 * difference between a tidy-up and a missed drop.
 */
/**
 * Does this value look like a Discord webhook?
 *
 * Shape, not name. Written because a diagnostic that matched on the NAME
 * "WEBHOOK" reported that a correctly-set variable did not exist - the variable
 * was called Phantom_Drawings, after the webhook's display name in Discord,
 * which is a perfectly reasonable thing for a person to call it and contains
 * none of the words the filter was looking for. I then told the owner it was
 * not in Production, with more confidence than the tool had earned.
 *
 * A value can be checked without being trusted, and this never returns or logs
 * the value itself - only whether it is one.
 */
export function looksLikeWebhook(value: string | undefined | null): boolean {
  return /^https:\/\/(canary\.|ptb\.)?discord(app)?\.com\/api\/webhooks\/\d+\/\S+/.test(
    String(value ?? '').trim(),
  );
}

/**
 * Every environment variable currently holding a Discord webhook, BY NAME.
 *
 * Found by value shape so any spelling is visible, and reported as names only
 * so nothing secret crosses the wire. This is the answer to "I set it and the
 * flag still says no", and it has to be blind to naming convention to be worth
 * having - the whole failure it exists to catch is somebody choosing a name
 * nobody predicted.
 */
export function webhookVarNames(vars: Record<string, string | undefined>): string[] {
  return Object.keys(vars).filter((k) => looksLikeWebhook(vars[k])).sort();
}

/**
 * Variables that were clearly MEANT to be a webhook and are not one.
 *
 * The third state, and the one that kept this ambiguous. "No variable holds a
 * webhook" is true both when nothing was set and when something was set to the
 * wrong thing - an invite link instead of a webhook URL, a value with a stray
 * space, a half-paste - and those need opposite fixes. Naming the near misses
 * separates them in one look instead of one deploy per guess.
 *
 * Matched on NAME here, deliberately, because that is all a wrong value gives
 * us to go on. Names only, as everywhere else in this file.
 */
export function nearMissVarNames(vars: Record<string, string | undefined>): string[] {
  return Object.keys(vars)
    .filter((k) => /hook|discord|walmart|draw|phantom/i.test(k) && !looksLikeWebhook(vars[k]))
    .sort();
}

/**
 * Which variable holds the Walmart room.
 *
 * Three chances, narrowing in magic as they go:
 *
 *   1. DISCORD_WALMART_WEBHOOK_URL - what the docs say, what a new setup uses.
 *   2. DISCORD_DRAWS_WEBHOOK_URL - what the walkthrough said before the scope
 *      was settled as "everything Walmart".
 *   3. Any variable whose NAME mentions walmart or draw AND whose VALUE is a
 *      Discord webhook.
 *
 * Three exists because of Phantom_Drawings, and it is deliberately bounded on
 * both sides: the name has to be about this shop, and the value has to already
 * be a webhook. It cannot capture the main webhook (its name mentions neither)
 * and it cannot promote some unrelated string to a destination. The cost of
 * being wrong here is an alert in the wrong channel; the cost of being rigid
 * was an hour on the evening before a drawing, which is the trade this makes.
 *
 * The main webhook is passed in and excluded outright: one URL in two rooms
 * would post every Walmart card twice.
 */
export function shopWebhookFrom(
  vars: Record<string, string | undefined>,
  spec: {
    /** The documented names, tried in order, before any scanning. */
    named: readonly string[];
    /** A variable name about this shop. Only consulted if the value is a webhook. */
    hint: RegExp;
    /** URLs already spoken for: the main room, and any shop resolved before this one. */
    taken: readonly string[];
  },
): string {
  const spoken = spec.taken.map((t) => String(t ?? '').trim()).filter(Boolean);
  const ok = (v: string | undefined): string => {
    const url = String(v ?? '').trim();
    // The same URL in two rooms posts every card twice, so a webhook already
    // claimed by another shop - or by the main room - is not available here.
    return looksLikeWebhook(url) && !spoken.includes(url) ? url : '';
  };

  for (const name of spec.named) {
    const found = ok(vars[name]);
    if (found) return found;
  }
  for (const key of Object.keys(vars).sort()) {
    if (!spec.hint.test(key)) continue;
    const found = ok(vars[key]);
    if (found) return found;
  }
  return '';
}

/** Kept as its own name because the tests and the docs both say it. */
export function walmartWebhookFrom(
  vars: Record<string, string | undefined>,
  main: string,
): string {
  return shopWebhookFrom(vars, {
    named: ['DISCORD_WALMART_WEBHOOK_URL', 'DISCORD_DRAWS_WEBHOOK_URL'],
    hint: /walmart|draw/i,
    taken: [main],
  });
}

/**
 * Pokémon Center's room.
 *
 * `PKC` is in the hint list because that is what the community this house
 * follows calls the shop, and it is what the webhook itself was named. A
 * variable called PKC holding a Discord webhook is not ambiguous about which
 * shop it means, and asking somebody to rename it to match a constant in here
 * is the wrong way round.
 */
export function pokemonCenterWebhookFrom(
  vars: Record<string, string | undefined>,
  taken: readonly string[],
): string {
  return shopWebhookFrom(vars, {
    named: ['DISCORD_POKEMON_CENTER_WEBHOOK_URL', 'DISCORD_PKC_WEBHOOK_URL'],
    hint: /pok[e\u00e9]?mon|\bpkc\b|centre?\b/i,
    taken,
  });
}

export interface Rooms {
  /** Where anything without a room of its own goes. Never empty in practice. */
  main: string;
  /** Lowercased retailer name to webhook. Absent means "use main". */
  byRetailer: Readonly<Record<string, string>>;
}

/**
 * One shop, one key, however it happens to be spelled.
 *
 * "Pokémon Center" and "Pokemon Center" are both in this codebase already -
 * KNOWN_RETAILERS has the plain one, the capability table serves the accented
 * one - and a router that treats them as two shops sends half a shop's alerts
 * to the wrong channel and nobody notices for a week. Accents folded, spaces
 * and punctuation dropped: pokemoncenter either way.
 */
export function roomKey(retailer: string | null | undefined): string {
  return String(retailer ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function roomFor(rooms: Rooms, retailer: string | null | undefined): string {
  return rooms.byRetailer[roomKey(retailer)] || rooms.main;
}

/**
 * One batch of cards, split into the rooms they belong in.
 *
 * Returned as a list rather than a Map keyed by URL so the caller cannot
 * accidentally log the key: these strings are credentials, and a webhook URL
 * in an error message is a webhook URL in a log file. Groups come back in the
 * order their first card appeared, so a single-room setup behaves exactly as
 * it did before this existed — same cards, same order, one post.
 */
export function splitByRoom<T extends { retailer?: string | null }>(
  items: readonly T[],
  rooms: Rooms,
): { url: string; items: T[] }[] {
  const out: { url: string; items: T[] }[] = [];
  const index = new Map<string, number>();
  for (const item of items) {
    const url = roomFor(rooms, item.retailer);
    if (!url) continue;
    const at = index.get(url);
    if (at === undefined) {
      index.set(url, out.length);
      out.push({ url, items: [item] });
    } else {
      out[at]!.items.push(item);
    }
  }
  return out;
}

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
  /** Orderable ahead of release. Changes the card's colour, title and Stock field. */
  isPreOrder?: boolean;
  /** When it ships, for the field that replaces Stock on a pre-order. */
  releaseDate?: string | null;
  /**
   * The mission's ceiling, per unit. Carried so a third-party seller's card
   * can say why it was let through: Dan, 19 Oct 2026, "third-party sellers
   * count when the price is within the mission ceiling".
   */
  ceiling?: number | null;
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
    const pre = i.isPreOrder === true;
    const fields = [
      inline('Price', dollars(i.price)),
      // "0 available" on a pre-order is the normal state of something you can
      // order right now — nothing has been manufactured yet — and printed
      // beside a price it reads as a listing that is already gone.
      inline(
        pre ? 'Ships' : 'Stock',
        pre
          ? (i.releaseDate ? `on ${i.releaseDate}` : 'on release')
          : stockPhrase(i.quantity, i.orderLimit, true),
      ),
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

    // The one fact a price cannot tell you. A reseller is only announced when
    // it is inside the mission's ceiling, and the card still names it, so
    // nobody clicks through expecting the shop's own stock.
    fields.push(
      inline(
        'Seller',
        i.seller === 'marketplace'
          ? `⚠️ ${i.sellerName || 'marketplace seller'}`
          : i.retailer || 'the shop',
      ),
    );

    // Said in a sentence, at the top, because the Seller field is the sixth
    // thing on the card and a reader racing does not get that far.
    const thirdParty =
      i.seller === 'marketplace'
        ? `Third-party seller${i.sellerName ? ` (${i.sellerName})` : ''}` +
          (i.ceiling !== null && i.ceiling !== undefined
            ? `, within your ${dollars(i.ceiling)} ceiling.`
            : '.')
        : '';

    return {
      // The prefix is the point. Two seconds after the notification lands,
      // the title is all anybody has read.
      title: clip((pre ? 'PRE-ORDER · ' : '') + (i.name || 'a watched listing'), 240),
      ...(i.url ? { url: i.url } : {}),
      ...(thirdParty ? { description: thirdParty } : {}),
      color: pre ? COLOR_PRE : COLOR_IN,
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

export interface DrawItem {
  name: string;
  retailer: string;
  /**
   * The retailer's id for the item.
   *
   * Carried because the card links to the drawings SHELF rather than to the
   * item - see DRAW_HOME - so this is what tells a person which row they are
   * looking for once they are there.
   */
  externalId?: string;
  /** Walmart's canonical item URL. Kept as reference; not what the card links. */
  url: string;
  imageUrl: string;
  price: number | null;
  orderLimit: number | null;
  /** Walmart's own words. Never reformatted — they are never wrong. */
  windowText: string;
  windowLabel: string;
  /** Resolved instant, for the countdown. Null when the text was unreadable. */
  windowAt: string | null;
}

/**
 * The four things worth saying about a lottery.
 *
 * `soon` is the odd one and earns its place: it fires off the start time
 * Walmart printed on the page rather than off their `showDrawCTA` flag, so a
 * window still opens loudly if that flag never behaves the way we expect. It
 * is deliberately worded as a prediction, because that is what it is.
 */
export type DrawKind = 'opened' | 'announced' | 'closing' | 'soon' | 'eve' | 'ended';

/** "in 2 days", "in 47 minutes", "3 hours ago". */
function untilPhrase(iso: string | null, now: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.parse(now);
  if (!Number.isFinite(ms)) return '';
  const mins = Math.round(Math.abs(ms) / 60_000);
  const said =
    mins < 90 ? `${mins} minute${mins === 1 ? '' : 's'}`
    : mins < 2880 ? `${Math.round(mins / 60)} hours`
    : `${Math.round(mins / 1440)} days`;
  return ms >= 0 ? `in ${said}` : `${said} ago`;
}

/**
 * Where a drawing is actually entered.
 *
 * ── Why this is not the product link ────────────────────────────────────────
 *
 * The obvious destination for a drawing card is the item's own page, and for
 * three of five items measured on 16 Sep 2026 that page sent the reader to a
 * DIFFERENT PRODUCT:
 *
 *   30th Celebration Elite Trainer Box, 2ct Bundle
 *     -> /ip/Pokemon-Celebrations-25th-Anniversary-Elite-Trainer...
 *   30th Celebration Poster Collection, 6ct Bundle
 *     -> /ip/Pokemon-TCG-Scarlet-Violet-10-5-Unova-Poster-Collec...
 *   30th Celebration Tech Sticker Collection, 12ct Display
 *     -> /ip/Pokemon-TCG-30th-Celebration-Tech-Sticker-Alolan-Ex...  (the single)
 *
 * Nothing was corrupted at this end. The URL we hold is byte-identical to the
 * `canonicalUrl` Walmart publishes in its own page data; these bundle SKUs
 * simply have no browsable item page of their own, and Walmart's router
 * resolves the slug to a near neighbour. A link we cannot trust is worse than
 * no link on a card whose whole job is "go here and enter".
 *
 * The drawings page is the honest destination anyway: it is where an entry is
 * made, it lists every open drawing, and it cannot resolve to the wrong item.
 * The product URL stays in the database and on the dashboard row, where it is
 * a reference rather than an instruction.
 */
const DRAW_HOME: Record<string, string> = {
  Walmart: 'https://www.walmart.com/shop/collectibles/draw',
};

/**
 * One card per drawing.
 *
 * The tone is the design. Everything else this file sends is about a race you
 * might be losing right now; this is about a queue that is open for hours and
 * decided by a coin toss at the end. So it says what it is, says when it
 * shuts, and does not shout — an alert that cries drop at a lottery is one
 * that makes the next real drop alert worth less.
 */
export function buildDrawEmbeds(
  items: DrawItem[],
  now: string,
  kind: DrawKind,
): Embed[] {
  const heading =
    kind === 'opened' ? 'DRAWING OPEN'
    : kind === 'closing' ? 'DRAWING CLOSING'
    : kind === 'soon' ? 'DRAWING OPENS SOON'
    : kind === 'eve' ? 'DRAWING OPENS WITHIN A DAY'
    : kind === 'ended' ? 'DRAWING ENDED'
    : 'DRAWING ANNOUNCED';

  return items.slice(0, 10).map((i) => {
    const fields = [
      inline('Price', dollars(i.price)),
      inline(
        kind === 'closing' ? 'Closes'
          : kind === 'opened' ? (/start/i.test(i.windowLabel) ? 'Opened' : 'Open until')
          : kind === 'ended' ? 'Window'
          : 'Opens',
        i.windowText || 'not stated',
      ),
      inline('Retailer', i.retailer || '—'),
    ];
    const until = kind === 'ended' ? '' : untilPhrase(i.windowAt, now);
    // "Time left: 40 minutes ago" is what an open drawing would say when it
    // was called open from a START that has passed - so a time in the past is
    // only shown where it is a start being counted down to.
    const past = i.windowAt ? Date.parse(i.windowAt) < Date.parse(now) : false;
    if (until && !(past && (kind === 'opened' || kind === 'closing'))) {
      fields.push(
        inline(kind === 'announced' || kind === 'soon' || kind === 'eve' ? 'That is' : 'Time left', until),
      );
    }
    // The link goes to the shelf, so the card has to say which row to look
    // for once you are there.
    if (i.externalId) fields.push(inline('Item', i.externalId));
    if (i.orderLimit !== null && i.orderLimit !== undefined) {
      // Said because the limit is what a commitment gets multiplied by: three
      // of a $239 bundle is seven hundred dollars if the draw comes in.
      fields.push(inline('Limit', `${i.orderLimit} per entry`));
    }

    // The drawings page, never the item page. See DRAW_HOME for the three
    // items whose own link went to a different product.
    const go = DRAW_HOME[i.retailer] ?? '';
    return {
      title: clip(`${heading} · ${i.name || 'a collectibles drawing'}`, 240),
      ...(go ? { url: go } : {}),
      color: COLOR_DRAW,
      ...(i.imageUrl ? { thumbnail: { url: i.imageUrl } } : {}),
      fields,
      footer: {
        text:
          kind === 'closing'
            ? 'Entry closes soon and you have not marked this entered. Winners are drawn at random.'
            : kind === 'soon'
              ? 'This is Walmart\u2019s own stated start time, not a confirmed open button \u2014 the page may take a few minutes to catch up. Free, one entry per account, drawn at random.'
            : kind === 'eve'
              ? 'A reminder the day before. Nothing to do until it opens \u2014 free, one entry per account, drawn at random.'
            : kind === 'ended'
              ? 'The window has shut. Walmart draws winners at random and places the order for them \u2014 watch your email from Walmart for a win. Nothing else will tell you.'
              : 'Free, one entry per account. Winners are drawn at random after the window closes \u2014 entering early is worth no more than entering late.',
      },
      timestamp: now,
    };
  });
}

export async function announceDraw(
  webhookUrl: string,
  items: DrawItem[],
  now: string,
  kind: DrawKind,
): Promise<void> {
  const embeds = buildDrawEmbeds(items, now, kind);
  if (embeds.length) await post(webhookUrl, embeds);
}

/**
 * "Dropped to $X — within your $Y ceiling."
 *
 * The in-stock card, with the one sentence that makes it a different event
 * put first. Same fields, same photo, same link: the reader racing to it
 * needs exactly what the in-stock card gives, plus why it is news when the
 * listing was in stock an hour ago too. The title says it before anything
 * else does, because two seconds after the phone buzzes that is all anybody
 * has read.
 */
export function buildCeilingEmbeds(items: StockItem[], now: string): Embed[] {
  return buildStockEmbeds(items, now, 'already in stock - the price is what moved').map((e, n) => {
    const i = items[n]!;
    const who =
      i.seller === 'marketplace'
        ? ` Sold by ${i.sellerName || 'a third-party seller'}, not ${i.retailer || 'the shop'}.`
        : '';
    return {
      ...e,
      title: clip(`UNDER YOUR CEILING · ${i.name || 'a watched listing'}`, 240),
      description: `Dropped to ${dollars(i.price)} — within your ${dollars(i.ceiling ?? null)} ceiling.${who}`,
    };
  });
}

/** One Best Buy listing whose invite state is worth saying. */
export interface InviteItem {
  name: string;
  retailer: string;
  url: string;
  imageUrl: string;
  price?: number | null;
  /** For a reminder: when the invitation runs out, ISO. */
  expiresAt?: string | null;
  /** For a reminder: minutes left when it was claimed. */
  minutesLeft?: number | null;
}

function leftPhrase(min: number): string {
  if (min >= 90) return `${Math.round(min / 60)} hours`;
  return `${Math.max(1, Math.round(min))} minutes`;
}

/**
 * Best Buy's invite system, said as what it is.
 *
 * `open`: the product page is offering "ask for an invite" right now. It says
 * plainly that asking is the reader's job - Phantom never presses that button,
 * because an invite request is the account holder applying to buy, and it
 * reads pages without signing in. `reminder`: the reader said they got an
 * invite, Best Buy gives 24 hours, and this one is counting down.
 */
export function buildInviteEmbed(i: InviteItem, now: string, kind: 'open' | 'reminder'): Embed {
  const fields = [inline('Retailer', i.retailer || 'Best Buy')];
  if (i.price !== null && i.price !== undefined) fields.unshift(inline('Price', dollars(i.price)));
  if (kind === 'reminder' && i.expiresAt) {
    fields.push(inline('Runs out', discordTime(i.expiresAt)));
  }
  const left = i.minutesLeft ?? null;
  return {
    title: clip(
      kind === 'open'
        ? `INVITE WINDOW OPEN · ${i.name || 'a watched listing'}`
        : `INVITE RUNS OUT IN ${left === null ? 'UNDER A DAY' : leftPhrase(left).toUpperCase()} · ${i.name || 'a watched listing'}`,
      240,
    ),
    ...(i.url ? { url: i.url } : {}),
    description:
      kind === 'open'
        ? 'Best Buy is taking invite requests for this right now. Ask for one on the product page yourself - Phantom never asks for you.'
        : 'You said you got the invite. Buy it on the product page before it runs out.',
    color: COLOR_QUEUE,
    ...(i.imageUrl ? { thumbnail: { url: i.imageUrl } } : {}),
    fields,
    footer: {
      text:
        kind === 'open'
          ? 'If one arrives, press "I got the invite" in the app and it will remind you at 12 hours, 2 hours and 30 minutes left.'
          : 'Reminders ride on Phantom’s check-ins: they arrive while Phantom is running.',
    },
    timestamp: now,
  };
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
  'Best Buy': 'https://www.bestbuy.com',
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
      inline('Seen', discordTime(at)),
      inline('Product pages', 'will say sold out — ignore that'),
    ],
    footer: {
      text: 'Phantom does not join queues or answer bot checks. This one is yours.',
    },
    timestamp: now,
  };
}

/**
 * The shop has put a human check in front of this browser.
 *
 * ── Why this needed to reach a phone ────────────────────────────────────────
 *
 * A wall was recorded, counted, and shown on the readiness banner in the app -
 * which is the surface least likely to be open, for exactly the reason the
 * queue alert already argued: walls go up during evening drops. The failure
 * shape is the worst one this project has: Phantom gets walled, stands down,
 * and goes quiet. A quiet channel then means either "nothing has dropped yet"
 * or "your watcher has been blind for forty minutes", and those look identical.
 *
 * ── What it must not claim ──────────────────────────────────────────────────
 *
 * A wall is not a drop signal. Shops raise their defences when something is
 * dropping AND when they simply decide a browser looks wrong, and this code
 * cannot tell the two apart from one page. So the card says what is TRUE -
 * this browser was stopped, reading has paused, here is for how long - and
 * names the ambiguity rather than resolving it in the exciting direction. An
 * alert that cries drop at a bot check is one that gets muted before the night
 * it mattered.
 *
 * ── And it says whose job the check is ──────────────────────────────────────
 *
 * Phantom does not touch a press-and-hold, a CAPTCHA or any other human check,
 * now or later. That is not a limitation to be apologised for in a footer; it
 * is the line this whole program is built on, and the person reading the card
 * needs to know the next move is theirs.
 */
export interface WallItem {
  retailer: string;
  /** When it was seen, ISO. */
  at: string;
  /** What the detector called it: "Press-and-hold check", and so on. */
  reason?: string;
  /** Minutes this shop is being rested, when the watcher said. */
  restingMinutes?: number | null;
  /** The twice-a-day reminder for a wall that has not lifted. */
  still?: boolean;
}

/**
 * A time as Discord's own timestamp tag, which every reader's app shows in
 * THEIR zone. `toLocaleTimeString` ran on Vercel, in UTC, so a wall seen at
 * 9:29am in Chicago said "2:29:10 PM" on the card.
 */
export function discordTime(iso: string | null | undefined): string {
  const ms = Date.parse(String(iso ?? ''));
  return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:t>` : 'just now';
}

export function buildWallEmbed(i: WallItem, now: string): Embed {
  const home = SHOP_HOME[i.retailer] ?? '';
  const fields = [
    inline('Shop', i.retailer || '—'),
    inline('Seen', discordTime(i.at)),
    inline('Check', i.reason || 'a human check'),
  ];
  if (i.restingMinutes) {
    fields.push(inline('Not reading for', `${i.restingMinutes} min`));
  }
  const shop = (i.retailer || 'A SHOP').toUpperCase();
  return {
    title: i.still ? `${shop} STILL HAS A HUMAN CHECK UP` : `${shop} PUT A HUMAN CHECK UP`,
    ...(home ? { url: home } : {}),
    description:
      '**Phantom is standing down and will not touch the check.** Reading has ' +
      'paused for this shop, so treat the quiet as blindness rather than as ' +
      'nothing happening.\n\n' +
      'This does not on its own mean a drop is live - shops raise their ' +
      'defences at drop time and also when a browser simply looks wrong. ' +
      'If you are waiting on one, **look yourself**.\n\n' +
      '_Said once when a wall goes up, then every 12 hours while it stands._',
    color: COLOR_WALL,
    fields,
    footer: {
      text: 'Press-and-hold and CAPTCHAs are a person\u2019s job, never this program\u2019s.',
    },
    timestamp: now,
  };
}

export async function announceWalls(
  webhookUrl: string,
  walls: WallItem[],
  now: string,
): Promise<void> {
  if (walls.length === 0) return;
  await post(webhookUrl, walls.slice(0, 3).map((w) => buildWallEmbed(w, now)));
}

/**
 * Phantom cannot see this shop, and does not know why.
 *
 * The companion to the wall card, for the walls nobody has taught it to
 * recognise yet. Said as blindness rather than as an outage, because that is
 * the part that matters to the reader: whatever is happening at this shop
 * right now, nothing is watching it.
 */
export interface BlindItem {
  retailer: string;
  checks: number;
  minutes: number;
}

export function buildBlindEmbed(i: BlindItem, now: string): Embed {
  const home = SHOP_HOME[i.retailer] ?? '';
  return {
    title: `${(i.retailer || 'A SHOP').toUpperCase()}: PHANTOM IS BLIND`,
    ...(home ? { url: home } : {}),
    description:
      `**Every read of this shop has failed for the last ${i.minutes} minutes** ` +
      `(${i.checks} checks), and none of it looked like a wall the detector knows.\n\n` +
      'Whatever is live there right now, nothing is watching it. **Check by hand** ' +
      'if you are expecting stock. The usual causes are a new kind of bot check or ' +
      'the shop changing its pages - either way it needs a person to look.',
    color: COLOR_WALL,
    fields: [
      inline('Shop', i.retailer || '\u2014'),
      inline('Failed reads', String(i.checks)),
      inline('For at least', `${i.minutes} min`),
    ],
    footer: { text: 'Said once an hour while it lasts, so it cannot be mistaken for a quiet day.' },
    timestamp: now,
  };
}

export async function announceBlind(webhookUrl: string, items: BlindItem[], now: string): Promise<void> {
  if (items.length === 0) return;
  await post(webhookUrl, items.slice(0, 3).map((i) => buildBlindEmbed(i, now)));
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
