/**
 * Stage 7 — the analyst queue.
 *
 * The console log is the detailed record. This file is the opposite: one line
 * per confirmed site, only the fields a human or a downstream submitter
 * (urlscan, a report form, a Pages build) actually needs. Records are appended
 * as they are confirmed, so a run that dies halfway still leaves its findings.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT_DIR, RECORD_DIRS } from './config.ts';
import type { Finding } from './types.ts';
import { runStamp } from './util.ts';

export type QueueRecord = {
  seen: string;
  url: string;
  /**
   * The urlscan.io capture of this URL, submitted at the moment it was
   * confirmed. Null when the handoff is off or urlscan refused the URL.
   *
   * This is the only field here that outlives its subject. Everything else
   * describes a page that is typically gone within days — taken down, or
   * rewritten by its operator — and a line asserting that a page asked for a
   * seed phrase is not evidence that it did. The capture is.
   */
  urlscan: string | null;
  host: string;
  label: string;
  repo: string;
  repoUrl: string;
  repoCreatedAt: string;
  source: string;
  httpStatus: number;
  title: string;
  ruleScore: number;
  ruleSignals: string[];
  lanes: string[];
  verdict: string;
  confidence: number;
  category: string;
  brand: string | null;
  reasons: string[];
  iocs: string[];
  outboundHosts: string[];
};

export class AnalystQueue {
  readonly path: string;
  readonly stamp: string;
  readonly records: QueueRecord[] = [];

  /**
   * Named per run, not per date.
   *
   * These files used to be `drainers-<date>.jsonl`, truncated on construction.
   * That quietly destroyed data twice over: a run that started and died wiped
   * the previous run's findings before producing any of its own — which is
   * exactly what happened when a cancelled run committed a 1-record file back
   * as empty, with a commit message quoting the *previous* run's summary. And
   * at three runs a day, two of every three summaries were overwritten before
   * anyone read them.
   *
   * A run's output is immutable once written. Nothing else can be true of a
   * directory whose git history is supposed to be the record.
   */
  constructor(stamp = runStamp()) {
    this.stamp = stamp;
    mkdirSync(OUT_DIR, { recursive: true });
    this.path = join(OUT_DIR, `drainers-${this.stamp}.jsonl`);
    writeFileSync(this.path, '');
  }

  add(finding: Finding, urlscan: string | null = null): QueueRecord {
    const { dossier, classification, llm } = finding;
    const record: QueueRecord = {
      seen: new Date().toISOString(),
      url: dossier.site.url,
      urlscan,
      host: dossier.site.host,
      label: dossier.site.label,
      repo: dossier.site.repo,
      repoUrl: `https://github.com/${dossier.site.repo}`,
      repoCreatedAt: dossier.site.repoCreatedAt,
      source: dossier.site.source,
      httpStatus: dossier.site.status,
      title: dossier.title,
      ruleScore: classification.score,
      ruleSignals: Object.keys(classification.hits).sort(),
      lanes: classification.lanes,
      verdict: llm.verdict,
      confidence: llm.confidence,
      category: llm.category,
      brand: llm.brand,
      reasons: llm.reasons,
      iocs: llm.iocs,
      outboundHosts: dossier.hosts.slice(0, 20),
    };
    this.records.push(record);
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    return record;
  }

  /**
   * Every label any previous run has already written down.
   *
   * Read from the files rather than kept in a state file, because the JSONL
   * *is* the state — it is committed, it is append-only, and a separate index
   * would be a second source of truth that can drift from it.
   *
   * Both directories count. out-archive/ is where records are moved to hide
   * them from the site, which says nothing about whether we announced them:
   * the question here is "have we told anyone about this host before", and a
   * record that was published and later hidden was still published.
   *
   * Unparseable lines are skipped rather than thrown on. A malformed line in a
   * two-week-old file must not be able to stop today's run.
   */
  static previouslyRecorded(): Set<string> {
    const labels = new Set<string>();
    for (const dir of RECORD_DIRS) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue; // out-archive/ need not exist
      }
      for (const file of entries) {
        if (!file.startsWith('drainers-') || !file.endsWith('.jsonl')) continue;
        for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
          if (!line) continue;
          try {
            const label = JSON.parse(line).label;
            if (typeof label === 'string') labels.add(label);
          } catch {
            // skip
          }
        }
      }
    }
    return labels;
  }

  writeSummary(summary: Record<string, unknown>): string {
    const path = join(OUT_DIR, `summary-${this.stamp}.json`);
    writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
    return path;
  }
}
