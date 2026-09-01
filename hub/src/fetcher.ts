/**
 * The only place in the Hub that touches the network.
 *
 * Kept separate from every parser so parsers stay pure and testable against
 * saved fixtures — which matters because they break whenever a retailer
 * redesigns, and you need to fix them without waiting for a live drop.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export class FetchError extends Error {
  status: number;
  blocked: boolean;

  constructor(message: string, status: number, blocked: boolean) {
    super(message);
    this.name = 'FetchError';
    this.status = status;
    this.blocked = blocked;
  }
}

function looksGzipped(url: string, contentType: string | null): boolean {
  if (/\.gz(\?|$)/i.test(url)) return true;
  return /application\/(x-)?gzip/i.test(contentType ?? '');
}

async function gunzip(res: Response): Promise<string> {
  if (!res.body) return '';
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/**
 * Fetch and return text, transparently decompressing a .gz payload.
 *
 * A 403/429 is reported as `blocked` so the caller can back off hard rather
 * than retry. Hammering something that just challenged you is how a soft block
 * becomes a permanent one.
 */
export async function fetchText(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 20_000,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!res.ok) {
      const blocked = res.status === 403 || res.status === 429 || res.status === 503;
      throw new FetchError(
        `${res.status} ${res.statusText || ''}`.trim() +
          (blocked ? ' — looks like a block; this source needs Phantom' : ''),
        res.status,
        blocked,
      );
    }

    return looksGzipped(url, res.headers.get('content-type'))
      ? await gunzip(res)
      : await res.text();
  } catch (err) {
    if (err instanceof FetchError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new FetchError(msg, 0, false);
  } finally {
    clearTimeout(timer);
  }
}

export interface ProbeResult {
  url: string;
  ok: boolean;
  status: number;
  blocked: boolean;
  ms: number;
  note: string;
}

/**
 * Can this Worker actually reach this URL, from wherever it happens to be
 * running right now?
 *
 * This exists because local testing egresses from your own machine while a
 * deployed Worker egresses from Cloudflare, and the two get treated very
 * differently by retailer bot protection. Guessing which sources work is how
 * you end up with a monitor that silently watches nothing.
 *
 * Reads only the first slice of the body — enough to prove the response is real
 * without downloading a multi-megabyte sitemap just to check a status code.
 */
export async function probeUrl(url: string, headers: Record<string, string> = {}): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
      redirect: 'follow',
    });
    const blocked = res.status === 403 || res.status === 429 || res.status === 503;

    let note = '';
    if (res.ok && res.body) {
      const reader = res.body.getReader();
      const { value } = await reader.read();
      await reader.cancel().catch(() => {});
      const bytes = value?.length ?? 0;
      const head = new TextDecoder().decode((value ?? new Uint8Array()).slice(0, 200));
      note = /^\x1f\x8b/.test(head) || /gzip/i.test(res.headers.get('content-type') ?? '')
        ? `gzipped, ${bytes}B read`
        : /<sitemapindex/i.test(head)
          ? 'sitemap index'
          : /<urlset/i.test(head)
            ? 'sitemap'
            : `${bytes}B read`;
    } else if (blocked) {
      note = 'blocked — this source needs Phantom';
    } else if (!res.ok) {
      note = res.statusText || 'not ok';
    }

    return { url, ok: res.ok, status: res.status, blocked, ms: Date.now() - started, note };
  } catch (err) {
    return {
      url,
      ok: false,
      status: 0,
      blocked: false,
      ms: Date.now() - started,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}
