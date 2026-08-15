/**
 * Per-provider pacing.
 *
 * Vercel rate-limits by source IP, and it does not answer with 429 — it resets
 * the TCP connection and keeps doing so for minutes. Three runs died to this
 * before the probe tally made it visible. Measured against *.vercel.app:
 *
 *     3/s,  90 requests  → 0 errors
 *     8/s,  90 requests  → 0 errors
 *    16/s, 300 requests  → first reset at request 267
 *    59/s (local burst)  → first reset at request 313
 *    98/s (CI burst)     → first reset around request 1,700
 *
 * Trips cluster near a few hundred requests rather than at a rate, which reads
 * like a token bucket of roughly that capacity with a slow refill. The refill
 * is the number that matters and it is not observable from outside, so this
 * does not hardcode a guess: it sits deliberately below the observed ceiling
 * and only ever backs off. See RPS for why it never climbs.
 *
 * Everything not listed here is unpaced — github.io, the GitHub API and the LLM
 * endpoint have never shown this behaviour.
 */
import * as log from './log.ts';
import { sleep } from './util.ts';

/**
 * Deliberately below the observed ceiling, and it never climbs.
 *
 * An earlier version used AIMD — creep up, halve on failure — which is right
 * when overshooting costs one retry. Here overshooting costs minutes of sticky
 * block, so probing for the ceiling is far more expensive than the throughput
 * it buys. Measured: 4-12/s sustained 1,750 requests with zero errors, and the
 * run died ~150 requests after the ramp touched 16/s (locally, 16/s tripped at
 * request 267). We do not need to know the exact ceiling. We need to finish.
 */
const RPS = 6;
const MIN_RPS = 0.5;
/** Requests that may go out back to back before pacing bites. */
const BURST = 20;
/**
 * First cooldown, doubled on each subsequent trip. 90s was not enough: every
 * pause expired while the block was still in force, one request got through,
 * and it tripped again — a 90-second sawtooth that made no progress for
 * fourteen minutes.
 */
const COOLDOWN_MS = 120_000;
const MAX_COOLDOWN_MS = 600_000;
/** After this many trips, stop spending the run on a provider that is done with us. */
const MAX_TRIPS = 4;
/**
 * A healthy source IP sustains hundreds of requests at this rate — measured,
 * 700 at 3/s and 700 at 6/s with zero errors. Tripping in the first few dozen
 * therefore does not mean we were too fast; it means the bucket was already
 * empty when we arrived, which is the normal state of a shared CI runner
 * address. Nothing we do in this run will refill it, so stop early instead of
 * spending fifteen minutes proving it: the last run burned 878s to learn that
 * 38 requests was the whole budget.
 */
const HEALTHY_ARRIVAL = 250;
const TRIPS_WHEN_PENALIZED = 2;

const PACED_PROVIDERS = ['vercel.app'];

type Bucket = {
  rps: number;
  tokens: number;
  updated: number;
  blockedUntil: number;
  trips: number;
  /** Requests actually issued, and how many before the provider first balked. */
  issued: number;
  issuedBeforeFirstTrip: number | null;
  abandoned: boolean;
};

const buckets = new Map<string, Bucket>();

function providerOf(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
  return PACED_PROVIDERS.find((p) => host === p || host.endsWith(`.${p}`)) ?? null;
}

/**
 * Whether this URL goes through the limiter at all. Callers use it to run the
 * paced and unpaced populations as separate lanes: they share nothing, and a
 * provider that rations requests should not be able to stall a provider that
 * does not.
 */
export function isPaced(url: string): boolean {
  return providerOf(url) !== null;
}

/** Log under the track that owns this provider, so its warnings line up. */
function trackOf(provider: string): string {
  return provider.replace(/\.(app|dev|io)$/, '');
}

function bucketFor(provider: string): Bucket {
  let bucket = buckets.get(provider);
  if (!bucket) {
    bucket = {
      rps: RPS,
      tokens: BURST,
      updated: Date.now(),
      blockedUntil: 0,
      trips: 0,
      issued: 0,
      issuedBeforeFirstTrip: null,
      abandoned: false,
    };
    buckets.set(provider, bucket);
  }
  return bucket;
}

/**
 * Blocks until this request may go out. Returns false when the provider has
 * refused us often enough that continuing would spend the rest of the run
 * discovering that it is still refusing.
 */
export async function acquire(url: string): Promise<boolean> {
  const provider = providerOf(url);
  if (!provider) return true;
  const bucket = bucketFor(provider);
  if (bucket.abandoned) return false;

  for (;;) {
    const now = Date.now();

    if (now < bucket.blockedUntil) {
      await sleep(Math.min(bucket.blockedUntil - now, 5000));
      if (bucket.abandoned) return false;
      continue;
    }

    bucket.tokens = Math.min(BURST, bucket.tokens + ((now - bucket.updated) / 1000) * bucket.rps);
    bucket.updated = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      bucket.issued++;
      return true;
    }
    await sleep(Math.ceil(((1 - bucket.tokens) / bucket.rps) * 1000));
  }
}

/**
 * Feed the outcome back. A connection reset is the provider's only way of
 * saying "slow down", so it is treated as such rather than as a dead host.
 */
export function report(url: string, error?: string): void {
  const provider = providerOf(url);
  if (!provider) return;
  const bucket = bucketFor(provider);
  if (bucket.abandoned) return; // already given up; stop re-announcing it

  if (error !== 'ECONNRESET' && error !== 'UND_ERR_SOCKET') return;
  if (Date.now() < bucket.blockedUntil) return; // already backing off

  bucket.issuedBeforeFirstTrip ??= bucket.issued;
  bucket.trips++;
  bucket.rps = Math.max(MIN_RPS, bucket.rps / 2);

  const arrivedPenalized = (bucket.issuedBeforeFirstTrip ?? 0) < HEALTHY_ARRIVAL;
  const limit = arrivedPenalized ? TRIPS_WHEN_PENALIZED : MAX_TRIPS;

  if (bucket.trips >= limit) {
    bucket.abandoned = true;
    log.warn(trackOf(provider),
      `${provider} gave us ${bucket.issuedBeforeFirstTrip} requests before its first reset` +
        `${arrivedPenalized ? ' (arrived rate-limited — this IP had no budget to begin with)' : ''}` +
        ` and is still resetting after ${bucket.trips} backoffs — giving up on it for this run`,
    );
    return;
  }

  const cooldown = Math.min(MAX_COOLDOWN_MS, COOLDOWN_MS * 2 ** (bucket.trips - 1));
  bucket.blockedUntil = Date.now() + cooldown;
  bucket.tokens = 0;
  log.warn(trackOf(provider),
    `${provider} is resetting connections after ${bucket.issued} requests — ` +
      `pausing ${cooldown / 1000}s, rate now ${bucket.rps}/s`,
  );
}

/**
 * For the run summary. `issuedBeforeFirstTrip` is the number worth watching: it
 * is the provider's actual budget, measured, rather than inferred from a log.
 */
export function stats(): Record<string, unknown> {
  return Object.fromEntries(
    [...buckets].map(([provider, b]) => [
      provider,
      {
        issued: b.issued,
        issuedBeforeFirstTrip: b.issuedBeforeFirstTrip,
        trips: b.trips,
        finalRps: Number(b.rps.toFixed(2)),
        abandoned: b.abandoned,
      },
    ]),
  );
}
