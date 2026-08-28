/**
 * Vercel adapter. The whole platform-specific surface of the Hub.
 *
 * Everything real lives in src/app.ts as Request → Response; this turns
 * Vercel's Node request into one of those and writes the answer back. Keeping
 * it this thin is what made moving off Cloudflare a morning's work rather than
 * a rewrite, and it is why the API can be tested without starting a server.
 *
 * ── Why this is bundled rather than deployed as TypeScript ───────────────────
 *
 * This file used to live at api/index.ts, and the first deploy crashed:
 *
 *   Cannot find module '/var/task/hub/src/app.ts'
 *   imported from /var/task/hub/api/index.js
 *
 * Vercel compiled the entry file, left the `./app.ts` import specifier exactly
 * as written, and never compiled src/ at all. Node then went looking for a .ts
 * file that was not there.
 *
 * Rather than contort the imports to guess what the platform will do with them,
 * `npm run build` bundles this and everything it imports into a single
 * api/index.js with esbuild. Nothing is left for Vercel to interpret. The same
 * bundle would run on any Node host.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import postgres from 'postgres';
import { createHandler } from './app.ts';
import { fromPostgres, connectionStringFrom, type Sql } from './db.ts';
import { withDeadline } from './deadline.ts';
import type { Env } from './types.ts';

/**
 * One client per warm instance.
 *
 * Serverless functions are created and destroyed constantly. Opening a
 * connection per request would exhaust Postgres in minutes, which is why this
 * is cached on the module and why the connection string has to be the
 * transaction pooler — `connectionStringFrom` refuses the direct one.
 */
let cached: Sql | null = null;
let cachedClient: { end: (opts?: unknown) => Promise<void> } | null = null;

function db(): Sql {
  if (cached) return cached;
  const client = postgres(connectionStringFrom(process.env), {
    // The pooler does not support prepared statements.
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    // A query that cannot finish in eight seconds is not going to finish. Let
    // Postgres kill it rather than letting it sit on the one connection this
    // instance has.
    connection: { statement_timeout: 8_000 },
  });
  cachedClient = client as unknown as { end: (opts?: unknown) => Promise<void> };
  cached = fromPostgres(client as never);
  return cached;
}

/**
 * Throw away the cached connection.
 *
 * The failure this exists for: the pooler drops the single connection this
 * instance holds, postgres.js queues the next query waiting for a connection
 * that never comes back, and the request hangs until Vercel kills it at 30
 * seconds. Reconnecting costs a few hundred milliseconds; hanging costs a
 * whole pass and tells nobody why.
 */
function dropConnection(): void {
  const client = cachedClient;
  cached = null;
  cachedClient = null;
  // Fire and forget: we are already answering, and a socket we have given up
  // on must not be able to delay the response.
  void client?.end({ timeout: 0 }).catch(() => {});
}

const ANSWER_WITHIN_MS = 12_000;

/** The answer given when the work does not come back in time. */
function tooSlow(): Response {
  return new Response(
    JSON.stringify(
      {
        error:
          `the Hub could not answer within ${ANSWER_WITHIN_MS / 1000}s — ` +
          `the database connection was reset, try again`,
      },
      null,
      2,
    ),
    { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
  );
}

function env(): Env {
  return {
    DATABASE_URL: process.env.DATABASE_URL ?? '',
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL ?? '',
    DISCORD_OPS_WEBHOOK_URL: process.env.DISCORD_OPS_WEBHOOK_URL,
    INGEST_TOKEN: process.env.INGEST_TOKEN,
    APP_PASSWORD: process.env.APP_PASSWORD,
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(
  req: IncomingMessage & { method?: string; url?: string },
  res: ServerResponse,
): Promise<void> {
  const host = req.headers.host ?? 'localhost';
  const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https';
  const url = new URL(req.url ?? '/', `${proto}://${host}`);
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';

  const request = new Request(url, {
    method,
    headers: Object.entries(req.headers).flatMap(([k, v]) =>
      typeof v === 'string' ? [[k, v] as [string, string]] : [],
    ),
    ...(hasBody ? { body: await readBody(req) } : {}),
  });

  let response: Response;
  try {
    response = await withDeadline(createHandler(db(), env())(request), {
      ms: ANSWER_WITHIN_MS,
      onTimeout: dropConnection,
      late: tooSlow,
    });
  } catch (err) {
    // Whatever went wrong, do not hand the next request a connection we have
    // just seen fail.
    dropConnection();
    // A misconfigured database must say so loudly. The failure mode this
    // avoids is a Hub that answers /health cheerfully while dropping
    // everything the Watcher posts to it.
    response = new Response(
      JSON.stringify({ error: (err as Error).message }, null, 2),
      { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    );
  }

  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}
