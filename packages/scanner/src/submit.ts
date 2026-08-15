/**
 * Stage 8 — handoff.
 *
 * Everything before this produces a file nobody has read yet. This stage puts
 * each confirmed URL somewhere a human or another system will actually trip
 * over it, and it does so per finding rather than in a batch at the end, for
 * the same reason the analyst queue appends per finding: a run that dies at 80%
 * has still handed off 80% of what it found.
 *
 * Two sinks, because the two tracks are worth different things:
 *
 *   urlscan.io   Every confirmed URL, both tracks. It captures the page,
 *                screenshots it and resolves the whole request chain, which is
 *                the one thing the JSONL cannot provide: by the time anyone
 *                reads a line here the site is usually gone, and a line saying
 *                a page asked for a seed phrase is not evidence that it did.
 *                Public visibility on purpose — see URLSCAN_VISIBILITY.
 *
 *   discord      The vercel track only. Vercel rations us to a few dozen
 *                requests a run, so a vercel confirmation is a lead bought with
 *                the entire budget for that provider and is worth interrupting
 *                someone for. The open track's two dozen a run go to the queue
 *                and the site, where they are read on purpose rather than
 *                pushed; routing them here would bury the two that matter.
 *
 * Nothing here deduplicates against previous runs. Resubmitting is not waste:
 * these pages are edited under their operators and taken down without notice,
 * so a second capture of the same URL is a second dated observation of a
 * changing thing, and urlscan's quota is measured in thousands a day against
 * our couple of dozen a run.
 *
 * Nothing here can fail a finding either. Both calls swallow everything and
 * return — a handoff is a copy of the record, and losing a copy must never cost
 * the original.
 */
import {
  SUBMIT_CONCURRENCY,
  SUBMIT_TIMEOUT_MS,
  URLSCAN_ENDPOINT,
  URLSCAN_TAGS,
  URLSCAN_VISIBILITY,
} from './config.ts';
import { request } from './http.ts';
import * as log from './log.ts';
import type { QueueRecord } from './output.ts';
import type { LiveSite } from './types.ts';
import { decode, semaphore } from './util.ts';

const URLSCAN_KEY = process.env.URLSCAN_KEY ?? '';
const DISCORD_WEBHOOK = process.env.VERCEL_WEBHOOK ?? '';

/**
 * One gate for both sinks. They are unrelated services, but the thing being
 * limited is how many workers are parked in a handoff rather than probing.
 */
const gate = semaphore(SUBMIT_CONCURRENCY);

const counts = { urlscan: 0, urlscanFailed: 0, discord: 0, discordFailed: 0, skippedCanary: 0 };

/** For the run summary — a handoff that silently did nothing is the failure mode. */
export function stats(): Record<string, unknown> {
  return {
    ...counts,
    urlscanEnabled: Boolean(URLSCAN_KEY),
    discordEnabled: Boolean(DISCORD_WEBHOOK),
  };
}

/**
 * Say up front which sinks are live.
 *
 * Both are optional: a scan with neither key set is still a valid scan, so this
 * warns rather than exits the way requireToken and llm.requireKey do. But it
 * has to say so at the top of the log, because the alternative is finding out
 * an hour later that a run's findings went nowhere.
 */
export function announceSinks(): void {
  log.info(
    log.MAIN,
    URLSCAN_KEY
      ? `urlscan handoff on (${URLSCAN_VISIBILITY}, tags ${URLSCAN_TAGS.join('+')})`
      : 'urlscan handoff OFF — set URLSCAN_KEY to submit confirmed URLs',
  );
  log.info(
    log.MAIN,
    DISCORD_WEBHOOK
      ? 'discord handoff on for the vercel track'
      : 'discord handoff OFF — set VERCEL_WEBHOOK to announce vercel findings',
  );
}

/**
 * Submit one confirmed URL and return its permanent result page, or null.
 *
 * Takes the site rather than the queue record because it runs *before* the
 * record exists: the result URL is a field on it, and a record that has to be
 * rewritten later is not the append-only file the rest of this depends on.
 *
 * Canaries are skipped. They are two fixed known-bad URLs injected every run to
 * prove acquisition still works, so submitting them is 24 identical captures a
 * day of pages urlscan has seen from us dozens of times.
 */
