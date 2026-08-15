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
  host: string;
  source: CandidateSource;
  repo: string;
  repoCreatedAt: string;
};

export type LiveSite = Candidate & {
  status: number;
  server: string;
  /** For 451s: the host's own takedown reason, e.g. DEPLOYMENT_DISABLED. */
  note: string;
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
