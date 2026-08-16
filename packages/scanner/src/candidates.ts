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

/**
 * Preview alias → production alias.
 *
 * The Deployments API hands us the *immutable* deployment URL —
 * `rev-recover-dkzhfqb3b-franker24s-projects.vercel.app` — and Vercel turns
 * Deployment Protection on for preview deployments by default. So every one of
 * those redirects to an SSO login and the probe correctly drops it as
 * `protected`, after spending a request it can never get anything back for.
 * Measured on run 31920222624: 43 of the 64 requests Vercel let through that
 * run — 67% of the entire budget — went to preview aliases, and all 43 were
 * protected. Zero real findings came out of the track.
 *
 * The production alias for the same project is `<project>.vercel.app` and is
 * public. Probing 20 of those 43 rewritten by hand: 10 × 200, 1 × 451
 * (DEPLOYMENT_DISABLED — free takedown ground truth), 9 × 404, 0 protected.
 * Same information from GitHub, same request cost, ~55% live instead of 0%.
 *
 * Parsing it: the alias is `<project>-<id>-<scope>` or `<project>-<id>`, where
 * `<id>` is exactly nine of [a-z0-9] and both `<project>` and `<scope>` may
 * contain hyphens. That is ambiguous, in both directions — a project word can
 * be nine letters (`https-h5-workorder-support-m5j7qbnmm`) and so can a scope
 * slug (`claimflow-…-10wqu10sy-jaskirat1`). What separates them is that an id
 * is base36 random while the other two are language: pick the nine-character
 * segment with the most digits. `10wqu10sy` has four and `jaskirat1` has one;
 * `m5j7qbnmm` has two and `workorder` has none. Never the first segment, since
 * the project name cannot be empty — which is also what keeps a genuine
 * production host like `bitcoin24-wallet.vercel.app` intact.
 *
 * Verified against all 50 vercel hostnames run 31920222624 reached. Ties are
 * unobserved; the leftmost wins them, because the id precedes the scope and a
 * project word with as many digits as a random id is the rarer accident.
 */
export function productionAlias(host: string): string | null {
  const match = /^(.+)\.vercel\.app$/.exec(host.toLowerCase());
  if (!match) return null;
  const parts = match[1]!.split('-');
  let pick = -1;
  let best = -1;
  for (let i = 1; i < parts.length; i++) {
    if (!/^[a-z0-9]{9}$/.test(parts[i]!)) continue;
    const digits = parts[i]!.replace(/\D/g, '').length;
    if (digits > best) {
      best = digits;
      pick = i;
    }
  }
  if (pick === -1) return null;
  return `${parts.slice(0, pick).join('-')}.vercel.app`;
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

  // Deployment URLs first: GitHub is telling us where this repo actually
  // published, so unlike a guess the site is certain to exist, and unlike a
  // homepage field it cannot be stale or inherited. Forks are kept here for
  // exactly that reason — a fork's homepage comes from its parent, but its
  // deployments are its own.
  for (const repo of repos) {
    const raw = normalizeUrl(repo.deploymentUrl ?? '');
    if (!raw) continue;
    // A vercel preview alias is a request we cannot win — see productionAlias.
    // The rewrite keeps the repo attribution, which is the part that matters:
    // GitHub told us this repo deployed to this project, and the production
    // host of that project is the one a visitor would ever be sent to.
    const production = productionAlias(hostOf(raw));
    const url = production ? `https://${production}` : raw;
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
    // No forks. This path is entirely vercel, and vercel is where the request
    // budget is measured in dozens — so what it buys has to be a *novel* lead,
    // something nobody has scanned or reported yet. A fork is by construction a
    // copy of something already public, which is the one thing that cannot be
    // novel. Even the repackaging case, which used to justify keeping renamed
    // forks here, is a kit that already exists somewhere upstream.
    //
    // Unrenamed forks were worse than unproductive. The guess is *derived from*
    // the name, so a fork that kept the upstream's name guesses the hostname the
    // upstream itself deployed to — every time, not by coincidence. The probe
    // then finds the upstream's live site and files it under the forker, which
    // is the error the homepage path above refuses for the same reason: it
    // records somebody as the owner of a site they never deployed. Seen in the
    // wild — `jiandiao/codex-auth-helper`, a fork twenty minutes old, was
    // published as the operator of codex-auth-helper.vercel.app while the page
    // itself linked to `zhishile/codex-auth-helper`, its parent.
    //
    // Measured on 2,000 consecutive new repos: 50 pass the name and lure gates,
    // 7 of those are forks. So this hands 14% of the guess budget back to names
    // that might actually be new, and the 7 it drops are one coursework repo
    // forked by three separate students, `mytonwallet` under someone else's
    // account, and a `WPF-Login` demo.
    //
    // The deployment path keeps forks on purpose: a fork's deployment record is
    // its own, so there is no misattribution and no guessing involved.
    if (repo.isFork) continue;
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