export async function toUrlscan(
  site: LiveSite,
  category: string,
  track: string,
): Promise<string | null> {
  if (!URLSCAN_KEY) return null;
  if (site.source === 'canary') {
    counts.skippedCanary++;
    return null;
  }

  return gate(async () => {
    const res = await request(URLSCAN_ENDPOINT, {
      method: 'POST',
      tries: 2,
      timeoutMs: SUBMIT_TIMEOUT_MS,
      redirect: 'follow',
      headers: { 'api-key': URLSCAN_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        url: site.url,
        visibility: URLSCAN_VISIBILITY,
        tags: [...URLSCAN_TAGS, category],
      }),
    });

    if (res.status !== 200) {
      counts.urlscanFailed++;
      // 400 is routine and not a bug — urlscan refuses domains on its own
      // blacklist and URLs whose DNS no longer resolves, and a drainer host
      // going dark between our probe and our submission is the normal case.
      // Its own message says which, so print it rather than the status alone.
      const detail = res.error ?? messageOf(res.body) ?? '';
      const reset = res.headers.get('x-rate-limit-reset-after');
      log.site(
        track,
        site.label,
        'warn',
        `urlscan ${res.status} ${detail}${res.status === 429 && reset ? ` (resets in ${reset}s)` : ''}`.trim(),
      );
      return null;
    }

    // Every response carries the quota. Watch it rather than the count of
    // submissions: the limit is per key across every window urlscan defines,
    // not per run, and the failure it prevents is a run that hits the ceiling
    // partway and silently stops recording captures for the rest of its
    // findings. Only shout when it is nearly gone — 26 confirmations a run
    // against a four-figure daily allowance means this is normally silent.
    const remaining = Number(res.headers.get('x-rate-limit-remaining'));
    if (Number.isFinite(remaining) && remaining <= 10) {
      log.warn(
        track,
        `urlscan quota nearly spent: ${remaining} left in this ` +
          `${res.headers.get('x-rate-limit-window') ?? 'window'}, ` +
          `resets in ${res.headers.get('x-rate-limit-reset-after') ?? '?'}s`,
      );
    }

    const result = fieldOf(res.body, 'result');
    counts.urlscan++;
    log.site(track, site.label, 'submit', `urlscan → ${result ?? 'accepted'}`);
    return result;
  });
}

/**
 * Announce one vercel-track finding. No-ops for every other track.
 *
 * The check is on the track rather than the hostname because the track *is* the
 * provider split — main.ts partitions candidates by pace.isPaced and runs the
 * two populations as separate lanes, so anything that wants "the vercel ones"
 * is asking about the lane, not about a string in a URL.
 */
export async function toDiscord(record: QueueRecord, track: string): Promise<void> {
  if (!DISCORD_WEBHOOK || track !== 'vercel') return;
  if (record.source === 'canary') {
    counts.skippedCanary++;
    return;
  }

  await gate(async () => {
    const res = await request(DISCORD_WEBHOOK, {
      method: 'POST',
      tries: 2,
      timeoutMs: SUBMIT_TIMEOUT_MS,
      redirect: 'follow',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(embedFor(record)),
    });

    // Webhooks answer 204 with no body.
    if (res.status !== 204 && res.status !== 200) {
      counts.discordFailed++;
      log.site(track, record.label, 'warn', `discord ${res.status} ${res.error ?? ''}`.trim());
      return;
    }
    counts.discord++;
    log.site(track, record.label, 'submit', 'discord → announced');
  });
}

/**
 * The live URL is deliberately not the embed's link.
 *
 * Discord makes an embed title clickable and prefetches it for a preview, and
 * the one thing this message must not do is put a live drainer one mis-click
 * away in a chat window. So the title points at the urlscan capture — which is
 * the evidence anyone reading this actually wants first — and the URL itself
 * sits in a code span: copyable, greppable, inert.
 */
function embedFor(record: QueueRecord) {
  const fields = [
    { name: 'url', value: `\`${cap(record.url, 1000)}\`` },
    { name: 'category', value: record.category, inline: true },
    { name: 'confidence', value: record.confidence.toFixed(2), inline: true },
    { name: 'brand', value: record.brand ?? '—', inline: true },
    { name: 'repo', value: `[${record.repo}](${record.repoUrl}) · created ${record.repoCreatedAt}` },
  ];
  if (record.iocs.length) {
    fields.push({ name: 'iocs', value: cap(record.iocs.map((i) => `\`${i}\``).join('\n'), 1000) });
  }

  return {
    username: 'no place for drainers',
    // Everything below — the title, the reasons, the IOCs — is derived from a
    // page written by the person under investigation, by way of a model that
    // was asked to quote it. A page titled "@everyone" must not ping a server.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: cap(record.label, 250),
        url: record.urlscan ?? undefined,
        color: 0xdc2626,
        description: cap(record.reasons.map((r) => `• ${r}`).join('\n'), 3000),
        fields,
        footer: { text: `${record.title || 'no title'} · ${record.source} path` },
        timestamp: record.seen,
      },
    ],
  };
}

function cap(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** One string field out of a JSON body we do not otherwise care about. */
function fieldOf(body: Uint8Array, key: string): string | null {
  try {
    const value = JSON.parse(decode(body))?.[key];
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

function messageOf(body: Uint8Array): string | null {
  return fieldOf(body, 'message') ?? fieldOf(body, 'description');
}
