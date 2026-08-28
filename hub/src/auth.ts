/**
 * Who is allowed in.
 *
 * Two callers, two mechanisms, and they are not interchangeable:
 *
 *   the Watcher   a bearer token, set once in its config file
 *   the browser   a password, exchanged for a signed cookie
 *
 * Kept as simple as it can be while still being real. There are no accounts
 * because there is one user. There is no password database because there is one
 * password. But the cookie is signed with HMAC and carries an expiry, because
 * the alternative — a cookie that just says `loggedin=true` — is a page anyone
 * can walk into by typing eight characters into their dev tools, and this page
 * will eventually show what has been bought and be able to buy more.
 */

const SESSION_COOKIE = 'hub_session';
const SESSION_HOURS = 24 * 14;

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return b64url(new Uint8Array(sig));
}

/**
 * Compare without leaking where two strings first differ.
 *
 * A plain `===` on a secret returns faster the earlier it finds a mismatch,
 * which over enough attempts tells an attacker the secret one character at a
 * time. Overkill for a personal dashboard, but it is four lines.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function mintSession(secret: string, now = Date.now()): Promise<string> {
  const expires = now + SESSION_HOURS * 3600 * 1000;
  const payload = String(expires);
  return `${payload}.${await hmac(secret, payload)}`;
}

export async function sessionValid(
  secret: string,
  token: string | null,
  now = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = await hmac(secret, payload);
  if (!safeEqual(signature, expected)) return false;

  const expires = Number(payload);
  return Number.isFinite(expires) && expires > now;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function sessionCookie(value: string, secure: boolean): string {
  const bits = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    // HttpOnly: script on the page can never read it, so an injected script
    // cannot post the session anywhere.
    'HttpOnly',
    // Lax: the cookie is not sent on cross-site POSTs, which is the CSRF that
    // would otherwise let another tab trigger a buy.
    'SameSite=Lax',
    `Max-Age=${SESSION_HOURS * 3600}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearCookie(secure: boolean): string {
  const bits = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export const COOKIE_NAME = SESSION_COOKIE;

export interface AuthEnv {
  INGEST_TOKEN?: string;
  APP_PASSWORD?: string;
}

export type Caller = 'watcher' | 'browser' | 'none';

/**
 * Identify the caller.
 *
 * Note the ordering and the fail-closed default. An unset `INGEST_TOKEN` or
 * `APP_PASSWORD` never means "let everyone in" — it means that route is shut.
 * Getting this backwards is how a dashboard ends up world-readable because
 * someone forgot an environment variable.
 */
export async function identify(request: Request, env: AuthEnv): Promise<Caller> {
  const header = request.headers.get('Authorization') ?? '';
  if (env.INGEST_TOKEN && header.startsWith('Bearer ')) {
    if (safeEqual(header.slice(7), env.INGEST_TOKEN)) return 'watcher';
  }
  if (env.APP_PASSWORD) {
    const cookie = readCookie(request, SESSION_COOKIE);
    if (await sessionValid(env.APP_PASSWORD, cookie)) return 'browser';
  }
  return 'none';
}
