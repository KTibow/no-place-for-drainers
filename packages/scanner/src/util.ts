export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run `worker` over `items` with a fixed number of in-flight tasks. */
export async function pool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return out;
}

/** Split into [matching, rest], preserving order within each. */
export function partition<T>(items: T[], predicate: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const item of items) (predicate(item) ? yes : no).push(item);
  return [yes, no];
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url;
  }
}

/** ISO date (YYYY-MM-DD) in UTC. */
export function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * ISO stamp to the minute, filename-safe: `2026-08-15T05-13Z`. Sorts
 * lexically in run order, and stays readable as a date at a glance.
 */
export function runStamp(d = new Date()): string {
  return `${d.toISOString().slice(0, 16).replace(':', '-')}Z`;
}

export function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function kb(bytes: number): string {
  return bytes >= 1024 ? `${Math.round(bytes / 1024)}kb` : `${bytes}b`;
}
