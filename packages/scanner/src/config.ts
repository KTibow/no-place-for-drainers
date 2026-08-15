/**
 * Every knob lives here. There are deliberately no CLI flags and no config
 * files — if something needs to change, change the constant.
 */
import { fileURLToPath } from 'node:url';

// ── stage 1: /repositories walk ─────────────────────────────────────────────
/**
 * How far back to look. Runs every 8 hours (see the workflow), so a 10 hour
 * window leaves 2 hours of overlap — Actions cron drifts, and a gap in the
 * window is a repo nobody ever looks at. Overlap only costs a re-probe; the
 * site dedupes by host.
 *
 * Shorter windows also sample better: with a fixed REPO_LIMIT, 50k repos is a
 * far larger fraction of 10 hours than of 24.
 */
export const WINDOW_HOURS = 10;
/** GitHub's search index lags reality; never treat the last N minutes as head. */
export const HEAD_LAG_MINUTES = 15;
/**
 * Hard cap on repos hydrated per run. This is the throttle for the whole
 * pipeline; measured ratios downstream are roughly 0.9 candidates per repo,
 * 22% of candidates live, and 1 triage per ~30 live sites. A shard walks about
 * 1.4 minutes of GitHub's creation timeline per 300 repos, so the cap divided
 * across the shards is what fraction of the window actually gets sampled.
 */
export const REPO_LIMIT = 50_000;
/** Parallel walkers, each covering an equal slice of the repo-id range. */
export const WALK_SHARDS = 8;
/** GraphQL node hydration: 300 nodes = 1 rate-limit point. */
export const HYDRATE_BATCH = 300;

// ── stage 2: candidate URLs ─────────────────────────────────────────────────
/** Homepage path: these hosts are free, instant, and disposable. */
export const FREE_HOSTS = /\.(vercel\.app|netlify\.app|pages\.dev|github\.io)$/i;
/** Name path: what we append to a normalized repo name to guess a deployment. */
export const GUESS_HOST_SUFFIX = 'vercel.app';
/** Names <= 6 chars collide with unrelated deployments (measured ~27% FP). */
export const MIN_GUESS_NAME_LENGTH = 7;

/**
 * The lure vocabulary. Guessing a deployment for every new repo means ~35,000
 * requests at one provider, which vercel's edge answers by resetting every
 * connection from the source IP after a few hundred. So the name has to earn
 * the probe, and this is the filter that decides.
 *
 * Split by how the word behaves in a real name, not by category. Drainer repos
 * glue their words together — `dappmainnet`, `secureddapps`, `helpchat` — so
 * anything that shows up mid-compound has to match as a substring. Short or
 * ambiguous tokens get \b instead, which keeps `dex-aggregator` and `eth-wallet`
 * while dropping `codex`, `index`, `nodejs`, `electron` and `automatic`.
 *
 * Separators are normalized to `-` before matching, because JS treats `_` as a
 * word character and `\bbank\b` would otherwise miss `bank_loan`.
 */
const LURE_ANYWHERE = [
  // wallets and the brands drainers impersonate
  'wallet', 'metamask', 'phantom', 'trezor', 'exodus', 'safepal', 'walletconnect',
  'coinbase', 'binance', 'kraken', 'bybit', 'kucoin', 'bitget', 'blockfi', 'ledger',
  // the vocabulary of crypto product pages
  'crypto', 'bitcoin', 'ethereum', 'solana', 'arbitrum', 'polygon', 'blockchain',
  'mainnet', 'testnet', 'web3', 'dapp', 'defi', 'airdrop', 'presale', 'launchpad',
  'staking', 'liquidity', 'whitelist', 'bridge', 'swap',
  // what the lure asks the visitor to do
  'claim', 'restore', 'recover', 'validat', 'verif', 'migrat', 'unlock', 'rectif',
  'activate', 'authoriz', 'redeem', 'withdraw', 'resolve', 'reactivat',
  // trust and support framing
  'secure', 'protect', 'support', 'helpdesk', 'help', 'refund', 'reward',
  'giveaway', 'bonus',
  // money
  'bank', 'finance', 'financial', 'invest', 'trading', 'exchange', 'payment',
  'paypal', 'vault', 'treasury',
  // credentials
  'login', 'signin', 'password', 'mnemonic', 'privatekey', 'keystore', 'recovery',
];

/** Short or ambiguous — these need boundaries or they match half of GitHub. */
const LURE_BOUNDED = [
  'dex', 'eth', 'btc', 'bnb', 'sol', 'nft', 'ido', 'ico', 'otp', 'kyc', 'node',
  'tron', 'matic', 'avax', 'coin', 'token', 'mint', 'stake', 'seed', 'phrase',
  'sync', 'auth', 'account', 'fund', 'funds', 'pay', 'trust', 'chat', 'assist',
  'guard', 'asset', 'assets', 'capital', 'gift', 'prize', 'winner', 'trader',
];

export const LURE = new RegExp(
  [...LURE_ANYWHERE, ...LURE_BOUNDED.map((word) => `\\b${word}\\b`)].join('|'),
  'i',
);

