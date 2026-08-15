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
 * does not hardcode a guess: it starts conservative, backs off hard whenever
 * the provider starts resetting, and creeps back up while it is being answered.
 *
 * Everything not listed here is unpaced — github.io, the GitHub API and the LLM
 * endpoint have never shown this behaviour.
 */
import * as log from './log.ts';
import { sleep } from './util.ts';

/** Opening request rate per second, per provider. */
const START_RPS = 4;
const MIN_RPS = 0.5;
const MAX_RPS = 16;
/** Requests that may go out back to back before pacing bites. */
const BURST = 20;
/** How long to stop talking to a provider entirely once it starts resetting. */
const COOLDOWN_MS = 90_000;
/** Consecutive clean responses before creeping the rate back up. */
const RECOVERY_STREAK = 250;

const PACED_PROVIDERS = ['vercel.app'];

type Bucket = {
  rps: number;
  tokens: number;
  updated: number;
  blockedUntil: number;
  streak: number;
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

function bucketFor(provider: string): Bucket {
  let bucket = buckets.get(provider);
  if (!bucket) {
    bucket = { rps: START_RPS, tokens: BURST, updated: Date.now(), blockedUntil: 0, streak: 0 };
    buckets.set(provider, bucket);
  }
  return bucket;
}

/** Blocks until this request is allowed to go out. */
export async function acquire(url: string): Promise<void> {
  const provider = providerOf(url);
  if (!provider) return;
  const bucket = bucketFor(provider);

  for (;;) {
    const now = Date.now();

    if (now < bucket.blockedUntil) {
      await sleep(Math.min(bucket.blockedUntil - now, 5000));
      continue;
    }

    bucket.tokens = Math.min(BURST, bucket.tokens + ((now - bucket.updated) / 1000) * bucket.rps);
    bucket.updated = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
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

  if (error === 'ECONNRESET' || error === 'UND_ERR_SOCKET') {
    if (Date.now() < bucket.blockedUntil) return; // already backing off
    bucket.rps = Math.max(MIN_RPS, bucket.rps / 2);
    bucket.blockedUntil = Date.now() + COOLDOWN_MS;
    bucket.tokens = 0;
    bucket.streak = 0;
    log.warn(
      `${provider} is resetting connections — pausing ${COOLDOWN_MS / 1000}s, rate now ${bucket.rps}/s`,
    );
    return;
  }

  if (error) return; // some other failure, not a signal about pace
  if (++bucket.streak >= RECOVERY_STREAK && bucket.rps < MAX_RPS) {
    bucket.streak = 0;
    bucket.rps = Math.min(MAX_RPS, bucket.rps * 1.25);
    log.info(`${provider} steady for ${RECOVERY_STREAK} requests — rate now ${bucket.rps.toFixed(1)}/s`);
  }
}

/** For the run summary: what each provider settled at. */
export function rates(): Record<string, number> {
  return Object.fromEntries(
    [...buckets].map(([provider, bucket]) => [provider, Number(bucket.rps.toFixed(2))]),
  );
}
