/**
 * Stage 4 — one dossier per live site.
 *
 * This is the hinge of the whole pipeline. The dossier is built once, from the
 * page and (when the page is an empty SPA shell) from its JS bundles, and then
 * BOTH classifiers work from it: the rule engine scores `corpus`, and the LLM
 * reads `render()`. Neither gets to see evidence the other did not.
 */
import {
  BUNDLE_SOURCE_MAX_CHARS,
  DOSSIER_MAX_CHARS,
  LLM_SOURCE_MAX_CHARS,
  DOSSIER_MAX_EVIDENCE_LINES,
  FETCH_TIMEOUT_MS,
  MAX_BUNDLES,
  MAX_CORPUS_CHARS,
  SPA_SHELL_TEXT_BYTES,
} from './config.ts';
import { ANY_RULE } from './detect.ts';
import {
  bundlesIn,
  essence,
  fieldsOf,
  hostsIn,
  jsLiterals,
  metasOf,
  readableSource,
  stripTags,
  titleOf,
} from './extract.ts';
import { request } from './http.ts';
import * as log from './log.ts';
import type { Classification, Dossier, LiveSite } from './types.ts';
import { decode, kb } from './util.ts';

export async function buildDossier(site: LiveSite, track: string): Promise<Dossier | null> {
  // The page already arrived with the liveness probe; only bundles cost a
  // request from here.
  const html = site.html;
  if (!html) {
    log.site(track, site.label, 'drop', `live at ${site.status} but returned no body`);
    return null;
  }

  const visible = stripTags(html);
  const pageCorpus = essence(html);
  let bundleCorpus = '';
  let bundleSource = '';
  let corpus = pageCorpus;
  let jsBytes = 0;
  const bundles: string[] = [];

  // An SPA shell says nothing; the bundle behind it says everything.
  if (visible.length < SPA_SHELL_TEXT_BYTES) {
    for (const url of bundlesIn(html, site.url).slice(0, MAX_BUNDLES)) {
      if (corpus.length >= MAX_CORPUS_CHARS) break;
      const bundle = await request(url, { tries: 1, timeoutMs: FETCH_TIMEOUT_MS, redirect: 'follow' });
      if (!bundle.body.length) continue;
      jsBytes += bundle.body.length;
      bundles.push(url);
      // Scan the FULL literal set of each bundle: truncating per-bundle fills
      // the budget with framework internals before reaching the app's own copy.
      const js = decode(bundle.body);
      // Small enough to read? Show the code. Literals are a fallback for
      // bundles too large to be anything but library output.
      if (js.length <= BUNDLE_SOURCE_MAX_CHARS && bundleSource.length < LLM_SOURCE_MAX_CHARS) {
        bundleSource += `\n\n/* ---- ${url} (${js.length}b) ---- */\n${js}`;
      }
      bundleCorpus = `${bundleCorpus}\n${jsLiterals(js)}`.slice(0, MAX_CORPUS_CHARS);
      corpus = `${pageCorpus}\n${bundleCorpus}`.slice(0, MAX_CORPUS_CHARS);
    }
  }

  const dossier: Dossier = {
    site,
    title: titleOf(html),
    metas: metasOf(html),
    fields: fieldsOf(html),
    /**
     * Read from the page and the bundle strings, NOT from `corpus`.
     *
     * `essence()` records what it found as `HOST github.com` — the host alone,
     * scheme discarded — and `hostsIn` matches on `https?://`. So scanning the
     * corpus for hosts re-scanned text that had already had the scheme removed
     * and found nothing, and every page whose URLs live only in href/src
     * attributes reported `HOSTS (none)` to both the classifier and the feed.
     * 28 of 82 published records carry an empty `outboundHosts`; 20 of those
     * have iocs the LLM had to recover from PAGE SOURCE instead. Bundled pages
     * were unaffected and hid it — `jsLiterals` keeps whole URLs, so the corpus
     * still had `https://` in it for exactly the pages that get bundles.
     */
    hosts: hostsIn(`${html}\n${bundleCorpus}`),
    visible: visible.slice(0, 2500),
    corpus,
    bundleCorpus,
    // Gate on whether the file is readable, not on whether it references a
    // script. Nearly every page loads something, and the SPA-shell heuristic
    // keys on *visible text* — so a 63 KB single-file page with its handlers
    // inline and little prose looks like a shell and would be excluded, which
    // is exactly the case this exists for. Bundles are never shipped either
    // way; they stay distilled.
    source: [
      readableSource(html).length <= LLM_SOURCE_MAX_CHARS ? readableSource(html) : '',
      bundleSource,
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, LLM_SOURCE_MAX_CHARS),
    htmlBytes: html.length,
    jsBytes,
    bundles,
  };

  log.site(track, 
    site.host,
    'dossier',
    `html=${kb(dossier.htmlBytes)} js=${kb(jsBytes)}/${bundles.length} ` +
      `text=${visible.length}c fields=${dossier.fields.length} hosts=${dossier.hosts.length} ` +
      `corpus=${dossier.corpus.length}c title=${JSON.stringify(dossier.title.slice(0, 60))}`,
  );
  return dossier;
}

/**
 * The dossier as text: page identity, input surface, outbound hosts, the lines
 * the rules matched, and the visible copy. This exact string is what goes to
 * the LLM and what gets dumped to the console for a flagged site.
 */
export function render(dossier: Dossier, classification: Classification): string {
  const pick = (corpus: string, limit: number, skip?: Set<string>) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of corpus.split('\n')) {
      const line = raw.trim();
      if (line.length <= 8 || line.length >= 300) continue;
      if (!ANY_RULE.test(line) || seen.has(line) || skip?.has(line)) continue;
      seen.add(line);
      out.push(line);
      if (out.length >= limit) break;
    }
    return out;
  };
  // Bundle strings get their own section and a smaller share of the budget.
  const bundleLines = new Set(dossier.bundleCorpus.split('\n').map((l) => l.trim()));
  const pageEvidence = pick(dossier.corpus, DOSSIER_MAX_EVIDENCE_LINES, bundleLines);
  const bundleEvidence = pick(dossier.bundleCorpus, 12);

  const lines = [
    `URL       ${dossier.site.url}`,
    `HOST      ${dossier.site.host}  (http ${dossier.site.status}, ${dossier.site.server || 'unknown server'})`,
    `REPO      github.com/${dossier.site.repo}  created ${dossier.site.repoCreatedAt}  via ${dossier.site.source} path`,
    `TITLE     ${dossier.title || '(none)'}`,
    ...dossier.metas.slice(0, 4).map((m) => `META      ${m}`),
    ...dossier.fields.slice(0, 20).map((f) => `FIELD     ${f}`),
    `HOSTS     ${dossier.hosts.slice(0, 15).join(', ') || '(none)'}`,
    `BUNDLES   ${dossier.bundles.length} (${kb(dossier.jsBytes)})`,
    `SIGNALS   ${Object.keys(classification.hits).sort().join(', ') || '(none)'}  score=${classification.score}`,
    'EVIDENCE FROM THE PAGE ITSELF',
    ...pageEvidence.map((line) => `  ${line}`),
    ...(bundleEvidence.length
      ? [
          'STRINGS FOUND IN BUNDLED JAVASCRIPT (may be library internals, not this page)',
          ...bundleEvidence.map((line) => `  ${line}`),
        ]
      : []),
    'VISIBLE',
    `  ${dossier.visible}`,
  ];

  return lines.join('\n').slice(0, DOSSIER_MAX_CHARS);
}
