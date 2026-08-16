/**
 * no place for drainers
 * ─────────────────────
 * Find wallet drainers and credential phishing on free hosts, hours after they
 * are deployed, by walking the one place their operators leave a paper trail:
 * the public GitHub repo they pushed to get the deployment in the first place.
 *
 *   1  /repositories walk ......... every new public repo, id-sharded
 *   2  two paths to a URL ......... repo name → guessed host | homepage field
 *      ├─ then split by provider, and run the rest twice, concurrently ─┐
 *   3  probe liveness ............. one GET, keep the body
 *   4  dossier .................... extract; follow SPA bundles
 *   5  detection .................. hostname lane | content-rule lane
 *   6  LLM triage ................. the same dossier, a second opinion
 *   7  analyst queue .............. dated JSONL of what survived
 *   8  handoff ................... urlscan for all of it, discord for vercel
 *
 * Stages 5 and 6 read the identical dossier built in stage 4, which is what
 * makes their disagreements meaningful instead of an artifact of what each one
 * happened to be shown.
 *
 * The split at stage 2 is not cosmetic. Vercel rations requests by source IP
 * and answers an over-eager scanner by resetting connections for minutes at a
 * time, so its track has to crawl. github.io has never rationed anything and
 * can run flat out. Sharing one pipeline meant every stage barrier let the slow
 * provider hold the fast one hostage; as separate tracks, neither can. It also
 * keeps the two populations reportable on their own terms, which matters
 * because they are abuse-reported to different people.
 */
import { basename } from 'node:path';
import { buildCandidates } from './candidates.ts';
import {
  CANARY_URLS,
  OFFLINE_CANARY_HTML,
  LLM_CONCURRENCY,
  LLM_MIN_CONFIDENCE,
  PACED_CONCURRENCY,
  PROBE_CONCURRENCY,
  WINDOW_HOURS,
} from './config.ts';
import { classify } from './detect.ts';
import { buildDossier, render } from './dossier.ts';
import { requireToken, walkNewRepos } from './github.ts';
import * as llm from './llm.ts';
import * as log from './log.ts';
import { AnalystQueue } from './output.ts';
import { proxyEnabled } from './http.ts';
import { isPaced, RPS as PACE_RPS } from './pace.ts';
import * as pace from './pace.ts';
import { probeSite } from './probe.ts';
import * as submit from './submit.ts';
import type { Candidate, Finding, LiveSite } from './types.ts';
import { hostOf, partition, pool, semaphore } from './util.ts';

const startedAt = Date.now();

requireToken();
llm.requireKey();
const queue = new AnalystQueue();
log.info(log.MAIN, `analyst queue → ${basename(queue.path)}`);
submit.announceSinks();

// ── stage 1 ── /repositories walk ───────────────────────────────────────────
log.stage(log.MAIN, 1, '/repositories walk', `every new public repo in the last ${WINDOW_HOURS}h`);
const { repos, cutoff } = await walkNewRepos();
log.flow(log.MAIN, 'repos', repos.length, 'hydrated with homepage + createdAt');

// ── stage 2 ── name path + homepage path ────────────────────────────────────
log.stage(log.MAIN, 2, 'candidate URLs', 'repo name → guessed host | homepage field → free hosts');
const candidates: Candidate[] = buildCandidates(repos);
// Unshift, not push: buildCandidates has already sorted, so appending would
// put the health check back at the end of the queue where a provider block
// truncates it — which is exactly how it went unprobed last run.
for (const url of CANARY_URLS) {
  candidates.unshift({
    url,
    host: hostOf(url),
    label: hostOf(url),
    source: 'canary',
    repo: 'CANARY/known-bad',
    repoCreatedAt: new Date().toISOString(),
  });
}
const bySource = (s: string) => candidates.filter((c) => c.source === s).length;
log.flow(log.MAIN, 'deployment path', bySource('deployment'), 'URLs GitHub already knows about');
log.flow(log.MAIN, 'name path', bySource('guess'), 'guessed deployments');
log.flow(log.MAIN, 'homepage path', bySource('homepage'), 'exact free-host URLs');
log.flow(log.MAIN, 'candidates', candidates.length, `deduped (+${CANARY_URLS.length} canary)`);

