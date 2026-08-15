import { Agent, fetch, type Headers, type Response } from 'undici';
import { MAX_BODY_BYTES, USER_AGENT } from './config.ts';
import * as pace from './pace.ts';
import { sleep } from './util.ts';

/**
 * Vercel's edge resets any TLS connection whose ALPN list *starts* with
 * `http/1.1`, even when h2 is also offered. Node's built-in fetch offers
 * exactly that, so it cannot reach *.vercel.app at all — which silently cost a
 * whole run: 1,090 vercel hosts probed live and every single one failed its
 * GET, while github.io went 779/779. Measured at the raw TLS layer, 6 trials
 * each: ["http/1.1"] 0/6, ["http/1.1","h2"] 0/6, ["h2","http/1.1"] 6/6.
 *
 * undici hardcodes the ALPN order and applies it *after* user connect options,
 * so `connect: { ALPNProtocols }` cannot override it. `preferH2` is the only
 * supported way to put h2 first, and it is why this uses the undici package
 * rather than the global fetch, whose dispatcher is not reachable from here.
 */
const dispatcher = new Agent({ allowH2: true, connect: { preferH2: true } });

export type HttpResponse = {
  status: number;
  body: Uint8Array;
  headers: Headers;
  /** Final URL after redirects, when we followed them. */
  url: string;
  /**
   * Why status is 0. "The request failed" is not a diagnosis — ECONNRESET,
   * EAI_AGAIN and UND_ERR_CONNECT_TIMEOUT are three completely different bugs
   * with three different fixes, and collapsing them into one silent bucket has
   * already burned two rounds of guessing here.
   */
  error?: string;
};

const failed = (error: string): HttpResponse => ({
  status: 0,
  body: new Uint8Array(),
  headers: new globalThis.Headers() as unknown as Headers,
  url: '',
  error,
});

/** Node nests the interesting part under `cause`; the outer message is always "fetch failed". */
function causeOf(err: unknown): string {
  const e = err as { name?: string; code?: string; cause?: { code?: string; message?: string } };
  return e?.cause?.code ?? e?.code ?? e?.cause?.message?.slice(0, 40) ?? e?.name ?? 'unknown';
}

type RequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  tries?: number;
  cap?: number;
  redirect?: 'follow' | 'manual' | 'error';
};

/** Read at most `cap` bytes, then hang up. Some drainer pages are enormous. */
async function readCapped(res: Response, cap: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(total, cap));
  let offset = 0;
  for (const part of chunks) {
    if (offset >= out.length) break;
    out.set(part.subarray(0, out.length - offset), offset);
    offset += part.length;
  }
  return out;
}

/**
 * fetch with retries and a byte cap. Never throws: a dead host is data, not an
 * exception, and this pipeline probes hundreds of thousands of dead hosts.
 */
export async function request(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
  const tries = opts.tries ?? 3;
  const cap = opts.cap ?? MAX_BODY_BYTES;

  for (let attempt = 0; attempt < tries; attempt++) {
    await pace.acquire(url);
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: { 'user-agent': USER_AGENT, accept: '*/*', ...opts.headers },
        body: opts.body,
        redirect: opts.redirect ?? 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        dispatcher,
      });

      if ((res.status === 403 || res.status === 429) && attempt < tries - 1) {
        const wait = Number(res.headers.get('retry-after')) || 2 ** attempt;
        await res.body?.cancel().catch(() => {});
        await sleep(Math.min(wait, 60) * 1000);
        continue;
      }
      if (res.status >= 500 && attempt < tries - 1) {
        await res.body?.cancel().catch(() => {});
        await sleep(2 ** attempt * 1000);
        continue;
      }

      const body = opts.method === 'HEAD' ? new Uint8Array() : await readCapped(res, cap);
      pace.report(url);
      return { status: res.status, body, headers: res.headers, url: res.url || url };
    } catch (err) {
      const cause = causeOf(err);
      pace.report(url, cause);
      if (attempt === tries - 1) return failed(cause);
      await sleep(2 ** attempt * 500);
    }
  }
  return failed('retries-exhausted');
}
