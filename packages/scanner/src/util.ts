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

/** ISO date (YYYY-MM-DD) in UTC — the stamp on the output file. */
export function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function kb(bytes: number): string {
  return bytes >= 1024 ? `${Math.round(bytes / 1024)}kb` : `${bytes}b`;
}
