/** A repo as hydrated from the GraphQL node API. */
export type Repo = {
  databaseId: number;
  nameWithOwner: string;
  homepageUrl: string | null;
  createdAt: string;
  isFork: boolean;
};

/** Which arm of the diagram produced this URL. */
export type CandidateSource = 'homepage' | 'guess' | 'canary';

export type Candidate = {
  url: string;
  /** Just the host — what pacing and provider decisions key on. */
  host: string;
  /**
   * How the site is identified everywhere a human reads it: host plus path,
   * no scheme. For vercel that is the host; for github.io it is usually
   * `account.github.io/project`, and 73% of github.io candidates carry a path,
   * so the host alone names the account rather than the site.
   */
  label: string;
  source: CandidateSource;
  repo: string;
  repoCreatedAt: string;
};

export type LiveSite = Candidate & {
  status: number;
  server: string;
  /** For 451s: the host's own takedown reason, e.g. DEPLOYMENT_DISABLED. */
  note: string;
  /**
   * The page, fetched by the liveness probe itself. Probing with HEAD and then
   * re-fetching with GET cost two requests per live site against providers that
   * ration them by the hundred, for no information the first request lacked.
   */
  html: string;
};

/**
 * One evidence document per site. Built once, then read by BOTH classifiers:
 * the rule engine scores `corpus`, the LLM reads `render()`. Same facts, two
 * opinions — that is the whole point of the dossier.
 */
export type Dossier = {
  site: LiveSite;
  title: string;
  metas: string[];
  fields: string[];
  hosts: string[];
  visible: string;
  /** Full extracted signal surface: HTML essence + JS bundle literals. */
  corpus: string;
  /**
   * The bundle-derived half on its own, so evidence can be attributed. A page
   * that bundles ethers.js contains "invalid mnemonic checksum" and "Expected
   * 32 bytes of private key" because the library does, not because the page
   * asks for either — and presenting those beside the page's own copy convicts
   * every honest web3 tool that ships a signing library.
   */
  bundleCorpus: string;
  /** The page itself, when small enough to hand to the classifier. */
  source: string;
  htmlBytes: number;
  jsBytes: number;
  bundles: string[];
};

export type RuleHits = Record<string, string[]>;

export type Classification = {
  score: number;
  hits: RuleHits;
  /** 'hostname' = priority lane, 'content' = rule score over threshold. */
  lanes: ('hostname' | 'content')[];
};

export type LlmVerdict = {
  verdict: 'malicious' | 'suspicious' | 'benign';
  confidence: number;
  category: string;
  brand: string | null;
  reasons: string[];
  iocs: string[];
};

export type Finding = {
  dossier: Dossier;
  classification: Classification;
  llm: LlmVerdict;
};
