/**
 * Stage 1 — the `/repositories` walk.
 *
 * `/repositories` is an id-ordered firehose of every public repo ever created,
 * 100 per request, and it is the only endpoint that will hand you brand-new
 * repos without a search query. It returns a *minimal* representation though:
 * no homepage, no createdAt. So the walk collects node ids and GraphQL hydrates
 * them 300 at a time, which costs a single rate-limit point per batch.
 *
 * The id range for the window is bracketed with two search calls, then split
 * across shards, so a capped run is a stratified sample across the whole
 * window instead of the first N repos of it.
 */
import { HEAD_LAG_MINUTES, HYDRATE_BATCH, REPO_LIMIT, WALK_SHARDS, WINDOW_HOURS } from './config.ts';
import { request } from './http.ts';
import * as log from './log.ts';
import type { Repo } from './types.ts';
import { chunk, decode, pool, sleep } from './util.ts';

const API = 'https://api.github.com';

const TOKEN =
  process.env.GITHUB_PAT || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

export function requireToken(): void {
  if (!TOKEN) {
    console.error('no GitHub token: set GITHUB_PAT (locally, in .env) or GITHUB_TOKEN (CI)');
    process.exit(1);
  }
}

let rateFloorUntil = 0;

async function api(path: string, init?: { method?: string; body?: string }): Promise<unknown> {
  const wait = rateFloorUntil - Date.now();
  if (wait > 0) {
    log.warn(`rate limit floor reached, sleeping ${Math.ceil(wait / 1000)}s`);
    await sleep(wait);
  }

  const res = await request(`${API}${path}`, {
    method: init?.method,
    body: init?.body,
    redirect: 'follow',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
  });

  const remaining = Number(res.headers.get('x-ratelimit-remaining'));
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(remaining) && remaining <= 1 && Number.isFinite(reset)) {
    rateFloorUntil = Math.max(rateFloorUntil, reset * 1000 + 2000);
  }

  if (res.status !== 200 || res.body.length === 0) {
    log.warn(`GET ${path.slice(0, 80)} → ${res.status}`);
    return null;
  }
  try {
    return JSON.parse(decode(res.body));
  } catch {
    return null;
  }
}

async function graphql(query: string, variables: Record<string, unknown>): Promise<any> {
  return await api('/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
}

const iso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, 'Z');

/**
 * Ask search for repos created inside a 3-minute slot and take the extreme id.
 * `min` biases the bracket earlier (never miss the start of the window), `max`
 * biases it later (cover up to the head).
 */
async function bracketId(at: Date, pick: 'min' | 'max'): Promise<number | null> {
  for (const spread of [3, 10, 30]) {
    const from = iso(at);
    const to = iso(new Date(at.getTime() + spread * 60_000));
    const data = (await api(
      `/search/repositories?q=${encodeURIComponent(`created:${from}..${to}`)}&per_page=100`,
    )) as { items?: { id: number }[] } | null;
    const ids = data?.items?.map((i) => i.id) ?? [];
    if (ids.length) return pick === 'min' ? Math.min(...ids) : Math.max(...ids);
    await sleep(2000);
  }
  return null;
}

/** Walk the id range for the window and return hydrated, in-window repos. */
export async function walkNewRepos(): Promise<{ repos: Repo[]; cutoff: string }> {
  const now = Date.now();
  const cutoff = new Date(now - WINDOW_HOURS * 3600_000);
  const head = new Date(now - HEAD_LAG_MINUTES * 60_000);

  // Bias the low bracket a few minutes before the cutoff so nothing is clipped;
  // repos that turn out to predate the cutoff are dropped after hydration. Keep
  // the bias small — the first shard spends its budget walking through it.
  const [startId, headId] = await Promise.all([
    bracketId(new Date(cutoff.getTime() - 5 * 60_000), 'min'),
    bracketId(new Date(head.getTime() - 3 * 60_000), 'max'),
  ]);
  if (startId === null || headId === null || headId <= startId) {
    console.error('could not bracket the repo-id range — check the token and try a wider window');
    process.exit(1);
  }

  const span = headId - startId;
  const perShard = Math.ceil(REPO_LIMIT / WALK_SHARDS);
  log.info(
    `window ${iso(cutoff)} → ${iso(head)}  ids ${startId}..${headId} (${span.toLocaleString()} ids), ` +
      `${WALK_SHARDS} shards × ${perShard} repos`,
  );

  const collected: Repo[] = [];
  let pages = 0;

  await pool(
    Array.from({ length: WALK_SHARDS }, (_, i) => i),
    WALK_SHARDS,
    async (shardIndex) => {
      const from = startId + Math.floor((span * shardIndex) / WALK_SHARDS);
      const until = startId + Math.floor((span * (shardIndex + 1)) / WALK_SHARDS);
      let since = from - 1;
      let taken = 0;
      const pending: string[] = [];
      const hydrated: Repo[] = [];

      const drain = async (all: boolean) => {
        while (pending.length >= HYDRATE_BATCH || (all && pending.length)) {
          const batch = pending.splice(0, HYDRATE_BATCH);
          hydrated.push(...(await hydrate(batch)));
        }
      };

      while (since < until && taken < perShard) {
        const page = (await api(`/repositories?since=${since}&per_page=100`)) as
          | { id: number; node_id: string }[]
          | null;
        if (!page?.length) break;
        pages++;
        since = page[page.length - 1]!.id;
        for (const r of page) pending.push(r.node_id);
        taken += page.length;
        await drain(false);
      }
      await drain(true);

      log.info(`shard ${shardIndex}: ids ${from}..${until} → ${hydrated.length} hydrated`);
      collected.push(...hydrated);
    },
  );

  const cutoffMs = cutoff.getTime();
  const repos = collected.filter((r) => Date.parse(r.createdAt) >= cutoffMs);
  log.info(
    `${pages} REST pages, ${collected.length} hydrated, ${repos.length} inside the ${WINDOW_HOURS}h window`,
  );
  return { repos, cutoff: iso(cutoff) };
}

const FIELDS = 'databaseId nameWithOwner homepageUrl createdAt isFork';

/** 300 ids per call = 1 point. Deleted repos come back as nulls; drop them. */
async function hydrate(nodeIds: string[]): Promise<Repo[]> {
  const batches = chunk(nodeIds, 100);
  const decls = batches.map((_, i) => `$b${i}:[ID!]!`).join(',');
  const body = batches
    .map((_, i) => `b${i}: nodes(ids:$b${i}){ ... on Repository { ${FIELDS} } }`)
    .join(' ');
  const vars = Object.fromEntries(batches.map((b, i) => [`b${i}`, b]));

  const data = await graphql(`query(${decls}){ ${body} }`, vars);
  const out: Repo[] = [];
  for (const [key, value] of Object.entries<any>(data?.data ?? {})) {
    if (!key.startsWith('b') || !Array.isArray(value)) continue;
    for (const node of value) if (node?.nameWithOwner) out.push(node as Repo);
  }
  return out;
}
