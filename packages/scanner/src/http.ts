import { MAX_BODY_BYTES, USER_AGENT } from './config.ts';
import { sleep } from './util.ts';

export type HttpResponse = {
  status: number;
  body: Uint8Array;
  headers: Headers;
  /** Final URL after redirects, when we followed them. */
  url: string;
};

const EMPTY: HttpResponse = {
  status: 0,
  body: new Uint8Array(),
  headers: new Headers(),
  url: '',
};

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
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: { 'user-agent': USER_AGENT, accept: '*/*', ...opts.headers },
        body: opts.body,
        redirect: opts.redirect ?? 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
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
      return { status: res.status, body, headers: res.headers, url: res.url || url };
    } catch {
      if (attempt === tries - 1) return EMPTY;
      await sleep(2 ** attempt * 500);
    }
  }
  return EMPTY;
}
