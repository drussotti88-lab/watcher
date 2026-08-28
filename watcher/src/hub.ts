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
  state: string;
  price: number | null;
  lastCheckedAt: string;
}

export interface ObservationOut {
  listingId: number;
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

  constructor(opts: HubOptions) {
    this.base = opts.url.replace(/\/+$/, '');
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
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
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* a non-JSON body is reported as-is below */
      }
      if (!res.ok) {
        const detail = (parsed as { error?: string })?.error ?? text.slice(0, 200);
        throw new HubError(`${method} ${path} → ${res.status}: ${detail}`, res.status);
      }
      return parsed as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** What to watch. Throws when the Hub is unreachable — the caller decides. */
  async missions(): Promise<Mission[]> {
    const data = await this.call<{ missions: Mission[] }>('GET', '/api/missions/active');
    return data.missions ?? [];
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
