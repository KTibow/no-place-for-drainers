/**
 * Console logging is the *detailed* record of a run.
 *
 * Two rules, both learned the hard way:
 *
 * Every line carries its hostname, so `ctrl+f some-site.vercel.app` in the raw
 * log surfaces that site's entire life story — where it came from, whether it
 * was live, what was extracted, what each classifier said, why it was kept.
 *
 * Every line also carries its track. The pipeline runs two of itself at once
 * and their output interleaves, so anything that implies sequence lies. There
 * are deliberately no banners and no blank-line sections: a banner reading
 * "stage 3" followed by another reading "stage 3" looks like a repeat, and
 * "vercel stage 4" printing after "open stage 6" looks like time ran backwards.
 * A column is honest about concurrency in a way a heading cannot be.
 */
const START = Date.now();
const COLOR = !process.env.NO_COLOR;

const c = (code: string, s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => c('2', s);
const bold = (s: string) => c('1', s);
const red = (s: string) => c('31', s);
const green = (s: string) => c('32', s);
const yellow = (s: string) => c('33', s);
const blue = (s: string) => c('34', s);
const magenta = (s: string) => c('35', s);
const cyan = (s: string) => c('36', s);

/** The track a line belongs to. `main` is the un-split part of the run. */
export const MAIN = 'main';

const elapsed = () => dim(`${((Date.now() - START) / 1000).toFixed(1).padStart(7)}s`);

const TRACK_COLORS: Record<string, (s: string) => string> = {
  main: dim,
  vercel: magenta,
  open: blue,
};

const TAG_COLORS: Record<string, (s: string) => string> = {
  stage: bold,
  flow: cyan,
  live: green,
  takedown: yellow,
  rules: cyan,
  llm: bold,
  pass: green,
  submit: green,
  drop: dim,
  error: red,
  warn: yellow,
};

function emit(track: string, tag: string, host: string, message: string): void {
  const paintTrack = TRACK_COLORS[track] ?? dim;
  const paintTag = TAG_COLORS[tag] ?? dim;
  const columns = [
    elapsed(),
    paintTrack(track.padEnd(6)),
    paintTag(tag.padEnd(8)),
    host ? cyan(host.padEnd(38)) : '',
    message,
  ];
  console.log(columns.filter(Boolean).join(' '));
}

export function stage(track: string, n: number, title: string, detail = ''): void {
  emit(track, 'stage', '', `${bold(`${n} ${title}`)} ${dim(detail)}`);
}

/** Counts between stages, mirroring the arrows in the pipeline diagram. */
export function flow(track: string, from: string, count: number, to: string): void {
  emit(track, 'flow', '', `${from} ${bold(String(count))} ${dim('→')} ${to}`);
}

export function info(track: string, message: string): void {
  emit(track, 'info', '', message);
}

export function warn(track: string, message: string): void {
  emit(track, 'warn', '', message);
}

export function error(track: string, message: string): void {
  emit(track, 'error', '', message);
}

/** One greppable line for one host. */
export function site(track: string, host: string, tag: string, message: string): void {
  emit(track, tag, host, message);
}

/** Multi-line detail for one host — every line still carries host and track. */
export function block(track: string, host: string, tag: string, text: string): void {
  for (const line of text.split('\n')) emit(track, tag, host, `${dim('┃')} ${line}`);
}
