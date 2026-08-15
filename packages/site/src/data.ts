/**
 * The site is a view over `out/`, nothing more. Every JSONL line the scanner
 * has ever appended is a page here, and the directory's git history is the
 * record — this file just reads it back at build time.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The build always runs from packages/site (`pnpm --filter site build`).
const OUT = resolve(process.cwd(), '../../out');

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

export type Takedown = {
  url: string;
  host: string;
  reason: string;
  repoUrl: string;
  repoCreatedAt: string;
  source: string;
};

export type Summary = {
  generated: string;
  windowHours: number;
  cutoff: string;
  repos: number;
  candidates: number;
  candidatesByName: number;
  candidatesByHomepage: number;
  live: number;
  takedowns: Takedown[];
  dossiers: number;
  hostnameLane: number;
  contentLane: number;
  triaged: number;
  confirmed: number;
  canaryCaught: boolean;
  elapsedSec: number;
  output: string;
};

export type Run = { date: string; summary: Summary; records: QueueRecord[] };

/** One entry per host, carrying every time we have seen it confirmed. */
export type Site = {
  host: string;
  latest: QueueRecord;
  firstSeen: string;
  lastSeen: string;
  seenOn: string[];
};

function readJsonl(path: string): QueueRecord[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as QueueRecord);
}

/** Newest run first. */
export function loadRuns(): Run[] {
  if (!existsSync(OUT)) return [];
  const dates = readdirSync(OUT)
    .map((name) => /^summary-(\d{4}-\d{2}-\d{2})\.json$/.exec(name)?.[1])
    .filter((date): date is string => Boolean(date))
    .sort()
    .reverse();

  return dates.map((date) => {
    const queue = join(OUT, `drainers-${date}.jsonl`);
    return {
      date,
      summary: JSON.parse(readFileSync(join(OUT, `summary-${date}.json`), 'utf8')) as Summary,
      records: existsSync(queue) ? readJsonl(queue) : [],
    };
  });
}

/**
 * The same site can be confirmed on several runs — one canary certainly will
 * be. Collapse to one entry per host, newest verdict wins, but keep the dates
 * so the page can show how long it has been standing.
 */
export function loadSites(runs: Run[]): Site[] {
  const byHost = new Map<string, Site>();

  for (const run of [...runs].reverse()) {
    for (const record of run.records) {
      const existing = byHost.get(record.host);
      if (existing) {
        existing.latest = record;
        existing.lastSeen = run.date;
        existing.seenOn.push(run.date);
      } else {
        byHost.set(record.host, {
          host: record.host,
          latest: record,
          firstSeen: run.date,
          lastSeen: run.date,
          seenOn: [run.date],
        });
      }
    }
  }

  return [...byHost.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

const BASE = import.meta.env.BASE_URL;

/** Join a path onto the Pages base without doubling the slash. */
export function href(path: string): string {
  return `${BASE.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

export function shortDate(iso: string): string {
  return iso.slice(0, 10);
}
