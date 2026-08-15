/**
 * Stage 3 — liveness, for both paths at once, and the page while we are there.
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
import { decode, hostOf, pool } from './util.ts';

export type ProbeResult = {
  live: LiveSite[];
  takedowns: LiveSite[];
  statuses: Record<string, number>;
};

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

export async function probeLiveness(
  candidates: Candidate[],
  concurrency: number,
  track: string,
): Promise<ProbeResult> {
  const live: LiveSite[] = [];
  const takedowns: LiveSite[] = [];
  const statuses = new Map<string, number>();
  let done = 0;

  const tally = () =>
    [...statuses]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => `${name}:${count}`)
      .join(' ');

  const probeOne = async (candidate: Candidate) => {
    // One GET, following redirects, keeping the body. A dead host costs a few
    // extra KB; a live one saves an entire request at a provider that counts
    // them. Stage 4 then only goes back for JS bundles.
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
      statuses.set('protected', (statuses.get('protected') ?? 0) + 1);
      log.site(track, candidate.label, 'drop', `deployment is protected — redirects to ${finalHost}`);
      if (++done % 500 === 0) log.info(track, `probed ${done}/${candidates.length} — ${tally()}`);
      return;
    }

    const server = res.headers.get('server') ?? '';
    const note = res.headers.get('x-vercel-error') ?? res.headers.get('x-nf-error') ?? '';
    const site: LiveSite = {
      ...candidate,
      status: res.status,
      server,
      note,
      html: res.body.length ? decode(res.body) : '',
    };

    const key = bucket(res.status, res.error);
    statuses.set(key, (statuses.get(key) ?? 0) + 1);

    if (res.status === TAKEDOWN_STATUS) {
      takedowns.push(site);
      log.site(track, 
        candidate.label,
        'takedown',
        `451 ${note || 'no reason header'} src=${candidate.source} repo=github.com/${candidate.repo} created=${candidate.repoCreatedAt}`,
      );
    } else if (LIVE_STATUSES.has(res.status)) {
      live.push(site);
      log.site(track, 
        candidate.label,
        'live',
        `${res.status} src=${candidate.source} repo=${candidate.repo} created=${candidate.repoCreatedAt}`,
      );
    }

    if (++done % 500 === 0) log.info(track, `probed ${done}/${candidates.length} — ${tally()}`);
  };

  await pool(candidates, concurrency, probeOne);

  log.info(track, `probed ${done}/${candidates.length} — ${tally()}`);
  return { live, takedowns, statuses: Object.fromEntries(statuses) };
}
