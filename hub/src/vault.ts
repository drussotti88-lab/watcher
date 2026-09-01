/**
 * The bridge to DNA Card Vault.
 *
 * The vault is boss: it owns the account, the membership payment, and the
 * portfolio. Phantom trusts it for exactly two facts — who someone is, and
 * whether they hold the Phantom tier — and sends it exactly one thing:
 * purchases a person has reviewed. Everything crossing in either direction is
 * HMAC-SHA256 over PHANTOM_SHARED_SECRET, set identically in both Vercel
 * projects, and the two implementations (this file and the vault's
 * src/lib/phantom.js) MUST stay byte-compatible: sha256, base64url, and the
 * exact message shapes below.
 *
 *   launch token   `<payload-b64url>.<mac(payload)>` — payload is JSON
 *                  { u: vaultUserId, e: email, x: expiresMs, n: nonce }
 *   server call    headers x-phantom-ts / x-phantom-sig, the signature over
 *                  `<ts>.<METHOD>.<path>.<body>`
 */

export interface VaultEnv {
  PHANTOM_SHARED_SECRET?: string;
  VAULT_URL?: string;
}

export interface LaunchClaims {
  userId: string;
  email: string;
}

const enc = new TextEncoder();

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

async function mac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/** Constant-time-ish compare of a given base64url MAC against the computed one. */
async function macEquals(secret: string, message: string, given: string): Promise<boolean> {
  let bytes: Buffer;
  try { bytes = Buffer.from(String(given), 'base64url'); } catch { return false; }
  const want = await mac(secret, message);
  if (bytes.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i += 1) diff |= bytes[i]! ^ want[i]!;
  return diff === 0;
}

export function vaultUrl(env: VaultEnv): string {
  return String(env.VAULT_URL ?? '').replace(/\/+$/, '');
}

export function vaultConfigured(env: VaultEnv): boolean {
  return !!(env.PHANTOM_SHARED_SECRET && vaultUrl(env));
}

/**
 * Verify a launch token minted by the vault. MAC first, always — nothing in
 * the payload may be read until the signature says the payload is the vault's.
 * Returns who this is, or null for anything expired, edited, or unsigned.
 */
export async function verifyLaunchToken(
  env: VaultEnv,
  token: string | null,
  now = Date.now(),
): Promise<LaunchClaims | null> {
  const secret = env.PHANTOM_SHARED_SECRET ?? '';
  if (!secret || !token) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  if (!(await macEquals(secret, payload, token.slice(dot + 1)))) return null;
  let claims: { u?: unknown; e?: unknown; x?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as typeof claims;
  } catch { return null; }
  if (!claims?.u || typeof claims.x !== 'number' || claims.x <= now) return null;
  return { userId: String(claims.u), email: String(claims.e ?? '') };
}

/** Sign a server-to-server call to the vault. */
export async function signedHeaders(
  env: VaultEnv,
  method: string,
  path: string,
  body = '',
  now = Date.now(),
): Promise<Record<string, string>> {
  const ts = String(now);
  const sig = b64url(await mac(
    env.PHANTOM_SHARED_SECRET ?? '',
    `${ts}.${method.toUpperCase()}.${path}.${body}`,
  ));
  return { 'x-phantom-ts': ts, 'x-phantom-sig': sig };
}

export type Entitlement =
  | { answer: 'yes' | 'no'; sources: string[] }
  | { answer: 'unknown'; reason: string };

/**
 * Is this vault account still entitled to Phantom?
 *
 * Three-valued on purpose. 'no' is the vault EXPLICITLY saying the tier has
 * lapsed — the only answer that may end a session. Network trouble, timeouts
 * and 5xx are 'unknown': the vault being down must never lock a member out
 * mid-drop, so unknown fails OPEN and simply tries again next time.
 */
export async function checkEntitlement(
  env: VaultEnv,
  vaultUserId: string,
  doFetch: typeof fetch = fetch,
): Promise<Entitlement> {
  if (!vaultConfigured(env)) return { answer: 'unknown', reason: 'not configured' };
  const path = `/api/phantom/entitlement?user=${encodeURIComponent(vaultUserId)}`;
  try {
    const headers = await signedHeaders(env, 'GET', path);
    const res = await doFetch(`${vaultUrl(env)}${path}`, {
      headers, signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { answer: 'unknown', reason: `vault answered ${res.status}` };
    const j = (await res.json()) as { entitled?: boolean; sources?: string[] };
    if (typeof j?.entitled !== 'boolean') return { answer: 'unknown', reason: 'unreadable answer' };
    return { answer: j.entitled ? 'yes' : 'no', sources: j.sources ?? [] };
  } catch {
    return { answer: 'unknown', reason: 'vault unreachable' };
  }
}

export interface AcquisitionDelivery {
  externalKey: string;
  vaultUserId: string;
  name: string;
  quantity: number;
  priceCents: number | null;
  acquiredOn: string;
  retailer: string;
  tcgId: string | null;
  setName?: string | null;
  imageUrl?: string | null;
}

/** Deliver one reviewed purchase to the vault portfolio. Idempotent by externalKey. */
export async function deliverAcquisition(
  env: VaultEnv,
  a: AcquisitionDelivery,
  doFetch: typeof fetch = fetch,
): Promise<{ ok: true; itemIds: unknown[] } | { ok: false; error: string }> {
  if (!vaultConfigured(env)) return { ok: false, error: 'the vault link is not configured' };
  const path = '/api/phantom/acquisitions';
  const body = JSON.stringify({
    externalKey: a.externalKey, userId: a.vaultUserId, name: a.name,
    quantity: a.quantity, priceCents: a.priceCents, acquiredOn: a.acquiredOn,
    retailer: a.retailer, tcgId: a.tcgId, setName: a.setName ?? null, imageUrl: a.imageUrl ?? null,
  });
  try {
    const headers = await signedHeaders(env, 'POST', path, body);
    const res = await doFetch(`${vaultUrl(env)}${path}`, {
      method: 'POST', body,
      headers: { ...headers, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    const j = (await res.json().catch(() => null)) as { ok?: boolean; itemIds?: unknown[]; error?: string } | null;
    if (res.ok && j?.ok) return { ok: true, itemIds: j.itemIds ?? [] };
    return { ok: false, error: j?.error ?? `vault answered ${res.status}` };
  } catch {
    return { ok: false, error: 'the vault could not be reached — the send stays queued' };
  }
}

/**
 * Search the vault's sealed catalog for the match step. The endpoint is the
 * vault's public /api/sealed; relayed through the Hub so the page talks to one
 * origin and the vault URL stays configuration.
 */
export async function searchVaultSealed(
  env: VaultEnv,
  q: string,
  doFetch: typeof fetch = fetch,
): Promise<{ products: unknown[] } | { error: string }> {
  if (!vaultConfigured(env)) return { error: 'the vault link is not configured' };
  try {
    const res = await doFetch(
      `${vaultUrl(env)}/api/sealed?q=${encodeURIComponent(q)}`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!res.ok) return { error: `vault answered ${res.status}` };
    const j = (await res.json()) as { products?: unknown[] };
    return { products: Array.isArray(j?.products) ? j.products : [] };
  } catch {
    return { error: 'the vault could not be reached' };
  }
}
