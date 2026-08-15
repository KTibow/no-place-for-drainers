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
  lureScore,
  MIN_GUESS_NAME_LENGTH,
} from './config.ts';
import { isPaced } from './pace.ts';
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

/**
 * One rule, scoped to the constraint rather than to how we found the candidate:
 * if the provider rations requests, the name has to earn one.
 *
 * Vercel answers an over-eager scanner by resetting connections and gives a CI
 * runner somewhere between 38 and 1,900 requests before it does. github.io
 * served 600 requests at 68/s without complaint. So a lure-less name is worth a
 * request at one provider and not at the other, and that has nothing to do with
 * whether we guessed the URL or read it from a homepage field.
 *
 * The cost is content-lane coverage on rationed providers: a drainer whose repo
 * and host are both innocuous is now only reachable there if something else
 * nominates it. On an unrationed provider we still fetch everything and let the
 * page speak for itself.
 */
function earnsRequest(url: string, name: string): boolean {
  return !isPaced(url) || looksLikeLure(name);
}

/**
 * Note on what this costs the deployment path, because it is easy to
 * misattribute.
 *
 * The Deployments API supplies vercel.app URLs at ~4.7% of new repos (14 per
 * 296 measured), which is thousands per run — far more than the 30-100 requests
 * vercel actually grants us. Almost all of them are then dropped here, by our
 * filter, not by any shortcoming of the API. Preview aliases like
 * `name-o36ymav92-owner-projects.vercel.app` are live and perfectly scannable;
 * being non-canonical does not matter to a scanner.
 *
 * Keeping the filter on them is still the right call, but only for a reason
 * worth stating: with a fixed request budget the quantity to maximise is
 * P(live) x P(abusive | live). A deployment URL has P(live) ~= 1 against ~0.15
 * for a guess, so it dominates a guess at equal suspicion — which is why it
 * sorts first. An *unfiltered* deployment URL trades that 6.7x liveness edge
 * against however much the lure vocabulary raises P(abusive), and the
 * vocabulary is worth more than 6.7x on a provider this starved.
 */

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

  // Deployment URLs first: GitHub is telling us where this repo actually
  // published, so unlike a guess the site is certain to exist, and unlike a
  // homepage field it cannot be stale or inherited. Forks are kept here for
  // exactly that reason — a fork's homepage comes from its parent, but its
  // deployments are its own.
  for (const repo of repos) {
    const url = normalizeUrl(repo.deploymentUrl ?? '');
    if (!url) continue;
    const host = hostOf(url);
    if (!FREE_HOSTS.test(host)) continue;
    if (!earnsRequest(url, `${labelOf(url)} ${repo.nameWithOwner}`)) continue;
    if (!out.has(url)) {
      out.set(url, {
        url,
        host,
        label: labelOf(url),
        source: 'deployment',
        repo: repo.nameWithOwner,
        repoCreatedAt: repo.createdAt,
      });
    }
  }

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
    if (!earnsRequest(url, `${labelOf(url)} ${repo.nameWithOwner}`)) continue;
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
    // Guesses are all on the rationed provider, so the same rule applies:
    // measured on live repo names it keeps ~2%, which is ~880 guessed hosts per
    // 50k-repo run instead of ~34,700.
    if (!earnsRequest(`https://${base}.${GUESS_HOST_SUFFIX}`, base)) continue;
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
  // The canary first, always. It is the only thing that can tell a quiet day
  // from a broken scanner, and it spent the last run at the back of a queue
  // that a provider block truncated — so it never ran at all.
  // A deployment URL beats a guess on the same budget: identically filtered,
  // but certain to resolve rather than ~15% likely to.
  const order: Record<string, number> = { canary: 0, deployment: 1, guess: 2, homepage: 3 };
  const rank = (c: Candidate) => order[c.source] ?? 9;
  const strength = (c: Candidate) => lureScore(`${c.label} ${c.repo}`);
  return [...out.values()].sort((a, b) => rank(a) - rank(b) || strength(b) - strength(a));
}
