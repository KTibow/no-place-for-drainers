/**
 * Stage 7 — the analyst queue.
 *
 * The console log is the detailed record. This file is the opposite: one line
 * per confirmed site, only the fields a human or a downstream submitter
 * (urlscan, a report form, a Pages build) actually needs. Records are appended
 * as they are confirmed, so a run that dies halfway still leaves its findings.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT_DIR } from './config.ts';
import type { Finding } from './types.ts';
import { isoDate } from './util.ts';

export type QueueRecord = {
  seen: string;
  url: string;
  host: string;
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
  readonly date: string;
  readonly records: QueueRecord[] = [];

  constructor(date = isoDate()) {
    this.date = date;
    mkdirSync(OUT_DIR, { recursive: true });
    this.path = join(OUT_DIR, `drainers-${this.date}.jsonl`);
    writeFileSync(this.path, '');
  }

  add(finding: Finding): QueueRecord {
    const { dossier, classification, llm } = finding;
    const record: QueueRecord = {
      seen: new Date().toISOString(),
      url: dossier.site.url,
      host: dossier.site.host,
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

  writeSummary(summary: Record<string, unknown>): string {
    const path = join(OUT_DIR, `summary-${this.date}.json`);
    writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
    return path;
  }
}
