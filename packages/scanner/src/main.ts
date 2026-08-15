/**
 * no place for drainers
 * ─────────────────────
 * Find wallet drainers and credential phishing on free hosts, hours after they
 * are deployed, by walking the one place their operators leave a paper trail:
 * the public GitHub repo they pushed to get the deployment in the first place.
 *
 *   1  /repositories walk ......... every new public repo, id-sharded
 *   2  two paths to a URL ......... repo name → guessed host | homepage field
 *   3  probe liveness ............. HEAD both paths, keep the deduped union
 *   4  dossier .................... one evidence doc per live site
 *   5  detection .................. hostname lane | content-rule lane
 *   6  LLM triage ................. the same dossier, a second opinion
 *   7  analyst queue .............. dated JSONL of what survived
 *
 * Stages 5 and 6 read the identical dossier built in stage 4, which is what
 * makes their disagreements meaningful instead of an artifact of what each one
 * happened to be shown.
 */
import { basename } from 'node:path';
import { buildCandidates } from './candidates.ts';
import { CANARY_URLS, LLM_CONCURRENCY, LLM_MIN_CONFIDENCE, WINDOW_HOURS } from './config.ts';
import { classify } from './detect.ts';
import { buildDossiers, render } from './dossier.ts';
import { requireToken, walkNewRepos } from './github.ts';
import * as llm from './llm.ts';
import * as log from './log.ts';
import { AnalystQueue } from './output.ts';
import { probeLiveness } from './probe.ts';
import type { Candidate, Finding } from './types.ts';
import { hostOf, pool } from './util.ts';

const startedAt = Date.now();

requireToken();
llm.requireKey();
const queue = new AnalystQueue();
log.info(`analyst queue → ${queue.path}`);

// ── stage 1 ── /repositories walk ───────────────────────────────────────────
log.stage(1, '/repositories walk', `every new public repo in the last ${WINDOW_HOURS}h`);
const { repos, cutoff } = await walkNewRepos();
log.flow('repos', repos.length, 'hydrated with homepage + createdAt');

// ── stage 2 ── name path + homepage path ────────────────────────────────────
log.stage(2, 'candidate URLs', 'repo name → guessed host | homepage field → free hosts');
const candidates: Candidate[] = buildCandidates(repos);
for (const url of CANARY_URLS) {
  candidates.push({
    url,
    host: hostOf(url),
    source: 'canary',
    repo: 'CANARY/known-bad',
    repoCreatedAt: new Date().toISOString(),
  });
}
const bySource = (s: string) => candidates.filter((c) => c.source === s).length;
log.flow('name path', bySource('guess'), 'guessed deployments');
log.flow('homepage path', bySource('homepage'), 'exact free-host URLs');
log.flow('candidates', candidates.length, `deduped (+${CANARY_URLS.length} canary)`);

// ── stage 3 ── probe liveness, both paths ───────────────────────────────────
log.stage(3, 'probe liveness', 'HEAD, deduped union of both paths');
const { live, takedowns } = await probeLiveness(candidates);
log.flow('live URLs', live.length, `${((live.length / candidates.length) * 100).toFixed(1)}% of candidates`);
log.flow('already taken down', takedowns.length, 'http 451 — someone got there first');
// 451s never reach the dossier stage, so this is the only place they get named.
// They are the most interesting dead URLs we have: a host already agreed they
// were abusive, and the repo behind each one is still sitting there.
for (const site of takedowns) {
  log.site(site.host, 'takedown', `${site.note || '451'}  github.com/${site.repo}  created=${site.repoCreatedAt}  via ${site.source} path`);
}

// ── stage 4 ── dossier per live site ────────────────────────────────────────
log.stage(4, 'dossier', 'fetch page, follow SPA bundles, extract the signal surface');
const dossiers = await buildDossiers(live);
log.flow('dossiers', dossiers.length, 'one evidence doc per live site');

// ── stage 5 ── detection: hostname lane | content lane ──────────────────────
log.stage(5, 'detection', 'hostname keyword lane | content rule lane');
const scored = dossiers.map((dossier) => ({ dossier, classification: classify(dossier) }));
for (const { dossier, classification } of scored) {
  const signals =
    Object.entries(classification.hits)
      .map(([name, found]) => `${name}(${found.length})`)
      .join(' ') || 'none';
  log.site(
    dossier.site.host,
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
log.flow('hostname lane', scored.filter((s) => s.classification.lanes.includes('hostname')).length, 'priority');
log.flow('content lane', scored.filter((s) => s.classification.lanes.includes('content')).length, 'over rule threshold');
log.flow('to triage', triageQueue.length, 'union of both lanes');

// ── stage 6 ── LLM triage on the same dossier ───────────────────────────────
log.stage(6, 'LLM triage', 'second opinion on the identical dossier');
const findings: Finding[] = [];

await pool(triageQueue, LLM_CONCURRENCY, async ({ dossier, classification }) => {
  const host = dossier.site.host;
  const text = render(dossier, classification);
  log.block(host, 'dossier', text);

  const verdict = await llm.triage(text);
  log.site(
    host,
    'llm',
    `${verdict.verdict.toUpperCase()} conf=${verdict.confidence.toFixed(2)} ` +
      `category=${verdict.category} brand=${verdict.brand ?? '-'}`,
  );
  for (const reason of verdict.reasons) log.block(host, 'llm', `reason: ${reason}`);
  for (const ioc of verdict.iocs) log.block(host, 'llm', `ioc: ${ioc}`);

  if (!llm.passes(verdict)) {
    log.site(host, 'drop', `below the queue bar (needs malicious ≥ ${LLM_MIN_CONFIDENCE})`);
    return;
  }
  const finding: Finding = { dossier, classification, llm: verdict };
  findings.push(finding);
  const record = queue.add(finding);
  log.site(host, 'pass', `→ ${queue.path}  ${record.category} (${record.brand ?? 'no brand'})`);
});

log.flow('confirmed', findings.length, 'analyst queue');

// ── stage 7 ── summary ──────────────────────────────────────────────────────
log.stage(7, 'analyst queue', queue.path);
const canaryCaught = findings.some((f) => f.dossier.site.source === 'canary');
const summary = {
  generated: new Date().toISOString(),
  windowHours: WINDOW_HOURS,
  cutoff,
  repos: repos.length,
  candidates: candidates.length,
  candidatesByName: bySource('guess'),
  candidatesByHomepage: bySource('homepage'),
  live: live.length,
  takedowns: takedowns.map((site) => ({
    url: site.url,
    host: site.host,
    reason: site.note,
    repoUrl: `https://github.com/${site.repo}`,
    repoCreatedAt: site.repoCreatedAt,
    source: site.source,
  })),
  dossiers: dossiers.length,
  hostnameLane: scored.filter((s) => s.classification.lanes.includes('hostname')).length,
  contentLane: scored.filter((s) => s.classification.lanes.includes('content')).length,
  triaged: triageQueue.length,
  confirmed: findings.length,
  canaryCaught,
  elapsedSec: Math.round((Date.now() - startedAt) / 10) / 100,
  output: basename(queue.path),
};
const summaryPath = queue.writeSummary(summary);

for (const record of [...queue.records].sort((a, b) => b.confidence - a.confidence)) {
  log.site(record.host, 'pass', `${record.confidence.toFixed(2)} ${record.category} — ${record.reasons[0] ?? ''}`);
}
log.info(`canary ${canaryCaught ? 'CAUGHT — pipeline is sound' : 'MISSED — check the pipeline'}`);
log.info(`summary → ${summaryPath}`);
console.log(JSON.stringify(summary, null, 2));
