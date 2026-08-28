/**
 * The database seam.
 *
 * One interface, two implementations: Supabase's Postgres in production, and
 * PGlite — real Postgres compiled to WebAssembly — in the tests. That second
 * one is the point. The previous version of this Hub tested SQL against
 * SQLite, which agrees with Postgres right up until it doesn't, and the
 * disagreements are silent: SQLite would happily accept a statement Postgres
 * rejects, and hand back a number where Postgres hands back a string.
 *
 * Everything above this file speaks `Sql` and knows nothing about either.
 */

export interface Statement {
  text: string;
  params?: unknown[];
}

export interface Sql {
  /** Run one query with $1-style parameters and return its rows. */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /**
   * Run several statements as one unit.
   *
   * Postgres gives us a real transaction here, which D1's `batch` did not.
   * Discovery inserts either all land or none do.
   */
  batch(statements: Statement[]): Promise<void>;
  /** Run a script of several statements. Migrations only. */
  exec(script: string): Promise<void>;
}

/**
 * Postgres, over the Supabase transaction pooler.
 *
 * Port 6543, not 5432. Serverless functions come and go constantly and a
 * direct connection per invocation exhausts Postgres' connection limit within
 * minutes; the pooler exists precisely for this shape of client.
 *
 * The client is created lazily and cached on the module, so warm invocations
 * reuse it and cold ones pay for it once.
 */
export interface PostgresLike {
  unsafe(text: string, params?: unknown[]): Promise<unknown[]> & { execute?: () => Promise<unknown> };
  begin<T>(fn: (tx: PostgresLike) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export function fromPostgres(client: PostgresLike): Sql {
  return {
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      const rows = await client.unsafe(text, params);
      return rows as T[];
    },
    async batch(statements: Statement[]): Promise<void> {
      if (statements.length === 0) return;
      await client.begin(async (tx) => {
        for (const s of statements) await tx.unsafe(s.text, s.params ?? []);
      });
    },
    async exec(script: string): Promise<void> {
      await client.unsafe(script);
    },
  };
}

/**
 * Read the connection string, and refuse clearly when it is missing or wrong.
 *
 * A Hub that starts up against no database and only fails on the first real
 * request is a Hub that looks healthy while losing everything posted to it.
 */
export function connectionStringFrom(env: Record<string, string | undefined>): string {
  const url = env.DATABASE_URL ?? env.POSTGRES_URL ?? '';
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set.\n' +
        '  Supabase dashboard → the "Connect" button at the top → Shared pooler,\n' +
        '  transaction mode. Put it in .env.local for local work, and in the Vercel\n' +
        '  project settings for deploys.',
    );
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error('DATABASE_URL does not look like a Postgres connection string.');
  }

  /**
   * The trap this exists for.
   *
   * Supabase offers three strings and two of them are on `db.<ref>.supabase.co`:
   * the direct connection (5432) and the *dedicated* pooler (6543). Both resolve
   * over IPv6 only unless you buy the IPv4 add-on — and Vercel's functions are
   * IPv4. So both connect happily from a laptop and fail every single time in
   * production.
   *
   * An earlier version of this check only looked at the port, which the
   * dedicated pooler sails straight through: right port, wrong host, broken
   * deploy. The host is the thing that actually decides.
   *
   * The one that works on the free tier is the *shared* pooler, on
   * `aws-N-<region>.pooler.supabase.com`.
   */
  const host = /@([^/:?]+)/.exec(url)?.[1] ?? '';
  if (/^db\.[a-z0-9-]+\.supabase\.co$/i.test(host)) {
    const port = /:(\d+)\//.exec(url)?.[1] ?? '';
    const which = port === '6543' ? 'the dedicated pooler' : 'the direct connection';
    throw new Error(
      `That is ${which} (${host}), which is IPv6-only unless you pay for the\n` +
        '  IPv4 add-on — and Vercel is IPv4, so it would fail on every deploy.\n' +
        '  Use the SHARED pooler instead: its host contains "pooler.supabase.com"\n' +
        '  and the username has the project ref on it (postgres.<ref>).\n' +
        '  Supabase dashboard → "Connect" → Shared pooler → Transaction mode.',
    );
  }

  return url;
}
