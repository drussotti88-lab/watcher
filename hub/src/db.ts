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
        '  Supabase → Project Settings → Database → Connection string → Transaction pooler.\n' +
        '  Put it in .env.local for `vercel dev`, and in the Vercel project settings for deploys.',
    );
  }
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error('DATABASE_URL does not look like a Postgres connection string.');
  }
  // Port 5432 is the direct connection: it works locally and falls over in
  // production once a few functions are warm. Better to say so now.
  if (/:5432\//.test(url)) {
    throw new Error(
      'That is the direct connection (port 5432). Serverless needs the\n' +
        '  transaction pooler on port 6543, or Postgres will run out of connections.',
    );
  }
  return url;
}
