/**
 * Every knob lives here. There are deliberately no CLI flags and no config
 * files — if something needs to change, change the constant.
 */
import { fileURLToPath } from 'node:url';

// ── stage 1: /repositories walk ─────────────────────────────────────────────
/** How far back to look for newly-created repos. */
export const WINDOW_HOURS = 24;
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

// ── stage 3: liveness ───────────────────────────────────────────────────────
export const LIVE_STATUSES = new Set([200, 301, 302, 307, 308, 401, 403]);
/** x-vercel-error: DEPLOYMENT_DISABLED — free ground truth that someone got there first. */
export const TAKEDOWN_STATUS = 451;
export const PROBE_CONCURRENCY = 64;
export const PROBE_TIMEOUT_MS = 12_000;

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
export const LLM_MAX_TOKENS = 1200;
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
