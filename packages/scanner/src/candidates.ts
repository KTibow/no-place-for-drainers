/**
 * Stage 2 — two paths from a repo to a URL.
 *
 *   homepage path : the repo's homepage field, kept only if it points at a free
 *                   host. Exact, no guessing, but only ~25% of repos set it.
 *   name path     : Vercel's default deployment name is the repo name, so
 *                   `github.com/x/wallet-restore-portal` is very likely
 *                   `wallet-restore-portal.vercel.app`. Free, and it reaches
 *                   the repos that never fill in a homepage.
 *
 * The name is guessed literally. Vercel's `-<color>-<greek>` collision suffixes
 * land on the *deployment* host, never on the repo name, so stripping them here
 * fired on 0 of 1000 recent repo names — and on the rare hit it was wrong
 * (`ruby`, `pi`, `tan` and `rose` are ordinary word endings) while replacing
 * the correct guess rather than supplementing it. That regex belongs on
 * observed hostnames as a kit-clustering key, if we ever want one.
 */
import {
  FREE_HOSTS,
  GUESS_HOST_SUFFIX,
  looksLikeLure,
  MIN_GUESS_NAME_LENGTH,
} from './config.ts';
import type { Candidate, Repo } from './types.ts';
import { hostOf } from './util.ts';

/** Same slug rules Vercel applies to a repo name. */
function normalizeName(nameWithOwner: string): string {
  return nameWithOwner
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

/** host + path, no scheme, no trailing slash. */
export function labelOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}

function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    u.search = '';
    u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** Homepage path first: an exact URL always beats a guess at the same host. */
export function buildCandidates(repos: Repo[]): Candidate[] {
  const out = new Map<string, Candidate>();

  for (const repo of repos) {
    // A fork inherits the upstream's homepage field, so its homepage points at
    // the upstream's deployment rather than anything this account shipped.
    // Measured on 444 new forks: 195 had a homepage identical to the parent's,
    // 1 differed. Keeping them spends a third of this path re-probing other
    // people's established projects, and records the forker as the owner of a
    // site they never deployed — the one error in an abuse feed that hurts
    // somebody. The name path deliberately keeps forks; see below.
    if (repo.isFork) continue;
    const url = normalizeUrl(repo.homepageUrl ?? '');
    if (!url) continue;
    const host = hostOf(url);
    if (!FREE_HOSTS.test(host)) continue;
    if (!out.has(url)) {
      out.set(url, {
        url,
        host,
        label: labelOf(url),
        source: 'homepage',
        repo: repo.nameWithOwner,
        repoCreatedAt: repo.createdAt,
      });
    }
  }

  for (const repo of repos) {
    // Forks stay here. A fork keeps the upstream's name, so most guess a
    // hostname the upstream already owns — waste, but the lure filter below
    // removes ~98% of names before they cost a request. The ~9% of forks that
    // were renamed are worth the rest: a forked kit under a new name is what
    // repackaging looks like.
    const base = normalizeName(repo.nameWithOwner);
    if (base.length < MIN_GUESS_NAME_LENGTH) continue;
    // The name has to earn the request. Guessing for every repo is ~35,000
    // requests at one provider, and vercel answers that by resetting every
    // connection from the source IP. Measured on live repo names, this keeps
    // ~2%, so a 50k-repo run guesses ~880 hosts instead of ~34,700.
    if (!looksLikeLure(base)) continue;
    const host = `${base}.${GUESS_HOST_SUFFIX}`;
    const url = `https://${host}`;
    if (!out.has(url)) {
      out.set(url, {
        url,
        host,
        label: host,
        source: 'guess',
        repo: repo.nameWithOwner,
        repoCreatedAt: repo.createdAt,
      });
    }
  }

  /**
   * Guessed names first. Providers rate-limit by source IP and the block is
   * sticky for minutes, so the tail of this list is the part that may never get
   * probed — and until now the tail was the guesses. The last run proved it:
   * when the block landed, 2,540 homepage candidates had been probed and
   * exactly 2 guesses had. The guesses are the ones a keyword filter already
   * judged worth the request; they should not be queued behind a few thousand
   * URLs whose only credential is that somebody typed them into a form field.
   */
  const rank = (c: Candidate) => (c.source === 'guess' ? 0 : 1);
  return [...out.values()].sort((a, b) => rank(a) - rank(b));
}
