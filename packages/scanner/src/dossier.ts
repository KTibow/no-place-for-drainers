/**
 * Stage 4 — one dossier per live site.
 *
 * This is the hinge of the whole pipeline. The dossier is built once, from the
 * page and (when the page is an empty SPA shell) from its JS bundles, and then
 * BOTH classifiers work from it: the rule engine scores `corpus`, and the LLM
 * reads `render()`. Neither gets to see evidence the other did not.
 */
import {
  DOSSIER_MAX_CHARS,
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
  let corpus = essence(html);
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
      corpus = `${corpus}\n${jsLiterals(decode(bundle.body))}`.slice(0, MAX_CORPUS_CHARS);
    }
  }

  const dossier: Dossier = {
    site,
    title: titleOf(html),
    metas: metasOf(html),
    fields: fieldsOf(html),
    hosts: hostsIn(corpus),
    visible: visible.slice(0, 800),
    corpus,
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
  const evidence: string[] = [];
  const seen = new Set<string>();
  for (const raw of dossier.corpus.split('\n')) {
    const line = raw.trim();
    if (line.length <= 8 || line.length >= 300) continue;
    if (!ANY_RULE.test(line) || seen.has(line)) continue;
    seen.add(line);
    evidence.push(line);
    if (evidence.length >= DOSSIER_MAX_EVIDENCE_LINES) break;
  }

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
    'EVIDENCE',
    ...evidence.map((line) => `  ${line}`),
    'VISIBLE',
    `  ${dossier.visible}`,
  ];

  return lines.join('\n').slice(0, DOSSIER_MAX_CHARS);
}