// ── split ── one track per provider class, run to completion independently ──
const [pacedCandidates, freeCandidates] = partition(candidates, (c) => isPaced(c.url));
log.flow(log.MAIN, 'rate-limited providers', pacedCandidates.length, 'vercel track');
// Which address the paced track leaves from decides what its budget is, so the
// log has to say — otherwise a run with 60 requests and a run with 600 look
// like the same scanner having a different day.
log.info(
  log.MAIN,
  proxyEnabled
    ? `vercel track via fetch proxy at ${PACE_RPS}/s, ${PACED_CONCURRENCY} workers`
    : 'vercel track direct from this runner (no FETCH_PROXY set)',
);
log.flow(log.MAIN, 'everything else', freeCandidates.length, 'open track');

type TrackResult = {
  name: string;
  candidates: number;
  live: number;
  takedowns: LiveSite[];
  probeStatuses: Record<string, number>;
  dossiers: number;
  hostnameLane: number;
  contentLane: number;
  triaged: number;
  confirmed: number;
  /** What each canary probe came back as: live, takedown, dead, or blocked. */
  canaryOutcomes: string[];
  elapsedSec: number;
};

const [vercelTrack, openTrack] = await Promise.all([
  runTrack('vercel', pacedCandidates, PACED_CONCURRENCY),
  runTrack('open', freeCandidates, PROBE_CONCURRENCY),
]);
const tracks = [vercelTrack, openTrack];

// ── canary ── can we still recognise a drainer, and can we still reach one ──
const offlineCanary = await runOfflineCanary();
// Four states, because a canary has a lifecycle. Caught is the good one.
// Missed means one was reachable and serving and we failed to flag it — the
// only reading that indicts the scanner. Gone means every reachable canary is
// now dead or taken down, which is a win for the world and a job for us to
// find new ones. Unreachable means the provider never let us ask.
const canaryOutcomes = tracks.flatMap((t) => t.canaryOutcomes);
const liveCanary = queue.records.some((r) => r.source === 'canary')
  ? 'caught'
  : canaryOutcomes.includes('live')
    ? 'missed'
    : canaryOutcomes.some((o) => o === 'dead' || o === 'takedown')
      ? 'gone'
      : 'unreachable';

// ── stage 7 ── summary ──────────────────────────────────────────────────────
log.stage(log.MAIN, 7, 'analyst queue', basename(queue.path));
const sum = (pick: (t: TrackResult) => number) => tracks.reduce((n, t) => n + pick(t), 0);

const summary = {
  generated: new Date().toISOString(),
  windowHours: WINDOW_HOURS,
  cutoff,
  repos: repos.length,
  candidates: candidates.length,
  candidatesByName: bySource('guess'),
  candidatesByHomepage: bySource('homepage'),
  candidatesByDeployment: bySource('deployment'),
  live: sum((t) => t.live),
  dossiers: sum((t) => t.dossiers),
  triaged: sum((t) => t.triaged),
  confirmed: sum((t) => t.confirmed),
  llmFailures: llm.failureCount(),
  // Merged across tracks for the site; each track keeps its own below.
  probeStatuses: tracks.reduce<Record<string, number>>((acc, t) => {
    for (const [status, count] of Object.entries(t.probeStatuses)) {
      acc[status] = (acc[status] ?? 0) + count;
    }
    return acc;
  }, {}),
  // Per track, because the two populations behave nothing alike and are
  // reported to different abuse desks.
  tracks: Object.fromEntries(tracks.map((t) => [t.name, t])),
  pace: pace.stats(),
  handoff: submit.stats(),
  takedowns: tracks.flatMap((t) =>
    t.takedowns.map((site) => ({
      url: site.url,
      host: site.host,
      reason: site.note,
      repoUrl: `https://github.com/${site.repo}`,
      repoCreatedAt: site.repoCreatedAt,
      source: site.source,
    })),
  ),
  canary: { offline: offlineCanary, live: liveCanary },
  canaryCaught: offlineCanary === 'caught' && liveCanary !== 'missed',
  elapsedSec: Math.round((Date.now() - startedAt) / 10) / 100,
  output: basename(queue.path),
};
const summaryPath = queue.writeSummary(summary);

for (const record of [...queue.records].sort((a, b) => b.confidence - a.confidence)) {
  log.site(log.MAIN, record.label, 'pass', `${record.confidence.toFixed(2)} ${record.category} — ${record.reasons[0] ?? ''}`);
}
log.info(log.MAIN, `summary → ${basename(summaryPath)}`);
console.log(JSON.stringify(summary, null, 2));

