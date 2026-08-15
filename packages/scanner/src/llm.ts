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
  LLM_MAX_TOKENS,
  LLM_MIN_CONFIDENCE,
  LLM_MODEL,
  LLM_REASONING_EFFORT,
  LLM_TIMEOUT_MS,
} from './config.ts';
import { request } from './http.ts';
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

export async function triage(dossierText: string): Promise<LlmVerdict> {
  const res = await request(`${LLM_BASE_URL}/chat/completions`, {
    method: 'POST',
    tries: 3,
    timeoutMs: LLM_TIMEOUT_MS,
    redirect: 'follow',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL,
      reasoning_effort: LLM_REASONING_EFFORT,
      max_tokens: LLM_MAX_TOKENS,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `DOSSIER\n${dossierText}` },
      ],
    }),
  });

  if (res.status !== 200 || !res.body.length) {
    return { ...FAILED, reasons: [`llm http ${res.status}`] };
  }

  try {
    const payload = JSON.parse(decode(res.body));
    const content: string = payload?.choices?.[0]?.message?.content ?? '';
    return coerce(JSON.parse(content.replace(/^```(?:json)?|```$/g, '').trim()));
  } catch {
    return { ...FAILED, reasons: ['llm returned unparseable json'] };
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
