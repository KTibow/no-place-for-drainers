# no place for drainers

Wallet drainers and credential phishing kits need a host, and the free ones are
one `git push` away. That push is the mistake: the deployment is anonymous, but
the repo behind it is a public, timestamped, enumerable record. This walks every
new public repo on GitHub, guesses or reads its deployment URL, and looks at
what is actually being served — a few hours after it goes up, and long before
anyone would think to submit it to urlscan.

**→ [kendell.dev/no-place-for-drainers](https://kendell.dev/no-place-for-drainers/)**

```
1  /repositories walk    every new public repo, id-sharded across the window
2  two paths to a URL    repo name → guessed host  |  homepage field → free hosts
3  probe liveness        HEAD both paths, keep the deduped union
4  dossier               one evidence doc per live site (SPA? read the bundle)
5  detection             hostname keyword lane  |  content rule lane
6  LLM triage            the same dossier, a second opinion
7  analyst queue         dated JSONL of what survived
```

Stages 5 and 6 read the **identical** dossier built in stage 4. The rules are a
keyword net — good at "this page contains 'seed phrase'", bad at "…because it is
a hardware wallet tutorial". The LLM decides; the rules only nominate. Because
both see the same facts, a disagreement between them means something.

## Layout

```
packages/scanner    the pipeline. src/main.ts reads top-to-bottom as the diagram
packages/site       Astro, builds the published site straight out of out/
out/                committed. this directory's history is the record
```

## Output

- **`out/drainers-<date>.jsonl`** — one line per confirmed site, only the fields
  a human or a downstream submitter needs. Committed, append-only in practice,
  and the source of truth the site is built from.
- **`out/summary-<date>.json`** — run stats, plus every HTTP 451 seen. Those are
  the most interesting dead URLs we have: the host already agreed the
  deployment was abusive, and the repo behind it is still sitting there.
- **the console log** — the detailed record, kept as a CI artifact for 90 days.
  Every per-site line is prefixed with the hostname, so `ctrl+f
  some-site.vercel.app` replays that site's whole life: where it came from,
  whether it was live, what was extracted, what each classifier said, and why it
  was kept or dropped.

## Running it

```sh
pnpm install
pnpm scan        # reads .env if present: GITHUB_PAT, CROF_KEY
pnpm dev         # the site, against whatever is in out/
```

Needs Node 24+ — the scanner is TypeScript run directly, with no build step.

In CI the scan uses the automatic workflow token, which is capped at 1,000 REST
requests/hour. Set a `GITHUB_PAT` secret to get 5,000/hour and proportionally
more of the window. `CROF_KEY` is required for stage 6.

## Tuning

Every knob is a constant in `packages/scanner/src/config.ts`. There are no CLI
flags and no config files, by design.

The one that decides everything else is `LURE_ANYWHERE` / `LURE_BOUNDED` — the
vocabulary that makes a repo name worth guessing a deployment for. Guessing for
every new repo means ~35,000 requests at one provider, and vercel's edge answers
that by resetting every connection from the source IP after a few hundred, which
is exactly how the first two runs produced nothing. The filter keeps ~2% of
names, so a 50k-repo run guesses ~880 hosts instead of ~34,700.

Widening it is the main lever on recall, and the main way to get blocked again.
The probe tally on every progress line (`404:253 live:93 err-ECONNRESET:6`) is
how you tell which is happening.

`CANARY_URLS` is injected into every run. If the canary is not caught, the
pipeline is broken — the summary says so, and the runs page says so louder.
