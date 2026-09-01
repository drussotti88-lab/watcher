/**
 * What Phantom can actually do, per retailer — the single source of truth.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * DNA Card Vault sells access to Phantom, so its membership page has to
 * describe what a buyer gets. The obvious way to do that is to write the list
 * into the marketing page, and the obvious way is wrong: the page then states
 * a claim that nothing keeps true. Target checkout lands, Walmart checkout
 * does not, and six weeks later a page somewhere still promises both.
 *
 * So the claim lives HERE, beside the code that implements it, and the vault
 * FETCHES it (`GET /api/capabilities`, public, no auth — it is marketing data
 * and carries nothing about anybody). One table, one truth, and a page that
 * cannot drift because it does not hold an opinion of its own.
 *
 * `capabilities.test.ts` then pins this table to the code: a retailer with no
 * cart driver on disk may not claim checkout, and a retailer with a driver may
 * not omit it. Adding a Walmart driver without updating this file turns a test
 * red, which is the only mechanism that keeps a document honest over time.
 *
 * ── Two axes, and the second one is the important one ────────────────────────
 *
 *   status    is it BUILT?      live | partial | planned | none
 *   audience  who GETS it?      member | owner
 *
 * `audience` exists because of a specific way this could mislead. Auto-checkout
 * at Target is genuinely live — and it is not something a membership can sell.
 * It runs on the owner's machine, signed into the owner's Target account,
 * against the owner's card. A member gets the watching: the finds, the radar,
 * the staged-stock warning, the queue alarm. Marking that difference in the
 * data is what stops the perks page from promising a robot that buys for you.
 */

export type Status = 'live' | 'partial' | 'planned' | 'none';
export type Audience = 'member' | 'owner';

export interface Ability {
  key: string;
  label: string;
  /** One sentence a buyer would understand, not a description of the code. */
  blurb: string;
  audience: Audience;
}

export interface RetailerCaps {
  key: string;
  name: string;
  /** ability key → how well it works at this shop. Absent means 'none'. */
  abilities: Record<string, Status>;
  note?: string;
  /**
   * The shop is currently refusing us.
   *
   * Additive and optional on purpose: a consumer that has never heard of this
   * field still reads correct statuses, because the abilities above are
   * downgraded at the same time. This is the human explanation of WHY, and
   * since when — which is the difference between "we never built that" and
   * "they shut the door this afternoon".
   */
  blocked?: { since: string; what: string };
}

/**
 * The abilities, defined once. The order is the order a page should show them:
 * what you notice first, then what it does about it.
 */
export const ABILITIES: readonly Ability[] = [
  {
    key: 'watch',
    label: 'Stock watching',
    blurb: 'Reads the real product page on a schedule and says what it actually said.',
    audience: 'member',
  },
  {
    key: 'discover',
    label: 'New-product discovery',
    blurb: 'Sweeps the catalogue and finds products before anyone links you to them.',
    audience: 'member',
  },
  {
    key: 'releaseDates',
    label: 'Release dates',
    blurb: 'Reads the publisher’s street date, so a pre-order has a countdown.',
    audience: 'member',
  },
  {
    key: 'stagedStock',
    label: 'Staged-stock warning',
    blurb: 'Sees warehouse stock loaded against a listing that cannot be sold yet — hours of warning before a drop opens.',
    audience: 'member',
  },
  {
    key: 'queueAlarm',
    label: 'Queue alarm',
    blurb: 'Shouts the moment a waiting room goes up, which is the loudest sign a drop is live.',
    audience: 'member',
  },
  {
    key: 'sellerCheck',
    label: 'Marketplace detection',
    blurb: 'Tells a first-party listing from a third-party reseller, so you are not shown a scalper at 1.5×.',
    audience: 'member',
  },
  {
    key: 'autoCheckout',
    label: 'Automatic checkout',
    blurb: 'Adds to cart and completes an order unattended, under a price ceiling and a daily spend cap.',
    audience: 'owner',
  },
];

/**
 * Per-retailer state. Anything not listed is 'none'.
 *
 * Target is first because it is the only shop with a verified checkout, and it
 * is the only one whose inventory API exposes a quantity we have actually seen
 * move — which is what the staged-stock warning reads.
 */
