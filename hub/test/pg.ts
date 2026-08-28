/**
 * A real Postgres, in the test process.
 *
 * PGlite is Postgres compiled to WebAssembly, so these tests run the same SQL
 * engine Supabase does — same types, same constraints, same coercions.
 *
 * This replaced a SQLite façade, and the swap immediately paid for itself. In
 * SQLite the flag columns were integers and `seeded === 1` was true; in
 * Postgres they are booleans and that comparison is false for every row
 * forever. A source would have re-seeded on every sweep, silently, meaning it
 * would never announce anything — a monitor that runs perfectly and tells you
 * nothing. The tests below would have passed against SQLite the whole time.
 *
 * Test-only. Run with: node --experimental-strip-types
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Sql, Statement } from '../src/db.ts';

export class TestDb implements Sql {
  private pg: PGlite;

  private constructor(pg: PGlite) {
    this.pg = pg;
  }

  static async create(): Promise<TestDb> {
    const pg = new PGlite();
    await pg.waitReady;
    const db = new TestDb(pg);
    await db.exec(readFileSync(resolve(import.meta.dirname, '..', 'schema.sql'), 'utf8'));
    return db;
  }

  async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pg.query(text, params as never[]);
    return res.rows as T[];
  }

  async batch(statements: Statement[]): Promise<void> {
    if (statements.length === 0) return;
    // A real transaction, which is the behaviour production gets from the
    // pooler. Half a batch landing is the failure mode this prevents.
    await this.pg.transaction(async (tx) => {
      for (const s of statements) await tx.query(s.text, (s.params ?? []) as never[]);
    });
  }

  async exec(script: string): Promise<void> {
    await this.pg.exec(script);
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}
