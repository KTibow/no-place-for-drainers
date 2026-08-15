/**
 * Stage 3 — liveness, for both paths at once.
 *
 * A HEAD is one round trip and kills the ~85% of guessed hosts that were never
 * deployed. 451 is special: Vercel returns it with `x-vercel-error:
 * DEPLOYMENT_DISABLED` once abuse has already taken a deployment down, which is
 * free ground truth that this candidate was worth looking at.
 */
import { LIVE_STATUSES, PROBE_CONCURRENCY, PROBE_TIMEOUT_MS, TAKEDOWN_STATUS } from './config.ts';
import { request } from './http.ts';
import * as log from './log.ts';
import type { Candidate, LiveSite } from './types.ts';
import { pool } from './util.ts';

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
function bucket(status: number): string {
  if (status === 0) return 'err';
  if (status === TAKEDOWN_STATUS) return '451';
  if (LIVE_STATUSES.has(status)) return 'live';
  return String(status);
}

export async function probeLiveness(candidates: Candidate[]): Promise<ProbeResult> {
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

  await pool(candidates, PROBE_CONCURRENCY, async (candidate) => {
    const res = await request(candidate.url, {
      method: 'HEAD',
      tries: 2,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    const server = res.headers.get('server') ?? '';
    const note = res.headers.get('x-vercel-error') ?? res.headers.get('x-nf-error') ?? '';
    const site: LiveSite = { ...candidate, status: res.status, server, note };

    const key = bucket(res.status);
    statuses.set(key, (statuses.get(key) ?? 0) + 1);

    if (res.status === TAKEDOWN_STATUS) {
      takedowns.push(site);
      log.site(
        candidate.host,
        'takedown',
        `451 ${note || 'no reason header'} src=${candidate.source} repo=github.com/${candidate.repo} created=${candidate.repoCreatedAt}`,
      );
    } else if (LIVE_STATUSES.has(res.status)) {
      live.push(site);
      log.site(
        candidate.host,
        'live',
        `${res.status} src=${candidate.source} repo=${candidate.repo} created=${candidate.repoCreatedAt}`,
      );
    }

    if (++done % 500 === 0) log.info(`probed ${done}/${candidates.length} — ${tally()}`);
  });

  log.info(`probed ${done}/${candidates.length} — ${tally()}`);
  return { live, takedowns, statuses: Object.fromEntries(statuses) };
}
