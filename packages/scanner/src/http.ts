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

/**
 * Optional: fetch rate-limited providers from somewhere that is not this
 * runner. See packages/fetch-proxy for why — the limit is per source IP and a
 * GitHub runner arrives on a shared address that is usually already spent.
 *
 * Scoped to `isPaced` hosts on purpose. github.io is the bulk of every run and
 * has never rationed anything, so sending it through an extra hop would buy
 * nothing and add latency to 3,700 requests. Unset means every request goes
 * direct, which is exactly the old behaviour.
 */
const PROXY_URL = (process.env.FETCH_PROXY ?? '').replace(/\/+$/, '');
const PROXY_TOKEN = process.env.FETCH_PROXY_TOKEN ?? '';

export const proxyEnabled = Boolean(PROXY_URL);

/**
 * Ask the proxy for one URL and rebuild the response it saw.
 *
 * The transport failure and the target's answer have to stay distinguishable:
 * the proxy reports the target's outcome in `x-npfd-*` and always answers 200
 * when it got that far, so any non-200 here is the proxy itself talking — a bad
 * token or a host it refuses — and that is a configuration error worth naming
 * rather than a dead site.
 */
async function viaProxy(url: string, opts: RequestOptions): Promise<HttpResponse> {
  // The proxy does one thing: GET, following redirects. Every paced caller
  // already wants exactly that — the liveness probe and the SPA bundle fetch —
  // so this is not a limitation anyone is hitting. It is here so that adding a
  // caller that wants something else fails at the boundary instead of quietly
  // getting a GET and a followed redirect it did not ask for.
  if ((opts.method ?? 'GET') !== 'GET' || (opts.redirect ?? 'manual') !== 'follow') {
    return failed('proxy-unsupported-request');
  }
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const res = await fetch(`${PROXY_URL}/?url=${encodeURIComponent(url)}`, {
    headers: {
      'x-npfd-token': PROXY_TOKEN,
      'x-npfd-user-agent': USER_AGENT,
      'x-npfd-accept': opts.headers?.accept ?? '*/*',
      'x-npfd-timeout': String(timeoutMs),
    },
    // The proxy enforces its own deadline against the target; this one only
    // has to outlast it, or a slow site would look like a broken proxy.
    signal: AbortSignal.timeout(timeoutMs + 10_000),
    dispatcher,
  });

  const note = res.headers.get('x-npfd-error') ?? '';
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return failed(`proxy-${res.status}${note ? `-${note}` : ''}`);
  }

  const status = Number(res.headers.get('x-npfd-status') ?? 0);
  const body = await readCapped(res, opts.cap ?? MAX_BODY_BYTES);
  const headers = new globalThis.Headers() as unknown as Headers;
  try {
    for (const [k, v] of Object.entries(JSON.parse(res.headers.get('x-npfd-headers') ?? '{}'))) {
      headers.set(k, String(v));
    }
  } catch {
    // A malformed header block costs us `server` and `x-vercel-error`, not the page.
  }
  // status 0 means the proxy reached out and the target refused — the same
  // shape as a direct failure, so ECONNRESET still reaches the limiter below.
  return status === 0
    ? { ...failed(note || 'unknown'), url: res.headers.get('x-npfd-final-url') ?? url }
    : { status, body, headers, url: res.headers.get('x-npfd-final-url') || url };
}

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

  // The limiter still runs on the proxied path. Cloudflare's egress pool is a
  // bigger budget, not an infinite one, and if it starts getting reset too we
  // want the same backoff and the same `issuedBeforeFirstTrip` number in the
  // summary — measuring the new address is half the reason to try it.
  const proxied = proxyEnabled && pace.isPaced(url);

  for (let attempt = 0; attempt < tries; attempt++) {
    if (!(await pace.acquire(url))) return failed('provider-blocked');
    try {
      if (proxied) {
        const res = await viaProxy(url, opts);
        pace.report(url, res.error);
        if (res.error && attempt < tries - 1) {
          await sleep(2 ** attempt * 500);
          continue;
        }
        return res;
      }
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

      const body = await readCapped(res, cap);
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
