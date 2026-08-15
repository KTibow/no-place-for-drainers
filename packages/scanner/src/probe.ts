/**
 * Stage 3 — liveness, and the page while we are there.
 *
 * One GET per candidate. A HEAD would be cheaper in bytes, but the providers
 * that matter ration *requests*, not bandwidth, and every live site then cost a
 * second request to fetch the page it had just told us about.
 *
 * 451 is special: Vercel returns it with `x-vercel-error: DEPLOYMENT_DISABLED`
 * once abuse has already taken a deployment down, which is free ground truth
 * that this candidate was worth looking at.
 */
import {
  LIVE_STATUSES,
  PROBE_TIMEOUT_MS,
  PROTECTION_HOSTS,
  TAKEDOWN_STATUS,
} from './config.ts';
import { request } from './http.ts';
import * as log from './log.ts';
import type { Candidate, LiveSite } from './types.ts';
import { decode, hostOf } from './util.ts';

/**
 * One bucket per outcome. Without this the log only ever names the hits, so a
 * long silent stretch is indistinguishable between "these hosts do not exist"
 * and "we are being refused and dropping the answers on the floor" — a
 * distinction that has already cost one wrong diagnosis.
 */
function bucket(status: number, error?: string): string {
  if (status === 0) return `err-${error ?? 'unknown'}`;
  if (status === TAKEDOWN_STATUS) return '451';
  if (LIVE_STATUSES.has(status)) return 'live';
  return String(status);
}

export type ProbeOutcome =
  | { kind: 'live'; site: LiveSite; statusKey: string }
  | { kind: 'takedown'; site: LiveSite; statusKey: string }
  | { kind: 'dead'; statusKey: string };

/**
 * Probe one candidate. Returning per-site rather than per-batch is what lets a
 * worker carry a high-priority name all the way to a verdict while the rest of
 * the queue is still being probed — and what leaves findings on disk when a run
 * is killed halfway.
 */
export async function probeSite(candidate: Candidate, track: string): Promise<ProbeOutcome> {
  // One GET, following redirects, keeping the body. A dead host costs a few
  // extra KB; a live one saves an entire request at a provider that counts them.
  const res = await request(candidate.url, {
    tries: 2,
    timeoutMs: PROBE_TIMEOUT_MS,
    redirect: 'follow',
    headers: { accept: 'text/html,application/xhtml+xml' },
  });

  // Where did we actually end up? A deployment behind password protection
  // redirects to its provider's login page, and following that would attribute
  // the provider's own page to this candidate.
  const finalHost = hostOf(res.url || candidate.url);
  if (finalHost !== candidate.host && PROTECTION_HOSTS.some((h) => finalHost.endsWith(h))) {
    log.site(track, candidate.label, 'drop', `deployment is protected — redirects to ${finalHost}`);
    return { kind: 'dead', statusKey: 'protected' };
  }

  const note = res.headers.get('x-vercel-error') ?? res.headers.get('x-nf-error') ?? '';
  const site: LiveSite = {
    ...candidate,
    status: res.status,
    server: res.headers.get('server') ?? '',
    note,
    html: res.body.length ? decode(res.body) : '',
  };
  const statusKey = bucket(res.status, res.error);

  if (res.status === TAKEDOWN_STATUS) {
    log.site(
      track,
      candidate.label,
      'takedown',
      `451 ${note || 'no reason header'} src=${candidate.source} repo=github.com/${candidate.repo} created=${candidate.repoCreatedAt}`,
    );
    return { kind: 'takedown', site, statusKey };
  }

  if (LIVE_STATUSES.has(res.status)) {
    log.site(
      track,
      candidate.label,
      'live',
      `${res.status} src=${candidate.source} repo=${candidate.repo} created=${candidate.repoCreatedAt}`,
    );
    return { kind: 'live', site, statusKey };
  }

  return { kind: 'dead', statusKey };
}
