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
import {
  fromPostgres,
  connectionStringFrom,
  isConnectionFailure,
  POOL_OPTIONS,
  type Sql,
} from './db.ts';
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

function db(): Sql {
  if (cached) return cached;
  const client = postgres(connectionStringFrom(process.env), { ...POOL_OPTIONS });
  cached = fromPostgres(client as never);
  return cached;
}

/**
 * Stop handing out the cached connection.
 *
 * The failure this exists for: the pooler drops the single connection this
 * instance holds, postgres.js queues the next query against a connection that
 * never comes back, and the request hangs until Vercel kills it at 30 seconds.
 *
 * ── Why this does not close anything ────────────────────────────────────────
 *
 * It used to call `client.end({ timeout: 0 })`, and that was a bug I shipped.
 * A warm instance can be serving several requests on that one client. Ending
 * it destroys the socket underneath every query already in flight, so an
 * unrelated, perfectly healthy request dies with
 *
 *   write CONNECTION_DESTROYED aws-0-us-east-2.pooler.supabase.com:6543
 *
 * — which is what a person saw on screen while adding a product, caused by a
 * different request timing out beside it.
 *
 * Un-caching alone is enough. The next request builds a fresh client, queries
 * already running finish on the old one, and postgres.js closes that socket
 * itself once `idle_timeout` passes. Reconnecting costs a few hundred
 * milliseconds. Killing someone else's write costs their write.
 */
function dropConnection(): void {
  cached = null;
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
    // Only when the connection itself is implicated. Throwing away a healthy
    // client because a query had a bad parameter would turn one bad request
    // into a reconnect for everybody.
    if (isConnectionFailure(err)) dropConnection();
    // A misconfigured database must say so loudly. The failure mode this
    // avoids is a Hub that answers /health cheerfully while dropping
    // everything Phantom posts to it.
    response = new Response(
      JSON.stringify({ error: (err as Error).message }, null, 2),
      { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
    );
  }

  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}
