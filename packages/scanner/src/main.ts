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
  FETCH_CONCURRENCY,
  LLM_CONCURRENCY,
  LLM_MIN_CONFIDENCE,
  PACED_CONCURRENCY,
  PROBE_CONCURRENCY,
  WINDOW_HOURS,
} from './config.ts';
import { classify } from './detect.ts';
import { buildDossiers, render } from './dossier.ts';
import { requireToken, walkNewRepos } from './github.ts';
import * as llm from './llm.ts';
import * as log from './log.ts';
import { AnalystQueue } from './output.ts';
import { isPaced } from './pace.ts';
import * as pace from './pace.ts';
import { probeLiveness } from './probe.ts';
import type { Candidate, Finding, LiveSite } from './types.ts';
import { hostOf, partition, pool } from './util.ts';

const startedAt = Date.now();

requireToken();
llm.requireKey();
const queue = new AnalystQueue();
log.info(log.MAIN, `analyst queue → ${basename(queue.path)}`);

// ── stage 1 ── /repositories walk ───────────────────────────────────────────
log.stage(log.MAIN, 1, '/repositories walk', `every new public repo in the last ${WINDOW_HOURS}h`);
const { repos, cutoff } = await walkNewRepos();
log.flow(log.MAIN, 'repos', repos.length, 'hydrated with homepage + createdAt');

// ── stage 2 ── name path + homepage path ────────────────────────────────────
log.stage(log.MAIN, 2, 'candidate URLs', 'repo name → guessed host | homepage field → free hosts');
const candidates: Candidate[] = buildCandidates(repos);
for (const url of CANARY_URLS) {
  candidates.push({
    url,
    host: hostOf(url),
    label: hostOf(url),
    source: 'canary',
    repo: 'CANARY/known-bad',
    repoCreatedAt: new Date().toISOString(),
  });
}
const bySource = (s: string) => candidates.filter((c) => c.source === s).length;
log.flow(log.MAIN, 'name path', bySource('guess'), 'guessed deployments');
log.flow(log.MAIN, 'homepage path', bySource('homepage'), 'exact free-host URLs');
log.flow(log.MAIN, 'candidates', candidates.length, `deduped (+${CANARY_URLS.length} canary)`);

// ── split ── one track per provider class, run to completion independently ──
const [pacedCandidates, freeCandidates] = partition(candidates, (c) => isPaced(c.url));
log.flow(log.MAIN, 'rate-limited providers', pacedCandidates.length, 'vercel track');
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
  elapsedSec: number;
};

const [vercelTrack, openTrack] = await Promise.all([
  runTrack('vercel', pacedCandidates, PACED_CONCURRENCY, PACED_CONCURRENCY),
  runTrack('open', freeCandidates, PROBE_CONCURRENCY, FETCH_CONCURRENCY),
]);
const tracks = [vercelTrack, openTrack];

// ── stage 7 ── summary ──────────────────────────────────────────────────────
log.stage(log.MAIN, 7, 'analyst queue', basename(queue.path));
const canaryCaught = queue.records.some((r) => r.source === 'canary');
const sum = (pick: (t: TrackResult) => number) => tracks.reduce((n, t) => n + pick(t), 0);

const summary = {
  generated: new Date().toISOString(),
  windowHours: WINDOW_HOURS,
  cutoff,
  repos: repos.length,
  candidates: candidates.length,
  candidatesByName: bySource('guess'),
  candidatesByHomepage: bySource('homepage'),
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
  canaryCaught,
  elapsedSec: Math.round((Date.now() - startedAt) / 10) / 100,
  output: basename(queue.path),
};
const summaryPath = queue.writeSummary(summary);

for (const record of [...queue.records].sort((a, b) => b.confidence - a.confidence)) {
  log.site(log.MAIN, record.label, 'pass', `${record.confidence.toFixed(2)} ${record.category} — ${record.reasons[0] ?? ''}`);
}
log.info(log.MAIN, `summary → ${basename(summaryPath)}`);
console.log(JSON.stringify(summary, null, 2));

// The canary is the only thing in here that knows the difference between "a
// quiet day on GitHub" and "the scanner has been silently broken for a week".
// A run that misses it has produced evidence, not results — commit it, publish
// it, and still go red.
if (canaryCaught) {
  log.info(log.MAIN, 'canary CAUGHT — pipeline is sound');
} else {
  log.error(log.MAIN, 'canary MISSED — this run found nothing because it is broken, not because there was nothing');
  console.log('::error title=canary missed::the pipeline did not flag a known-bad site; treat this run as unreliable');
  process.exitCode = 1;
}

