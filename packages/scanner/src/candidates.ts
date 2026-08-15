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
import { FREE_HOSTS, GUESS_HOST_SUFFIX, MIN_GUESS_NAME_LENGTH } from './config.ts';
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
    const url = normalizeUrl(repo.homepageUrl ?? '');
    if (!url) continue;
    const host = hostOf(url);
    if (!FREE_HOSTS.test(host)) continue;
    if (!out.has(url)) {
      out.set(url, {
        url,
        host,
        source: 'homepage',
        repo: repo.nameWithOwner,
        repoCreatedAt: repo.createdAt,
      });
    }
  }

  for (const repo of repos) {
    const base = normalizeName(repo.nameWithOwner);
    if (base.length < MIN_GUESS_NAME_LENGTH) continue;
    const host = `${base}.${GUESS_HOST_SUFFIX}`;
    const url = `https://${host}`;
    if (!out.has(url)) {
      out.set(url, {
        url,
        host,
        source: 'guess',
        repo: repo.nameWithOwner,
        repoCreatedAt: repo.createdAt,
      });
    }
  }

  return [...out.values()];
}
