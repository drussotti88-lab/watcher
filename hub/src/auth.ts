/**
 * Who is allowed in.
 *
 * Two callers, two mechanisms, and they are not interchangeable:
 *
 *   Phantom   a bearer token, set once in its config file
 *   the browser   a password, exchanged for a signed cookie
 *
 * There are accounts now. There were not, and the gap was the whole problem:
 * every query underneath already filtered by user_id and every Phantom already
 * carried its own token, but the browser door had one password and always
 * answered as user 1. Handing a second person the link did not create a second
 * account — it handed them the first one, with the delete buttons attached.
 *
 * The cookie is signed with HMAC and carries both an expiry and the user it
 * belongs to, because the alternative — a cookie that says `user=2` in plain
 * text — is another account anyone can walk into by typing five characters
 * into their dev tools, and this page will eventually be able to spend money.
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

/**
 * A signed cookie value saying who, until when.
 *
 * The payload is `<userId>:<expires>`. Older cookies carry a bare expiry with
 * no colon and are read as user 1 — see `readSession`. That is not politeness
 * to old data, it is so that deploying this does not sign Roberto out of a
 * dashboard whose Phantom is mid-pass.
 */
export async function mintSession(
  secret: string,
  userId = 1,
  now = Date.now(),
): Promise<string> {
  const expires = now + SESSION_HOURS * 3600 * 1000;
  const payload = `${userId}:${expires}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

/**
 * Whose session is this, and is it still good? Returns 0 for neither.
 *
 * Signature first, always. The user id is inside the signed payload, so it can
 * be trusted only after the MAC has been checked — reading it first and
 * checking later is how a cookie becomes a user-id parameter.
 */
export async function readSession(
  secret: string,
  token: string | null,
  now = Date.now(),
): Promise<number> {
  if (!token) return 0;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return 0;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = await hmac(secret, payload);
  if (!safeEqual(signature, expected)) return 0;

  // Old format: the payload is the expiry alone, and it belonged to user 1
  // because user 1 was the only user there was.
  const colon = payload.indexOf(':');
  const userId = colon === -1 ? 1 : Number(payload.slice(0, colon));
  const expires = Number(colon === -1 ? payload : payload.slice(colon + 1));

  if (!Number.isInteger(userId) || userId < 1) return 0;
  if (!Number.isFinite(expires) || expires <= now) return 0;
  return userId;
}

/** Is this session good at all? `readSession` when you need to know whose. */
export async function sessionValid(
  secret: string,
  token: string | null,
  now = Date.now(),
): Promise<boolean> {
  return (await readSession(secret, token, now)) > 0;
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
  /**
   * What session cookies are signed with.
   *
   * Optional, and falls back to APP_PASSWORD so that accounts could ship
   * without a new environment variable having to be set first — a deploy that
   * needs a secret typed into a dashboard before it works is a deploy that is
   * broken for however long that takes. Set it, and changing the owner
   * password stops signing everybody out.
   */
  SESSION_SECRET?: string;
}

/** The key sessions are signed with. Empty means the browser door is shut. */
export function sessionSecret(env: AuthEnv): string {
  return env.SESSION_SECRET || env.APP_PASSWORD || '';
}

export type CallerKind = 'watcher' | 'browser' | 'none';

/**
 * Who is asking, and whose data they may touch.
 *
 * The user id is the whole point. Every store function takes one and every
 * query filters on it, so this is where a request stops being anonymous and
 * becomes scoped — and it is the only place that decides.
 *
 * `none` carries userId 0, which no row can belong to. A bug that forgets to
 * check `kind` therefore filters everything out rather than letting everything
 * through, which is the direction to fail in.
 */
export interface Caller {
  kind: CallerKind;
  userId: number;
}

const NOBODY: Caller = { kind: 'none', userId: 0 };

/**
 * SHA-256, hex. What the users table stores instead of a token.
 *
 * A leaked database must not hand anyone the ability to impersonate a
 * Phantom — the same standard a password gets, for the same reason.
 */
export async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Identify the caller.
 *
 * Note the ordering and the fail-closed default. An unset `INGEST_TOKEN` or
 * `APP_PASSWORD` never means "let everyone in" — it means that route is shut.
 * Getting this backwards is how a dashboard ends up world-readable because
 * someone forgot an environment variable.
 */
export async function identify(
  request: Request,
  env: AuthEnv,
  lookup?: TokenLookup,
): Promise<Caller> {
  const header = request.headers.get('Authorization') ?? '';

  if (header.startsWith('Bearer ')) {
    const token = header.slice(7);

    // A per-user Phantom token, matched by its hash. This is the path every
    // Phantom will use once there is more than one person.
    if (lookup) {
      const userId = await lookup(await hashToken(token));
      if (userId) return { kind: 'watcher', userId };
    }

    // The single shared INGEST_TOKEN from the environment. Kept so Phantom
    // already running on a desk does not stop working the moment ownership
    // ships; it answers as the first user.
    if (env.INGEST_TOKEN && safeEqual(token, env.INGEST_TOKEN)) {
      return { kind: 'watcher', userId: 1 };
    }
  }

  const secret = sessionSecret(env);
  if (secret) {
    const cookie = readCookie(request, SESSION_COOKIE);
    // Whose session, not whether there is one. This used to return a constant
    // 1 no matter who signed in, which made every account below it decorative.
    const userId = await readSession(secret, cookie);
    if (userId) return { kind: 'browser', userId };
  }

  return NOBODY;
}

/** Given a token hash, whose Phantom is it? Returns 0 for nobody. */
export type TokenLookup = (tokenHash: string) => Promise<number>;

// ── Passwords ────────────────────────────────────────────────────────────────

/**
 * PBKDF2-HMAC-SHA256. Chosen because it is the only password KDF Web Crypto
 * offers, and Web Crypto is the only thing guaranteed to exist both in Node
 * and on Vercel's runtime. Argon2 or scrypt would be better; neither is here
 * without a native dependency, and a native dependency in the deploy path is
 * its own kind of outage.
 *
 * The iteration count lives in the stored string rather than in a constant, so
 * raising it later re-hashes on next login instead of locking everybody out.
 */
const PBKDF2_ITERATIONS = 210_000;
const PBKDF2_KEY_BYTES = 32;
const PBKDF2_SALT_BYTES = 16;

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    PBKDF2_KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/*
 * ── Invites ─────────────────────────────────────────────────────────────────
 *
 * A link that signs one person in once, so they can choose their own
 * password. Sending someone a generated password to type on a phone is the
 * step where onboarding stalls; a link they tap is not.
 *
 * Nothing is stored. The token is `<userId>.<expires>.<mac>`, and the MAC is
 * over the id, the expiry, AND the account's current password hash. That last
 * part is what makes the link single-use in practice without a table: the
 * moment they set a password, the hash changes, the MAC no longer verifies,
 * and the link is dead — including in whatever chat it was pasted into. Until
 * then it is good for seven days.
 *
 * The WHOLE hash, not a prefix. The first draft took sixteen characters, and
 * every hash this system writes begins with the same sixteen — the algorithm
 * header — so "the password changed" changed nothing. A test caught it before
 * a link did.
 *
 * The token rides in the URL FRAGMENT (`/invite#t=...`), which never reaches
 * a server or a log, and the page posts it — the same shape as the vault's
 * `/sso` link.
 */
const INVITE_DAYS = 7;

function inviteSubject(userId: number, expires: number, passwordHash: string): string {
  return `invite:${userId}:${expires}:${String(passwordHash ?? '') || 'none'}`;
}

export async function mintInvite(
  secret: string,
  userId: number,
  passwordHash: string,
  now = Date.now(),
): Promise<string> {
  const expires = now + INVITE_DAYS * 24 * 3600 * 1000;
  const mac = await hmac(secret, inviteSubject(userId, expires, passwordHash));
  return `${userId}.${expires}.${mac}`;
}

/**
 * Whose invite is this, if anyone's. 0 for expired, forged, or already used.
 *
 * `lookupHash` fetches the account's CURRENT password hash by id, so a link
 * minted against an older hash fails here — that is the single-use rule.
 */
export async function readInvite(
  secret: string,
  token: string,
  lookupHash: (userId: number) => Promise<string | null>,
  now = Date.now(),
): Promise<number> {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return 0;
  const userId = Number(parts[0]);
  const expires = Number(parts[1]);
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isFinite(expires)) return 0;
  if (expires < now) return 0;
  const hash = await lookupHash(userId);
  if (hash === null) return 0;
  const expected = await hmac(secret, inviteSubject(userId, expires, hash));
  return safeEqual(parts[2]!, expected) ? userId : 0;
}