/** Stages 3 through 6 for one provider class. Two of these run at once. */
async function runTrack(
  name: string,
  trackCandidates: Candidate[],
  probeConcurrency: number,
  fetchConcurrency: number,
): Promise<TrackResult> {
  const began = Date.now();
  const done = (extra: Partial<TrackResult> = {}): TrackResult => ({
    name,
    candidates: trackCandidates.length,
    live: 0,
    takedowns: [],
    probeStatuses: {},
    dossiers: 0,
    hostnameLane: 0,
    contentLane: 0,
    triaged: 0,
    confirmed: 0,
    elapsedSec: Math.round((Date.now() - began) / 10) / 100,
    ...extra,
  });

  if (!trackCandidates.length) return done();

  // ── stage 3 ── probe liveness ─────────────────────────────────────────────
  log.stage(name, 3, 'probe liveness', `one GET, keep the body (${trackCandidates.length} candidates)`);
  const { live, takedowns, statuses } = await probeLiveness(trackCandidates, probeConcurrency, name);
  log.flow(name, 'live URLs', live.length, `${((live.length / trackCandidates.length) * 100).toFixed(1)}% of candidates`);
  log.flow(name, 'already taken down', takedowns.length, 'http 451 — someone got there first');
  for (const site of takedowns) {
    log.site(name, site.label, 'takedown', `${site.note || '451'}  github.com/${site.repo}  created=${site.repoCreatedAt}  via ${site.source} path`);
  }

  // ── stage 4 ── dossier per live site ──────────────────────────────────────
  log.stage(name, 4, 'dossier', 'extract the signal surface, follow SPA bundles');
  const dossiers = await buildDossiers(live, fetchConcurrency, name);
  log.flow(name, 'dossiers', dossiers.length, 'one evidence doc per live site');

  // ── stage 5 ── detection: hostname lane | content lane ────────────────────
  log.stage(name, 5, 'detection', 'hostname keyword lane | content rule lane');
  const scored = dossiers.map((dossier) => ({ dossier, classification: classify(dossier) }));
  for (const { dossier, classification } of scored) {
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
  }
  const triageQueue = scored.filter((s) => s.classification.lanes.length > 0);
  // Both classifiers have now seen everything they are going to see, so the
  // corpus of anything that did not make the queue is dead weight — and at tens
  // of thousands of sites with JS bundles behind them, dead weight is the thing
  // that kills the run.
  for (const { dossier, classification } of scored) {
    if (!classification.lanes.length) dossier.corpus = '';
  }
  const hostnameLane = scored.filter((s) => s.classification.lanes.includes('hostname')).length;
  const contentLane = scored.filter((s) => s.classification.lanes.includes('content')).length;
  log.flow(name, 'hostname lane', hostnameLane, 'priority');
  log.flow(name, 'content lane', contentLane, 'over rule threshold');
  log.flow(name, 'to triage', triageQueue.length, 'union of both lanes');

  // ── stage 6 ── LLM triage on the same dossier ─────────────────────────────
  log.stage(name, 6, 'LLM triage', 'second opinion on the identical dossier');
  let confirmed = 0;

  await pool(triageQueue, LLM_CONCURRENCY, async ({ dossier, classification }) => {
    const host = dossier.site.label;
    const text = render(dossier, classification);
    log.block(name, host, 'dossier', text);

    const verdict = await llm.triage(text, host, name);
    log.site(
      name,
      host,
      'llm',
      `${verdict.verdict.toUpperCase()} conf=${verdict.confidence.toFixed(2)} ` +
        `category=${verdict.category} brand=${verdict.brand ?? '-'}`,
    );
    for (const reason of verdict.reasons) log.block(name, host, 'llm', `reason: ${reason}`);
    for (const ioc of verdict.iocs) log.block(name, host, 'llm', `ioc: ${ioc}`);

    if (!llm.passes(verdict)) {
      log.site(name, host, 'drop', `below the queue bar (needs malicious ≥ ${LLM_MIN_CONFIDENCE})`);
      return;
    }
    const finding: Finding = { dossier, classification, llm: verdict };
    confirmed++;
    const record = queue.add(finding);
    log.site(name, host, 'pass', `→ ${basename(queue.path)}  ${record.category} (${record.brand ?? 'no brand'})`);
  });

  log.flow(name, 'confirmed', confirmed, 'analyst queue');
  return done({
    live: live.length,
    takedowns,
    probeStatuses: statuses,
    dossiers: dossiers.length,
    hostnameLane,
    contentLane,
    triaged: triageQueue.length,
    confirmed,
  });
}
