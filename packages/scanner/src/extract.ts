/**
 * Text extraction. Everything here exists to answer one question: what would a
 * human notice on this page, plus everything the page is hiding from them.
 *
 * Inline <script> contents are deliberately kept. That is where credential
 * harvesting kits live — strip them and the signal goes with them.
 */
import { parse } from 'acorn';

/**
 * The page with the parts that carry no judgement removed: style blocks and
 * comments. Everything else stays, scripts included — the handler that decides
 * where a typed value goes is the whole point.
 */
export function readableSource(html: string): string {
  return html
    // Inlined base64 blobs are images and fonts: no judgement value, and they
    // dominate. A real drainer measured 408 KB of which 333 KB was three data
    // URIs, which pushed it past the source cap so the classifier had to judge
    // it blind. Stripping them leaves 32 KB of actual page.
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, 'data:<stripped>')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function titleOf(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1]!.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

export function metasOf(html: string): string[] {
  const wanted = new Set(['description', 'og:title', 'og:description', 'og:site_name']);
  const out: string[] = [];
  const re =
    /<meta[^>]+(?:name|property)=["']([^"']+)["'][^>]+content=["']([^"']*)["']/gi;
  for (const m of html.matchAll(re)) {
    if (wanted.has(m[1]!.toLowerCase()) && m[2]) out.push(m[2].slice(0, 200));
  }
  return out;
}

/** Input surface: what the page is asking the visitor to type. */
export function fieldsOf(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<(?:input|select|textarea)[^>]*>/gi)) {
    const bits = [
      ...m[0].matchAll(/(?:name|id|placeholder|type|aria-label)=["']([^"']{1,50})["']/gi),
    ].map((b) => b[1]!);
    if (bits.length) out.push(bits.join(' '));
  }
  for (const m of html.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/gi)) {
    const text = m[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text) out.push(`label: ${text.slice(0, 80)}`);
  }
  return out;
}

export function hostsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    out.add(m[1]!.toLowerCase());
  }
  return [...out];
}

export function bundlesIn(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+\.js)["']/gi)) {
    try {
      out.push(new URL(m[1]!, pageUrl).toString());
    } catch {
      /* ignore malformed src */
    }
  }
  return [...new Set(out)];
}

/**
 * The signal surface of an HTML page: identity, input surface, inline script
 * strings, outbound hosts, visible copy. Deduped, order preserved.
 */
export function essence(html: string): string {
  const parts: string[] = [];
  const title = titleOf(html);
  if (title) parts.push(`TITLE ${title}`);
  for (const meta of metasOf(html)) parts.push(`META ${meta}`);
  for (const field of fieldsOf(html)) parts.push(`FIELD ${field}`);

  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]{0,40000}?)<\/script>/gi)) {
    const literals = [...m[1]!.matchAll(/["'`]([^"'`\n]{5,160})["'`]/g)].slice(0, 120);
    for (const lit of literals) {
      if (/[a-z]{3}/i.test(lit[1]!)) parts.push(`STR ${lit[1]}`);
    }
  }

  for (const host of hostsIn(html)) parts.push(`HOST ${host}`);
  parts.push(`TEXT ${stripTags(html).slice(0, 4000)}`);

  return [...new Set(parts)].join('\n');
}

/**
 * String literals out of a JS bundle. An SPA shell is 1.8 KB of nothing; the
 * seed-phrase form lives in the 400 KB bundle next to it. acorn gets escapes
 * and template literals right; the regex fallback is there for minified files
 * that fail to parse.
 */
export function jsLiterals(source: string): string {
  const found: string[] = [];
  try {
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
    walk(ast, found);
  } catch {
    try {
      const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
      walk(ast, found);
    } catch {
      for (const m of source.matchAll(/["'`]([^"'`\n]{5,160})["'`]/g)) found.push(m[1]!);
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const literal of found) {
    if (!literal || literal.length > 300 || !/[a-z]{4}/i.test(literal)) continue;
    if (seen.has(literal)) continue;
    seen.add(literal);
    out.push(literal);
  }
  return out.join('\n');
}

function walk(node: any, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'Literal' && typeof node.value === 'string') out.push(node.value);
  if (node.type === 'TemplateLiteral') {
    for (const quasi of node.quasis ?? []) {
      if (quasi?.value?.cooked) out.push(quasi.value.cooked);
    }
  }
  for (const key of Object.keys(node)) {
    if (key === 'type') continue;
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) walk(child, out);
    else if (value && typeof value === 'object') walk(value, out);
  }
}
