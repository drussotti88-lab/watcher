/**
 * Vercel adapter. The whole platform-specific surface of the Hub.
 *
 * Everything real lives in src/app.ts as Request → Response; this turns
 * Vercel's Node request into one of those and writes the answer back. Keeping
 * it this thin is what made moving off Cloudflare a morning's work rather than
 * a rewrite, and it is why the API can be tested without starting a server.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import postgres from 'postgres';
import { createHandler } from '../src/app.ts';
import { fromPostgres, connectionStringFrom, type Sql } from '../src/db.ts';
import type { Env } from '../src/types.ts';

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
  const client = postgres(connectionStringFrom(process.env), {
    // The pooler does not support prepared statements.
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  cached = fromPostgres(client as never);
  return cached;
}

function env(): Env {
  return {
    DATABASE_URL: process.env.DATABASE_URL ?? '',
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL ?? '',
    DISCORD_OPS_WEBHOOK_URL: process.env.DISCORD_OPS_WEBHOOK_URL,
    INGEST_TOKEN: process.env.INGEST_TOKEN,
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
    response = await createHandler(db(), env())(request);
  } catch (err) {
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