/** Hash a password for storage. Never logged, never returned to a browser. */
export async function hashPassword(
  password: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const derived = await pbkdf2(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${b64url(salt)}$${b64url(derived)}`;
}

/**
 * Does this password match that stored hash?
 *
 * False for a malformed or empty stored hash rather than throwing, because the
 * empty string is a real and expected value: a user row that owns a Phantom
 * token but has no browser login at all stores exactly that, and it must mean
 * "cannot sign in", never "signs in with anything".
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 5) return false;
  // Destructuring off a length-checked array still types as possibly-undefined
  // under noUncheckedIndexedAccess, and defaulting is cheaper than asserting.
  const [scheme = '', hash = '', iterText = '', saltText = '', expected = ''] = parts;
  if (scheme !== 'pbkdf2' || hash !== 'sha256') return false;

  const iterations = Number(iterText);
  // An attacker who could write the hash column could otherwise set the
  // iteration count to a billion and turn every login attempt into an outage.
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 5_000_000) return false;

  let salt: Uint8Array;
  try {
    salt = new Uint8Array(Buffer.from(saltText, 'base64url'));
  } catch {
    return false;
  }
  if (salt.length === 0) return false;

  const derived = await pbkdf2(password, salt, iterations);
  return safeEqual(b64url(derived), expected);
}

// ── Signing in ───────────────────────────────────────────────────────────────

/** Given a name, the id and stored hash to check against. Null for nobody. */
export type PasswordLookup = (
  handle: string,
) => Promise<{ id: number; passwordHash: string } | null>;

/**
 * A hash of nothing anybody knows, used to spend the same time on a name that
 * does not exist as on one that does.
 *
 * Without it, a wrong password takes ~200ms of PBKDF2 and an unknown name
 * returns instantly, and the difference tells anyone who cares which of the two
 * they got — which is how you enumerate the accounts on a system before you
 * start guessing at their passwords.
 */
const DECOY_HASH =
  'pbkdf2$sha256$210000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/**
 * Who is signing in, or 0.
 *
 * Two doors, and the empty handle is the older one. A blank name with the
 * deployment's APP_PASSWORD is the owner — kept working exactly as it did,
 * because the alternative was a deploy that locks Roberto out of his own
 * dashboard until he creates an account he cannot create without signing in.
 */
export async function signIn(
  env: AuthEnv,
  handle: string,
  password: string,
  lookup: PasswordLookup,
): Promise<number> {
  const name = String(handle ?? '').trim();
  if (!password) return 0;

  if (!name) {
    if (env.APP_PASSWORD && safeEqual(password, env.APP_PASSWORD)) return 1;
    return 0;
  }

  const found = await lookup(name);
  const ok = await verifyPassword(password, found ? found.passwordHash : DECOY_HASH);
  return ok && found ? found.id : 0;
}