// Two questions, two answers. The offline canary says whether we can still
// recognise a drainer; the live one says whether we can still reach any. Only a
// genuine failure of either goes red — a provider refusing to talk to us is a
// coverage gap to report, not evidence that the scanner is broken.
if (offlineCanary === 'caught') {
  log.info(log.MAIN, 'offline canary CAUGHT — extraction, rules and triage are sound');
} else {
  log.error(log.MAIN, 'offline canary MISSED — the classifier no longer recognises a textbook drainer');
  console.log('::error title=offline canary missed::classification is broken; treat this run as unreliable');
  process.exitCode = 1;
}

if (liveCanary === 'caught') {
  log.info(log.MAIN, 'live canary CAUGHT — acquisition is sound end to end');
} else if (liveCanary === 'missed') {
  log.error(log.MAIN, 'live canary MISSED — it was reachable and we failed to flag it');
  console.log('::error title=live canary missed::a reachable known-bad site was not flagged');
  process.exitCode = 1;
} else if (liveCanary === 'gone') {
  log.warn(log.MAIN, `live canaries are gone (${canaryOutcomes.join(', ')}) — taken down, so pick new ones`);
  console.log('::warning title=canaries gone::every known-bad canary is down; replace CANARY_URLS');
} else {
  log.warn(log.MAIN, 'live canary UNREACHABLE — its provider blocked us, so this run has no coverage there');
  console.log('::warning title=live canary unreachable::provider blocked; coverage gap, not a broken pipeline');
}

/** Extraction, rules and triage over a synthetic page. No network involved. */
async function runOfflineCanary(): Promise<'caught' | 'missed'> {
  const site: LiveSite = {
    url: 'offline://canary',
    host: 'offline-canary',
    label: 'offline-canary',
    source: 'canary',
    repo: 'CANARY/offline',
    repoCreatedAt: new Date().toISOString(),
    status: 200,
    server: 'offline',
    note: '',
    html: OFFLINE_CANARY_HTML,
  };
  const dossier = await buildDossier(site, log.MAIN);
  if (!dossier) return 'missed';
  const classification = classify(dossier);
  if (!classification.lanes.length) {
    log.warn(log.MAIN, `offline canary scored ${classification.score} and reached no lane`);
    return 'missed';
  }
  const verdict = await llm.triage(render(dossier, classification), dossier.source, 'offline-canary', log.MAIN);
  log.site(
    log.MAIN,
    'offline-canary',
    'llm',
    `${verdict.verdict.toUpperCase()} conf=${verdict.confidence.toFixed(2)} score=${classification.score} signals=${Object.keys(classification.hits).join(',')}`,
  );
  return llm.passes(verdict) ? 'caught' : 'missed';
}

/**
 * Stages 3 through 6 for one provider class, one site at a time.
 *
 * A worker carries a single candidate the whole way — probe, dossier, rules,
 * LLM, queue — instead of the run advancing stage by stage over everything.
 * Three reasons, all of them things the staged version got wrong:
 *
 * Priority reaches the end. The queue is ordered by lure strength, but with a
 * barrier at every stage that only reordered *probing*; the best name still
 * waited for the worst one to be probed before it could be looked at. Now the
 * first verdict lands in seconds.
 *
 * A killed run keeps its findings. Records append as they are confirmed, so a
 * cancelled or timed-out run leaves everything it had actually established
 * rather than losing it behind two unfinished stages.
 *
 * And nothing accumulates. Holding every dossier at once is what forced a
 * corpus cap and manual freeing; per-site, each one is garbage as soon as its
 * verdict is in.
 *
 * The LLM gets its own semaphore because it is the one stage that must stay
 * slow while the workers stay wide.
 */