const LURE_GLOBAL = new RegExp(LURE.source, 'gi');

/** True when a name is worth spending a request on. */
export function looksLikeLure(name: string): boolean {
  return LURE.test(name.replace(/[._]+/g, '-'));
}

/**
 * How many distinct lure words a name contains. Used to order the queue, not
 * to filter it: when a provider only lets a few dozen requests through, those
 * requests should go to `wallet-restore-sync` before `study-sync-app`, and
 * ordering is the only lever that survives an arbitrary budget.
 */
export function lureScore(name: string): number {
  const normalized = name.replace(/[._]+/g, '-');
  return new Set([...normalized.matchAll(LURE_GLOBAL)].map((m) => m[0].toLowerCase())).size;
}

// ── stage 3: liveness ───────────────────────────────────────────────────────
export const LIVE_STATUSES = new Set([200, 301, 302, 307, 308, 401, 403]);
/**
 * Hosts that mean "this deployment is password-protected", not "this is the
 * site". A Vercel deployment with protection enabled 307s to
 * vercel.com/login?next=/sso-api…, and because the probe follows redirects we
 * would otherwise fetch Vercel's own 481 KB login page and hand it to the
 * classifier as the candidate's content. That produced a confident
 * "generic-credential-phish" verdict on Vercel's actual login screen.
 *
 * Attributing another host's page to this repo is the same failure as
 * inheriting a fork's homepage: it names the wrong owner.
 */
export const PROTECTION_HOSTS = [
  'vercel.com',
  'vercel.app/sso',
  'netlify.com',
  'app.netlify.com',
  'github.com',
  'cloudflareaccess.com',
];
/** x-vercel-error: DEPLOYMENT_DISABLED — free ground truth that someone got there first. */
export const TAKEDOWN_STATUS = 451;
export const PROBE_CONCURRENCY = 64;
/**
 * Workers for rate-limited providers. Their throughput is set by the limiter,
 * not by this, so it only needs enough in flight to keep the bucket drained —
 * and it runs as a separate lane so a paced provider cannot stall an unpaced
 * one. github.io is the bulk of the candidates and has never rationed anything.
 */
export const PACED_CONCURRENCY = 12;
export const PROBE_TIMEOUT_MS = 20_000;

// ── stage 4: dossier ────────────────────────────────────────────────────────
export const FETCH_CONCURRENCY = 24;
export const FETCH_TIMEOUT_MS = 20_000;
/** Largest body we will read. Real pages in the wild have hit 4.3 MB. */
export const MAX_BODY_BYTES = 2_000_000;
/** Below this much visible text the page is an SPA shell — the signal is in the bundle. */
export const SPA_SHELL_TEXT_BYTES = 1500;
/** How many <script src> bundles to pull per SPA shell. */
export const MAX_BUNDLES = 3;
/**
 * Ceiling on the extracted corpus. A 2 MB bundle can yield megabytes of string
 * literals, and thousands of those at once will not fit in a runner. Signal is
 * front-loaded — the canary's whole harvester surfaced in the first 40k chars.
 */
export const MAX_CORPUS_CHARS = 250_000;
/** Ceiling on the rendered dossier handed to the LLM. */
export const DOSSIER_MAX_CHARS = 6000;
export const DOSSIER_MAX_EVIDENCE_LINES = 60;

// ── stage 5: detection ──────────────────────────────────────────────────────
/** Rule weight needed for the content lane to forward a site to triage. */
export const CONTENT_SCORE_THRESHOLD = 3;

// ── stage 6: LLM triage ─────────────────────────────────────────────────────
export const LLM_BASE_URL = 'https://crof.ai/v1';
export const LLM_MODEL = 'deepseek-v4-flash-0731';
export const LLM_REASONING_EFFORT = 'low';
/**
 * No max_tokens on purpose. It is a reasoning model, so the cap is shared with
 * reasoning_content, and a dossier that provokes a long deliberation spends the
 * whole allowance before writing any JSON — the answer comes back truncated and
 * the verdict is lost. The real bound is LLM_TIMEOUT_MS; a runaway generation
 * costs a fraction of a cent, a silently dropped verdict costs a drainer.
 */
export const LLM_CONCURRENCY = 6;
export const LLM_TIMEOUT_MS = 120_000;
/** A site reaches the analyst queue at verdict=malicious and at least this much confidence. */
export const LLM_MIN_CONFIDENCE = 0.7;

// ── stage 7: output ─────────────────────────────────────────────────────────
/**
 * Always the repo-root `out/`, whatever the cwd. It is committed: the history
 * of this directory *is* the record, and the site is built from it.
 */
export const OUT_DIR = fileURLToPath(new URL('../../../out', import.meta.url));

// ── misc ────────────────────────────────────────────────────────────────────
export const USER_AGENT =
  'no-place-for-drainers/1.0 (defensive security research; abuse reporting)';
/** Injected every run to prove the pipeline still works end to end. */
export const CANARY_URLS = ['https://defixs-finance.vercel.app'];
