/**
 * Talking to the Hub.
 *
 * One rule runs through this file, and it is the same one that runs through
 * money.ts:
 *
 *   **Fail open on watching. Fail closed on spending.**
 *
 * If the Hub is unreachable, the Watcher keeps looking at pages and buffers
 * what it saw — losing an hour of readings because a serverless function was
 * cold is a bad trade. But it will not *buy* anything the Hub has not
 * authorised, because an unreachable Hub is exactly when a duplicate purchase
 * is most likely: nothing knows what has already been bought.
 */

export interface Mission {
  id: number;
  listingId: number;
  productKey: string;
  productName: string;
  retailer: string;
  externalId: string;
  url: string;
  enabled: boolean;
  armed: boolean;
  ceiling: number | null;
  quantity: number;
  sellerPolicy: 'retailer_only' | 'any';
  checkEverySeconds: number;
  /** A "test run" was asked for. Due now, whatever the schedule says. */
  checkNow?: boolean;
  state: string;
  price: number | null;
  lastCheckedAt: string;
  /** Target's published on-sale date, when it has one. Drives waking up. */
  releaseDate?: string | null;
}

/**
 * What is true of every mission rather than of one.
 *
 * Sent alongside the watchlist because the mandate is not complete without
 * them: a ceiling means item plus tax, and tax needs a rate.
 */
export interface Settings {
  /** Fraction, not percent. 0.0975 is 9.75%. Zero means "do not estimate". */
  taxRate: number;
  /** The most to pay for postage on any one order, on top of the ceiling. */
  shippingAllowance: number;
  /** HH:MM window in which to watch at all. Equal or blank means always. */
  activeFrom: string;
  activeUntil: string;
  /** IANA zone the window is written in. Blank means this machine's own. */
  timezone: string;
  /** The master switch. True means look at nothing. */
  paused: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  taxRate: 0,
  shippingAllowance: 0,
  activeFrom: '',
  activeUntil: '',
  timezone: '',
  paused: false,
};

export interface ObservationOut {
  listingId: number;
  /**
   * The product's real name, as the retailer's own page states it.
   *
   * The Hub mints a name from the URL slug when a listing is first added,
   * because that is all it has. A slug is lossy — Target's encodes "Pokémon"
   * as "pok-233-mon", which titleises into "Pok 233 Mon" — so the first proper
   * read replaces it. A name a person typed is never touched.
   */
  productName: string;
  state: 'in' | 'out' | 'queue' | 'unknown';
  confidence: 'exact' | 'inferred' | 'unknown';
  price: number | null;
  sellerKind: 'retailer' | 'marketplace' | 'unknown';
  sellerName: string;
  availableQuantity: number | null;
  orderLimit: number | null;
  isPreOrder: boolean;
  releaseDate: string | null;
  imageUrl: string;
  note: string;
}

export type RunOutcome = 'in_stock' | 'bought' | 'declined' | 'failed' | 'blocked';

export interface RunOut {
  missionId: number;
  outcome: RunOutcome;
  reason: string;
  state?: string;
  price?: number | null;
  sellerKind?: string;
  sellerName?: string;
  quantity?: number | null;
  total?: number | null;
}

export class HubError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'HubError';
    this.status = status;
  }
}

export interface HubOptions {
  url: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class Hub {
  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  /** Readings the Hub has not accepted yet. Kept so an outage loses nothing. */
  private readonly pending: ObservationOut[] = [];
  private readonly pendingRuns: RunOut[] = [];

  /** The last watchlist the Hub gave us, and when. See missionsOrCached(). */
  private cached: Mission[] = [];
  private cachedAt = 0;

  /**
   * The last settings the Hub gave us.
   *
   * Defaults to zero on both, which is the safe direction: no tax estimate
   * means a listed price is judged as-is and the real number is caught at the
   * cart, and no shipping allowance means postage has to be free.
   */
  private settingsValue: Settings = { ...DEFAULT_SETTINGS };

  get settings(): Settings {
    return this.settingsValue;
  }

  constructor(opts: HubOptions) {
    this.base = opts.url.replace(/\/+$/, '');
    this.token = opts.token;
    // 15s was too tight. A Vercel function that has gone cold has to boot and
    // then open a Postgres connection through the pooler before it can answer;
    // observed in the wild at over 15 seconds, which aborted the request and
    // cost a whole pass.
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.base && this.token);
  }

  get backlog(): number {
    return this.pending.length + this.pendingRuns.length;
  }

