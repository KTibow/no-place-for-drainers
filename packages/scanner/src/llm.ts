/**
 * Stage 6 — LLM triage.
 *
 * The rules are a keyword net: they are good at "this page contains the string
 * 'seed phrase'" and bad at "…because it is a hardware-wallet tutorial". The
 * LLM reads the same dossier and decides whether the page is actually trying to
 * take something from a visitor. Rules find candidates; this decides.
 */
import {
  LLM_BASE_URL,
  LLM_MIN_CONFIDENCE,
  LLM_MODEL,
  LLM_REASONING_EFFORT,
  LLM_TIMEOUT_MS,
} from './config.ts';
import { request } from './http.ts';
import * as log from './log.ts';
import type { LlmVerdict } from './types.ts';
import { decode } from './util.ts';

const KEY = process.env.CROF_KEY || process.env.OPENAI_API_KEY || '';

export function requireKey(): void {
  if (!KEY) {
    console.error('no LLM key: set CROF_KEY (locally, in .env) or as a CI secret');
    process.exit(1);
  }
}

const SYSTEM = `You are a triage analyst on a defensive security pipeline that hunts crypto-wallet drainers and credential phishing deployed to free hosts (vercel.app, netlify.app, pages.dev, github.io).

You are given a DOSSIER automatically extracted from one live page: its identity, its input fields, the outbound hosts it talks to, lines that matched keyword rules, and its visible copy. Decide what the page IS.

MALICIOUS means the page exists to take something from a visitor:
- asks for a seed phrase / recovery phrase / mnemonic / keystore / private key in any wording
- impersonates a wallet, exchange, or bank login to harvest credentials, OTPs, or card data
- a wallet "connect" or "validate" flow whose purpose is to move a visitor's funds
- exfiltrates typed input to Telegram bot APIs, Discord webhooks, or an unrelated third-party endpoint

BENIGN, no matter how many crypto keywords appear:
- a real open-source dApp or wallet UI that uses window.ethereum / wagmi / viem / ethers and never asks for a seed phrase
- documentation, tutorials, blog posts, or security write-ups ABOUT phishing or seed phrases
- portfolios, landing pages, dashboards, games, framework starter templates ("Create Next App")
- a page whose only evidence is one brand name, or the word "private key" in a developer context
- a self-hosted admin panel, deploy tool, or config UI that asks for the operator's OWN
  credentials — a Cloudflare API token, an AWS key, a database URL, a bot token. The operator
  and the victim are the same person, so there is nobody to steal from. Tells: the page is an
  admin console or settings screen rather than a landing page, the fields configure a service
  the visitor already runs, and the surrounding copy is documentation rather than urgency.
  Phishing impersonates a login you already have; a config UI sets up something you are building.

SUSPICIOUS is for a page that shows drainer shape but whose evidence is too thin to call: brand impersonation with no harvesting form, or an incomplete deployment.

Judge only the evidence in the dossier. Do not assume anything the dossier does not show. An empty or generic page is benign.

Reply with JSON only:
{"verdict":"malicious|suspicious|benign","confidence":0.0-1.0,"category":"seed-phrase-harvester|wallet-connect-drainer|exchange-credential-phish|bank-credential-phish|generic-credential-phish|giveaway-or-airdrop-scam|other|none","brand":"impersonated brand or null","reasons":["<= 3 short specific reasons, quoting the dossier"],"iocs":["exfil endpoints, telegram/discord urls, unrelated third-party hosts"]}`;

const FAILED: LlmVerdict = {
  verdict: 'benign',
  confidence: 0,
  category: 'none',
  brand: null,
  reasons: ['llm call failed'],
  iocs: [],
};

let failures = 0;

/** Calls that never produced a usable verdict. Reported in the run summary. */
export function failureCount(): number {
  return failures;
}

/**
 * A model that returns junk must not read as "benign" — that is a fail-open on
 * the last gate in the pipeline. One retry, then count it and say so.
 */
export async function triage(
  dossierText: string,
  host: string,
  track: string,
): Promise<LlmVerdict> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const verdict = await askOnce(dossierText, host, track);
    if (verdict) return verdict;
  }
  failures++;
  return { ...FAILED, reasons: ['llm produced no usable verdict after 2 attempts'] };
}

/** Null means "no usable answer", which is different from "benign". */
async function askOnce(
  dossierText: string,
  host: string,
  track: string,
): Promise<LlmVerdict | null> {
  const res = await request(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    tries: 3,
    timeoutMs: LLM_TIMEOUT_MS,
    redirect: 'follow',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL,
      reasoning_effort: LLM_REASONING_EFFORT,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `DOSSIER\n${dossierText}` },
      ],
    }),
  });

  if (res.status !== 200 || !res.body.length) {
    log.site(track, host, 'warn', `llm http ${res.status}${res.error ? ` ${res.error}` : ''}`);
    return null;
  }

  let payload: any;
  try {
    payload = JSON.parse(decode(res.body));
  } catch {
    log.site(track, host, 'warn', `llm response was not json: ${decode(res.body).slice(0, 120)}`);
    return null;
  }

  const choice = payload?.choices?.[0];
  const content: string = choice?.message?.content ?? '';
  try {
    return coerce(JSON.parse(content.replace(/^```(?:json)?|```$/g, '').trim()));
  } catch {
    // Say why. "unparseable json" is not a diagnosis. finish_reason separates
    // truncation from a model that simply wrote prose, and the tail shows which
    // — valid JSON that stops mid-string reads very differently from an apology.
    const usage = payload?.usage ?? {};
    log.site(
      track,
      host,
      'warn',
      `llm unusable: finish=${choice?.finish_reason ?? '?'} ` +
        `completion=${usage.completion_tokens ?? '?'} reasoning=${usage.reasoning_tokens ?? '?'} ` +
        `content=${content.length}c tail=${JSON.stringify(content.slice(-120))}`,
    );
    return null;
  }
}

function coerce(raw: any): LlmVerdict {
  const verdict =
    raw?.verdict === 'malicious' || raw?.verdict === 'suspicious' ? raw.verdict : 'benign';
  const confidence = Number(raw?.confidence);
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 6) : [];
  return {
    verdict,
    confidence: Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0,
    category: typeof raw?.category === 'string' ? raw.category : 'other',
    brand: typeof raw?.brand === 'string' && raw.brand ? raw.brand : null,
    reasons: list(raw?.reasons),
    iocs: list(raw?.iocs),
  };
}

/** What reaches the analyst queue. */
export function passes(verdict: LlmVerdict): boolean {
  return verdict.verdict === 'malicious' && verdict.confidence >= LLM_MIN_CONFIDENCE;
}
