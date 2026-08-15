/**
 * Console logging is the *detailed* record of a run: every per-site line is
 * prefixed with the hostname, so `ctrl+f some-site.vercel.app` in the raw log
 * (or in the GitHub Actions log) surfaces that site's entire life story —
 * where it came from, whether it was live, what was extracted, what the rules
 * said, what the LLM said. The dated JSONL is the terse counterpart.
 */
const START = Date.now();
const COLOR = !process.env.NO_COLOR;

const c = (code: string, s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => c('2', s);
const bold = (s: string) => c('1', s);
const red = (s: string) => c('31', s);
const green = (s: string) => c('32', s);
const yellow = (s: string) => c('33', s);
const cyan = (s: string) => c('36', s);

const elapsed = () => dim(`${((Date.now() - START) / 1000).toFixed(1).padStart(7)}s`);

const TAG_COLORS: Record<string, (s: string) => string> = {
  live: green,
  takedown: yellow,
  rules: cyan,
  triage: yellow,
  llm: bold,
  pass: green,
  drop: dim,
  error: red,
  warn: yellow,
};

function tagged(tag: string): string {
  const paint = TAG_COLORS[tag] ?? dim;
  return paint(`[${tag}]`.padEnd(10));
}

export function stage(n: number, title: string, detail = ''): void {
  console.log('');
  console.log(`${elapsed()} ${bold(`── stage ${n} ── ${title}`)} ${dim(detail)}`);
}

/** Flow counts between stages, mirroring the arrows in the pipeline diagram. */
export function flow(from: string, count: number, to: string): void {
  console.log(`${elapsed()} ${dim('│')} ${from} ${bold(String(count))} ${dim('→')} ${to}`);
}

export function info(msg: string): void {
  console.log(`${elapsed()} ${tagged('info')} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${elapsed()} ${tagged('warn')} ${msg}`);
}

export function error(msg: string): void {
  console.log(`${elapsed()} ${tagged('error')} ${msg}`);
}

/** One greppable line for one host. */
export function site(host: string, tag: string, msg: string): void {
  console.log(`${elapsed()} ${tagged(tag)} ${cyan(host.padEnd(38))} ${msg}`);
}

/** Multi-line detail for one host — every line still carries the host. */
export function block(host: string, tag: string, text: string): void {
  for (const line of text.split('\n')) {
    console.log(`${elapsed()} ${tagged(tag)} ${cyan(host.padEnd(38))} ${dim('┃')} ${line}`);
  }
}
