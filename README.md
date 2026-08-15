# no place for drainers

Phishing kits, wallet drainers and tracking beacons need a host, and the free
ones are one `git push` away. That push is the mistake: the deployment is anonymous, but
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

**Scope is deliberately broad.** A page qualifies if it does something to whoever
opens it that they would object to if they understood it — credential harvesting,
drainers, fake support and giveaways, covert exfiltration of the visitor
themselves. Drainers are the flagship case, not the boundary; the acquisition
walk is provider-shaped rather than topic-shaped, so narrowing the classifier
below it would throw away pipeline already paid for. Every record carries a
`category`, so consumers who only want drainers can filter for them.

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
vocabulary that makes a name worth spending a request on. It applies wherever
the provider rations requests and nowhere else: vercel gives a runner somewhere
between 38 and 1,900 requests before it starts resetting connections, while
github.io served 600 at 68/s without complaint. So on vercel a name has to earn
its request (guessed or declared, ~2% do); on github.io we fetch everything and
let the page speak for itself.

Widening it is the main lever on recall, and the main way to get blocked again.
The probe tally on every progress line (`404:253 live:93 err-ECONNRESET:6`) is
how you tell which is happening.

`packages/scanner/src/pace.ts` is the other half of that. Vercel does not answer
an over-eager scanner with 429 — it resets the connection and keeps doing so for
minutes, which is invisible unless you are counting. Measured trips cluster near
a few hundred requests rather than at a rate, so the limiter starts at 4 req/s,
halves and pauses 90s whenever resets appear, and creeps back up while it is
being answered. Where it settled is in each run summary as `paceRates`.

`CANARY_URLS` is injected into every run. If the canary is not caught, the
pipeline is broken — the summary says so, and the runs page says so louder.