async function runTrack(
  name: string,
  trackCandidates: Candidate[],
  workers: number,
): Promise<TrackResult> {
  const began = Date.now();
  const takedowns: LiveSite[] = [];
  const statuses = new Map<string, number>();
  const counts = { live: 0, dossiers: 0, hostnameLane: 0, contentLane: 0, triaged: 0, confirmed: 0 };
  const canaryOutcomes: string[] = [];
  const triageGate = semaphore(LLM_CONCURRENCY);
  let done = 0;

  const tally = () =>
    [...statuses]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([key, n]) => `${key}:${n}`)
      .join(' ');

  log.stage(name, 3, 'site pipeline', `${trackCandidates.length} candidates, ${workers} workers`);

  await pool(trackCandidates, workers, async (candidate) => {
    try {
      // ── 3 ── liveness, and the page while we are there ────────────────────
      const outcome = await probeSite(candidate, name);
      statuses.set(outcome.statusKey, (statuses.get(outcome.statusKey) ?? 0) + 1);
      if (candidate.source === 'canary') {
        canaryOutcomes.push(outcome.statusKey === 'err-provider-blocked' ? 'blocked' : outcome.kind);
      }
      if (outcome.kind === 'takedown') takedowns.push(outcome.site);
      if (outcome.kind !== 'live') return;
      counts.live++;

      // ── 4 ── the dossier both classifiers will read ───────────────────────
      const dossier = await buildDossier(outcome.site, name);
      outcome.site.html = '';
      if (!dossier) return;
      counts.dossiers++;

      // ── 5 ── detection: hostname lane | content lane ──────────────────────
      const classification = classify(dossier);
      const signals =
        Object.entries(classification.hits)
          .map(([hit, found]) => `${hit}(${found.length})`)
          .join(' ') || 'none';
      log.site(
        name,
        dossier.site.label,
        'rules',
        `score=${classification.score} lanes=${classification.lanes.join('+') || '-'} ${signals}`,
      );
      if (classification.lanes.includes('hostname')) counts.hostnameLane++;
      if (classification.lanes.includes('content')) counts.contentLane++;
      if (!classification.lanes.length) return;
      counts.triaged++;

      // ── 6 ── LLM triage on that same dossier ──────────────────────────────
      const label = dossier.site.label;
      const text = render(dossier, classification);
      log.block(name, label, 'dossier', text);

      const verdict = await triageGate(() => llm.triage(text, dossier.source, label, name));
      log.site(
        name,
        label,
        'llm',
        `${verdict.verdict.toUpperCase()} conf=${verdict.confidence.toFixed(2)} ` +
          `category=${verdict.category} brand=${verdict.brand ?? '-'}`,
      );
      for (const reason of verdict.reasons) log.block(name, label, 'llm', `reason: ${reason}`);
      for (const ioc of verdict.iocs) log.block(name, label, 'llm', `ioc: ${ioc}`);

      if (!llm.passes(verdict)) {
        log.site(name, label, 'drop', `below the queue bar (needs malicious >= ${LLM_MIN_CONFIDENCE})`);
        return;
      }

      // ── 7 ── straight to the analyst queue, on disk, now ──────────────────
      // urlscan goes first, and it is the one place this pipeline makes a
      // finding wait on the network before writing it down. The capture URL is
      // a field on the record, and the record file is append-only — rewriting a
      // line later to add it would break the one property everything
      // downstream relies on. Bounded at ~30s by SUBMIT_TIMEOUT_MS, and
      // submit.toUrlscan cannot throw, so the worst case is a slower append
      // with a null link, never a lost finding.
      counts.confirmed++;
      const urlscan = await submit.toUrlscan(dossier.site, verdict.category, name);
      const record = queue.add({ dossier, classification, llm: verdict }, urlscan);
      log.site(name, label, 'pass', `-> ${basename(queue.path)}  ${record.category} (${record.brand ?? 'no brand'})`);

      // ── 8 ── announce, vercel track only ──────────────────────────────────
      await submit.toDiscord(record, name);
    } finally {
      if (++done % 500 === 0) {
        log.info(name, `${done}/${trackCandidates.length} — ${tally()} | live:${counts.live} triaged:${counts.triaged} confirmed:${counts.confirmed}`);
      }
    }
  });

  log.info(name, `${done}/${trackCandidates.length} — ${tally()}`);
  for (const site of takedowns) {
    log.site(name, site.label, 'takedown', `${site.note || '451'}  github.com/${site.repo}  created=${site.repoCreatedAt}  via ${site.source} path`);
  }
  log.flow(name, 'live URLs', counts.live, `${((counts.live / Math.max(trackCandidates.length, 1)) * 100).toFixed(1)}% of candidates`);
  log.flow(name, 'dossiers', counts.dossiers, 'one evidence doc per live site');
  log.flow(name, 'to triage', counts.triaged, `hostname ${counts.hostnameLane} | content ${counts.contentLane}`);
  log.flow(name, 'confirmed', counts.confirmed, 'analyst queue');

  return {
    name,
    candidates: trackCandidates.length,
    live: counts.live,
    takedowns,
    probeStatuses: Object.fromEntries(statuses),
    dossiers: counts.dossiers,
    hostnameLane: counts.hostnameLane,
    contentLane: counts.contentLane,
    triaged: counts.triaged,
    confirmed: counts.confirmed,
    canaryOutcomes,
    elapsedSec: Math.round((Date.now() - began) / 10) / 100,
  };
}