export const RETAILERS: readonly RetailerCaps[] = [
  {
    key: 'target',
    name: 'Target',
    abilities: {
      watch: 'live',
      discover: 'live',
      releaseDates: 'live',
      stagedStock: 'live',
      queueAlarm: 'live',
      sellerCheck: 'live',
      autoCheckout: 'live',
    },
    note: 'The most complete shop, and the only one with a checkout that has been verified against a real cart.',
  },
  {
    key: 'walmart',
    name: 'Walmart',
    abilities: {
      watch: 'live',
      discover: 'live',
      releaseDates: 'live',
      // The reader parses a quantity, but across every capture so far Walmart
      // has returned null for it. Claiming 'live' would be claiming a warning
      // that has never once been able to fire.
      stagedStock: 'partial',
      queueAlarm: 'live',
      sellerCheck: 'live',
      autoCheckout: 'planned',
    },
    note: 'Watching and discovery are solid. Checkout is planned; the quantity Walmart publishes has never been a real number.',
  },
  {
    key: 'pokemon-center',
    name: 'Pokémon Center',
    abilities: {
      // Downgraded to 'partial' at 16:50 UTC on 1 Sep 2026 when the shop went
      // behind Imperva, and restored at 19:50 the same day when it came back —
      // by itself, with nothing changed. The stand-down did its job and the
      // first clean read forgave the penalty.
      //
      // Left at 'live' rather than hedged forever: three hours of a wall is
      // not a permanent capability change, and a table that never recovers
      // from an outage is a table nobody trusts in either direction.
      watch: 'live',
      discover: 'live',
      releaseDates: 'partial',
      // JSON-LD carries in-stock/out-of-stock and nothing else. There is no
      // quantity to watch even in principle.
      stagedStock: 'none',
      queueAlarm: 'live',
      sellerCheck: 'none',
      autoCheckout: 'planned',
    },
    note:
      'First-party only, so there is no reseller to detect. Availability is a yes/no — no quantity ' +
      'exists to warn on. Went behind a bot wall for three hours on 1 Sep 2026 and recovered on its ' +
      'own; Phantom names a wall and stands down rather than knocking, and never tries to get past one.',
  },
];

/**
 * Ways a retailer's entry could be lying.
 *
 * Extracted so the rule is testable against a shop that IS blocked, not only
 * against whatever the table happens to say today. The first version of this
 * check looped over the real retailers looking for `blocked` — and the day
 * Pokémon Center recovered, it started passing by having nothing to look at.
 * A guard that is satisfied by an empty list is a comment.
 */
export function contradictions(r: RetailerCaps): string[] {
  const problems: string[] = [];
  if (!r.blocked) return problems;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.blocked.since)) {
    problems.push(`${r.name}: blocked.since must be a date`);
  }
  if (r.blocked.what.trim().length < 40) {
    problems.push(`${r.name}: say what happened`);
  }
  // Everything here needs the page to render. Claiming any of them works while
  // the shop is refusing to answer is the exact lie this table exists to stop
  // the vault's perks page telling.
  for (const ability of ['watch', 'discover', 'queueAlarm']) {
    if ((r.abilities[ability] ?? 'none') === 'live') {
      problems.push(`${r.name} is blocked but still claims ${ability} works`);
    }
  }
  return problems;
}

/** Everything that is not about one shop. */
export interface Feature {
  key: string;
  label: string;
  blurb: string;
  status: Status;
  audience: Audience;
}

export const FEATURES: readonly Feature[] = [
  {
    key: 'releaseRadar',
    label: 'Release radar',
    blurb: 'Every known street date ahead, soonest first.',
    status: 'live',
    audience: 'member',
  },
  {
    key: 'dropWindow',
    label: 'Drop-window burst',
    blurb: 'Checks faster while staged stock says a drop is near, and returns to a polite pace afterwards.',
    status: 'live',
    audience: 'member',
  },
  {
    key: 'activityLog',
    label: 'Activity log',
    blurb: 'Every check, with what the page said and why anything was decided.',
    status: 'live',
    audience: 'member',
  },
  {
    key: 'vaultWriteback',
    label: 'Purchases into your vault',
    blurb: 'A confirmed order becomes a collection item with its real cost basis, after you confirm the match.',
    status: 'live',
    audience: 'owner',
  },
  {
    key: 'spendCap',
    label: 'Spend cap and price ceilings',
    blurb: 'Nothing can be armed without a daily cap, and the cart gets the final word on the price.',
    status: 'live',
    audience: 'owner',
  },
  {
    key: 'memberMissions',
    label: 'Your own watchlist',
    blurb: 'Members watching their own products on their own machine.',
    status: 'planned',
    audience: 'member',
  },
];

export interface CapabilityTable {
  app: string;
  abilities: readonly Ability[];
  retailers: readonly RetailerCaps[];
  features: readonly Feature[];
}

/** The whole table, as the vault's page receives it. */
export function capabilityTable(): CapabilityTable {
  return { app: 'Phantom by DNA', abilities: ABILITIES, retailers: RETAILERS, features: FEATURES };
}

/** How a retailer does at one ability. Unlisted is 'none', never a guess. */
export function statusOf(retailerKey: string, abilityKey: string): Status {
  const r = RETAILERS.find((x) => x.key === retailerKey);
  return (r?.abilities[abilityKey] as Status | undefined) ?? 'none';
}