  /**
   * Why the last delivery failed.
   *
   * report() and recordRun() deliberately never throw — losing a reading is
   * worse than the outage that caused it. But a buffer that grows with no
   * stated reason is the same silent failure in a nicer coat, so the reason is
   * kept here and printed by the loop.
   */
  private lastFailure = '';

  get lastError(): string {
    return this.lastFailure;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.doFetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed: unknown = null;
      let isJson = false;
      try {
        parsed = text ? JSON.parse(text) : null;
        isJson = true;
      } catch {
        /* reported below, with the body, because the body is the clue */
      }
      if (!res.ok) {
        const detail = (parsed as { error?: string })?.error ?? text.slice(0, 200);
        throw new HubError(`${method} ${path} → ${res.status}: ${detail}`, res.status);
      }
      if (!isJson) {
        // Vercel serves a plain-text error page with a 200 while a deployment
        // swaps: "An error occurred with your deployment". Reading `.missions`
        // off that gives a TypeError three frames away from the cause, which
        // is how a two-minute deploy window becomes an afternoon of confusion.
        throw new HubError(
          `${method} ${path} → ${res.status} but the body is not JSON: ` +
            `${text.slice(0, 120).replace(/\s+/g, ' ').trim() || '(empty)'}`,
          res.status,
        );
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** What to watch. Throws when the Hub is unreachable — the caller decides. */
  async missions(now: number = Date.now()): Promise<Mission[]> {
    const data = await this.call<{ missions: Mission[]; settings?: Settings } | null>(
      'GET',
      '/api/missions/active',
    );
    if (!data || !Array.isArray(data.missions)) {
      // An empty or shapeless body is not "you have no missions". Treating it
      // as that would empty the watchlist and go quiet, which looks exactly
      // like working correctly. Throw, so the caller falls back to the list it
      // already had.
      throw new HubError('the Hub answered without a missions list', 200);
    }
    const missions = data.missions;
    // Only replace what we have if the Hub actually sent something usable. A
    // half-answer must not quietly reset the tax rate to zero.
    if (data.settings && Number.isFinite(data.settings.taxRate)) {
      const incoming = data.settings;
      this.settingsValue = {
        taxRate: Math.max(0, incoming.taxRate),
        shippingAllowance: Math.max(0, incoming.shippingAllowance ?? 0),
        // Strings, defaulted rather than trusted: a half-answer from the Hub
        // must not switch watching off, so anything unusable reads as "always".
        activeFrom: typeof incoming.activeFrom === 'string' ? incoming.activeFrom : '',
        activeUntil: typeof incoming.activeUntil === 'string' ? incoming.activeUntil : '',
        timezone: typeof incoming.timezone === 'string' ? incoming.timezone : '',
        paused: incoming.paused === true,
      };
    }
    this.cached = missions;
    this.cachedAt = now;
    return missions;
  }

  /**
   * What to watch, even when the Hub cannot say.
   *
   * `missions()` throwing used to cost the whole pass — which is failing
   * *closed* on watching, the exact opposite of the rule this file is built
   * on. A Hub that is briefly cold is not a reason to stop looking at pages;
   * the readings buffer and catch up when it comes back.
   *
   * Two things keep this safe:
   *
   *   · the watchlist goes stale. Fifteen minutes is long enough to ride out a
   *     cold start or a deploy, and short enough that a mission you paused does
   *     not keep being polled for an afternoon.
   *   · a cached mission still cannot spend. authorised() is a live call and
   *     fails closed, so the worst a stale watchlist can do is look at a page
   *     nobody asked about any more.
   */
  async missionsOrCached(
    now: number = Date.now(),
    maxAgeMs = 15 * 60_000,
  ): Promise<{ missions: Mission[]; stale: boolean; reason: string }> {
    let firstFailure = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const started = Date.now();
      try {
        return { missions: await this.missions(now), stale: false, reason: '' };
      } catch (err) {
        // One immediate retry. Observed in the wild: roughly one request in
        // three from this machine hangs until the abort fires, while the very
        // next one answers in under 100ms. Whatever that is — DNS, a cold
        // socket, something on the way out — a second attempt costs nothing
        // and turns a 90-second blind spot into a hiccup. If it fails twice,
        // it is not a hiccup, and we say so with both timings.
        const took = Math.round((Date.now() - started) / 1000);
        const line = `${(err as Error).message} after ${took}s`;
        firstFailure = firstFailure ? `${firstFailure}; then ${line}` : line;
      }
    }

    {
      const reason = firstFailure;
      const age = now - this.cachedAt;
      if (this.cachedAt === 0 || age > maxAgeMs) {
        // Nothing trustworthy to fall back on. Say so rather than watching
        // whatever we happen to remember.
        return { missions: [], stale: true, reason };
      }
      return {
        missions: this.cached,
        stale: true,
        reason: `${reason} — watching the list from ${Math.round(age / 1000)}s ago`,
      };
    }
  }

  /**
   * Report readings, oldest buffered ones first.
   *
   * Never throws. A failure leaves everything in the buffer for the next pass,
   * because a reading that cannot be delivered is still worth keeping — the
   * page's job is to show what is true, and it can catch up.
   */
  async report(observations: ObservationOut[]): Promise<{ sent: number; buffered: number }> {
    this.pending.push(...observations);
    if (this.pending.length === 0) return { sent: 0, buffered: 0 };

    const batch = this.pending.slice(0, 50);
    try {
      await this.call('POST', '/observations', { observations: batch });
      this.pending.splice(0, batch.length);
      this.lastFailure = '';
      return { sent: batch.length, buffered: this.pending.length };
    } catch (err) {
      this.lastFailure = (err as Error).message;
      return { sent: 0, buffered: this.pending.length };
    }
  }

  /** Record a run. Also buffered, for the same reason. */
  async recordRun(run: RunOut): Promise<boolean> {
    this.pendingRuns.push(run);
    const batch = [...this.pendingRuns];
    const delivered: RunOut[] = [];
    for (const r of batch) {
      try {
        await this.call('POST', '/api/runs', r);
        delivered.push(r);
      } catch (err) {
        this.lastFailure = (err as Error).message;
        break; // stop on the first failure; order matters in a log
      }
    }
    for (const d of delivered) {
      const i = this.pendingRuns.indexOf(d);
      if (i >= 0) this.pendingRuns.splice(i, 1);
    }
    return delivered.length === batch.length;
  }

  /**
   * Post activity lines.
   *
   * Returns a boolean rather than throwing, and deliberately does NOT set
   * `lastError`: that field is how the loop reports a Hub that is failing to
   * take *readings*, and letting the log's own delivery problems write to it
   * would put the least important failure in the most prominent place.
   *
   * The lines arrive already scrubbed — see watcher/src/scrub.ts. This method
   * does not scrub, because a second scrub here would make it look as though
   * the guarantee lived at the boundary, and it does not: it lives at the
   * point the line is created, which is upstream of the local file too.
   */
  async recordActivity(lines: { message: string }[]): Promise<boolean> {
    if (lines.length === 0) return true;
    try {
      await this.call('POST', '/api/activity', { lines });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Offer what a scan found to the discovery feed.
   *
   * The Hub owns the "is this new" judgement, and it has to: newness is a
   * question about everything ever seen, and the Watcher is a process that
   * restarts. All this does is hand over what is on the page right now.
   */
  async ingest(
    sourceId: string,
    items: { externalId: string; name: string; url: string; price: number | null }[],
  ): Promise<{
    received: number;
    new: number;
    announced: number;
    seeded: boolean;
    names?: string[];
  }> {
    return this.call('POST', '/ingest', { sourceId, items });
  }

  /**
   * May this mission spend, right now?
   *
   * Deliberately a live call rather than a cached flag. Authorisation to spend
   * is the one thing that must not be inferred from stale state — and if the
   * Hub cannot answer, the answer is no.
   */
  async authorised(missionId: number): Promise<{ ok: boolean; reason: string }> {
    if (!this.configured) {
      return { ok: false, reason: 'no Hub configured — spending requires one to authorise it' };
    }
    try {
      const data = await this.call<{ missions: Mission[] }>('GET', '/api/missions/active');
      const mission = (data.missions ?? []).find((m) => m.id === missionId);
      if (!mission) return { ok: false, reason: 'the Hub no longer lists this mission as active' };
      if (!mission.armed) return { ok: false, reason: 'the Hub says this mission is not armed' };
      if (mission.ceiling === null) {
        return { ok: false, reason: 'the Hub has no price ceiling for this mission' };
      }
      return { ok: true, reason: '' };
    } catch (err) {
      // Fail closed. An unreachable Hub is exactly when a duplicate purchase is
      // most likely, because nothing knows what has already been bought.
      return { ok: false, reason: `could not reach the Hub to authorise: ${(err as Error).message}` };
    }
  }
}
