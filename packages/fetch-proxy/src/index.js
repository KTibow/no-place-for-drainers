/**
 * A fetcher that is not the CI runner.
 *
 * Vercel's edge rations requests per source IP and does not answer with 429 —
 * it resets the connection and keeps doing so for minutes. A GitHub-hosted
 * runner arrives on a shared Azure address that other people have usually
 * already drained: run 31920222624 got 59 requests before the first reset and
 * spent the rest of a 153-second track discovering it was still blocked. No
 * amount of concurrency fixes that; 12 workers at 6 rps emptied the bucket in
 * six seconds. The only axis that scales is source addresses.
 *
 * A Worker's outbound fetch leaves from Cloudflare's edge, so this trades one
 * exhausted Azure IP for that pool, at 100k requests/day on the free plan.
 * The scanner talks to it only for hosts the limiter would otherwise pace;
 * everything else still goes direct, because github.io has never rationed
 * anything and a proxy hop is pure latency there.
 *
 * Deliberately not a general-purpose proxy. It takes one URL, it must be on
 * ALLOWED_SUFFIXES, and it needs the shared token — an open fetch relay on a
 * free plan is somebody else's abuse infrastructure by the end of the week.
 * Redirects are followed to wherever they lead (a protected deployment lands
 * on vercel.com and the scanner needs to see that), but only the first hop is
 * checked, since that is the only one this service chose to make.
 */

const ALLOWED_SUFFIXES = ['.vercel.app'];
/** Matches the scanner's own cap so a huge page fails the same way on both paths. */
const MAX_BODY_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Metadata rides in headers rather than a JSON envelope so the body can pass
 * through as bytes. Base64ing a 2 MB page to wrap it in JSON would inflate it
 * by a third and cost CPU on both ends for nothing.
 */
function meta(fields, body = null, status = 200) {
  const headers = { 'cache-control': 'no-store' };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) headers[`x-npfd-${key}`] = String(value);
  }
  return new Response(body, { status, headers });
}

/**
 * Only what the scanner reads: it needs `server` and the provider's own error
 * header, and it must not inherit the upstream's content-encoding or
 * transfer-encoding, which describe a body this Response is not sending.
 */
const FORWARD_HEADERS = ['server', 'content-type', 'x-vercel-error', 'x-nf-error', 'location'];

/**
 * Speak the scanner's error vocabulary, not the Workers runtime's.
 *
 * pace.ts treats exactly one thing as "slow down": ECONNRESET. That is Node's
 * name for it — the Workers runtime says "Network connection lost." for the
 * same event — so a reset arriving through here would otherwise read as a dead
 * host and the limiter would never back off. Translating at the boundary keeps
 * one vocabulary on the scanner side whichever path a request took.
 */
function normalizeError(err) {
  const raw = err?.cause?.code ?? err?.code ?? '';
  if (raw) return raw;
  const message = String(err?.message ?? err?.name ?? 'unknown');
  if (/connection (lost|reset|closed)|reset by peer|socket hang up/i.test(message)) {
    return 'ECONNRESET';
  }
  if (/timed? ?out|aborted/i.test(message)) return 'UND_ERR_CONNECT_TIMEOUT';
  return message.slice(0, 40);
}

async function readCapped(res) {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(total, MAX_BODY_BYTES));
  let offset = 0;
  for (const part of chunks) {
    if (offset >= out.length) break;
    out.set(part.subarray(0, out.length - offset), offset);
    offset += part.length;
  }
  return out;
}

export default {
  async fetch(request, env) {
    if (env.PROXY_TOKEN && request.headers.get('x-npfd-token') !== env.PROXY_TOKEN) {
      return meta({ error: 'unauthorized' }, null, 401);
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return meta({ error: 'missing url' }, null, 400);

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return meta({ error: 'bad url' }, null, 400);
    }
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || !ALLOWED_SUFFIXES.some((s) => host.endsWith(s))) {
      return meta({ error: 'host not allowed' }, null, 403);
    }

    // Every failure mode comes back as a 200 carrying x-npfd-error, so the
    // scanner never has to guess whether a non-200 is the target's answer or
    // this service's. Its own diagnosis of *why* a fetch died is the whole
    // reason http.ts unwraps `cause` — losing that here would put us back to
    // "the request failed", which is not a diagnosis.
    try {
      const upstream = await fetch(parsed.toString(), {
        method: 'GET',
        headers: {
          'user-agent': request.headers.get('x-npfd-user-agent') ?? 'no-place-for-drainers/1.0',
          accept: request.headers.get('x-npfd-accept') ?? '*/*',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(
          Number(request.headers.get('x-npfd-timeout')) || DEFAULT_TIMEOUT_MS,
        ),
      });

      const body = await readCapped(upstream);
      const forwarded = {};
      for (const name of FORWARD_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) forwarded[name] = value;
      }
      return meta(
        {
          status: upstream.status,
          'final-url': upstream.url || parsed.toString(),
          headers: JSON.stringify(forwarded),
        },
        body,
      );
    } catch (err) {
      return meta({ status: 0, error: normalizeError(err), 'final-url': parsed.toString() });
    }
  },
};
