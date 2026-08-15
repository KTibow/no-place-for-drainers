/**
 * Stage 5 — detection, two lanes into the same triage queue.
 *
 *   hostname lane : priority lane. `restore-wallet-sync.vercel.app` earns a
 *                   look regardless of what the HTML says, because the name is
 *                   chosen for the victim, not for the developer.
 *   content lane  : weighted rules over the dossier corpus. Weights are the
 *                   point — a lone "private key" is a legitimate SSH tutorial,
 *                   a seed-phrase prompt is not.
 *
 * Both lanes read the dossier that stage 4 already built, and the LLM in stage
 * 6 reads that same dossier. Two independent opinions, one set of facts.
 */
import { CONTENT_SCORE_THRESHOLD, looksLikeLure } from './config.ts';
import type { Classification, Dossier, RuleHits } from './types.ts';

type Rule = { weight: number; pattern: RegExp };

export const RULES: Record<string, Rule> = {
  // Nothing legitimate ships a Telegram bot token or a Discord webhook in
  // client-side code. This is the exfil channel itself.
  exfil: {
    weight: 3,
    pattern: /api\.telegram\.org|bot\d{6,}:AA|discord(?:app)?\.com\/api\/webhooks|chat_id/i,
  },
  /**
   * The same exfil channel wearing a respectable coat. A client-side email
   * relay — EmailJS is the one that keeps turning up — takes a form submission
   * straight from the browser to whatever mailbox the operator configured, so
   * it needs no server and leaves no endpoint in the page beyond an SDK import.
   *
   * Unlike a bot token this has honest uses: it is how a static portfolio ships
   * a contact form, so the content lane will now forward some of those. That is
   * the trade taken deliberately. Two confirmed BSP Bank transfer-phishing kits
   * (2026-08-15) scored 0 on every rule and reached triage on their hostname
   * alone; their entire harvesting apparatus was one jsdelivr script tag. At
   * weight 2 they would still have scored 0 — the relay IS the evidence on a
   * page like that, so it has to carry the lane by itself. The LLM prompt is
   * extended in the same change to tell a contact form from a harvester.
   */
  exfil_mail: {
    weight: 3,
    pattern: /api\.emailjs\.com|@emailjs\/browser|emailjs-com|emailjs\.(?:send|sendForm|init)/i,
  },
  // No honest website has a reason to ask for these words.
  seed: {
    weight: 3,
    pattern: /seed\s*phrase|recovery\s*phrase|mnemonic|12[-\s]word|24[-\s]word|secret\s*recovery/i,
  },
  // Weak alone: real apps handle SSH keys, JWTs and crypto private keys.
  privkey: { weight: 1, pattern: /private\s*key|keystore\s*(?:file|json)/i },
  drain_copy: {
    weight: 2,
    pattern: new RegExp(
      [
        'irregular\\s*balance',
        'asset\\s*recovery',
        'rectify',
        'validate\\s*wallet',
        'sync\\s*wallet',
        'restore\\s*wallet',
        'claim\\s*(?:your\\s*)?airdrop',
        'import\\s*(?:an\\s*)?existing\\s*wallet',
        'migrate\\s*(?:your\\s*)?wallet',
        'wallet\\s*verification',
        'connect\\s*(?:your\\s*)?wallet\\s*to\\s*(?:claim|verify|restore)',
      ].join('|'),
      'i',
    ),
  },
  wallet_brand: {
    weight: 1,
    pattern:
      /metamask|trust\s*wallet|walletconnect|phantom\s*wallet|coinbase\s*wallet|ledger\s*live|trezor|exodus\s*wallet|safepal|rainbow\s*wallet/i,
  },
  bank_brand: {
    weight: 1,
    pattern:
      /rakbank|paypal|barclays|hsbc|santander|wells\s*fargo|chase\s*bank|binance|kraken|coinbase\s*(?:pro|exchange)/i,
  },
  /**
   * Money extracted by promise rather than by credential. Added because the
   * content lane is by far the most precise gate we have — 43% of what it
   * forwards is confirmed, against 3% for the hostname lane — yet it fired on
   * only 22 of 4,523 dossiers, because its vocabulary was written when this
   * only hunted drainers. Two confirmed scams scored 0: a fake BTC voucher
   * demanding a "gas fee" to withdraw, and an investment scheme promising
   * guaranteed returns per cycle. Both reached triage on their hostname alone.
   */
  advance_fee: {
    weight: 2,
    pattern: new RegExp(
      [
        '(?:gas|withdrawal|unlock|activation|processing|release|clearance)\\s*fee',
        'fee\\s*to\\s*(?:withdraw|unlock|release|claim|activate)',
        'pay\\s*(?:a\\s*)?small\\s*fee',
        'to\\s*(?:receive|claim|unlock)\\s*your\\s*(?:reward|prize|voucher|funds|bonus)',
        'voucher\\s*code',
      ].join('|'),
      'i',
    ),
  },
  guaranteed_return: {
    weight: 2,
    pattern: new RegExp(
      [
        'guaranteed\\s*(?:profit|return|income|payout)',
        '(?:profit|return|roi)\\s*(?:of\\s*)?\\d{2,}\\s*%',
        '\\d{2,}\\s*%\\s*(?:profit|return|roi|daily|weekly|monthly|per\\s*cycle)',
        'keuntungan\\s*(?:pasti|terjamin)',
        'investment\\s*package',
        'double\\s*your\\s*(?:money|investment|crypto)',
      ].join('|'),
      'i',
    ),
  },
  cred_field: {
    weight: 1,
    pattern: /type=["']password["']|FIELD[^\n]*password|cardpin|card_pin|\bcvv\b|\botp\b|\bpin\s*code\b/i,
  },
};

/** Real web3 code. Its absence next to wallet branding is the tell. */
const WEB3_API = /window\.ethereum|eth_requestAccounts|personal_sign|wagmi|viem|ethers\.|@solana\/web3/i;
const BRANDS =
  /metamask|trust\s*wallet|walletconnect|phantom\s*wallet|coinbase\s*wallet|ledger\s*live|trezor|exodus\s*wallet|safepal/gi;

/**
 * The priority lane shares the acquisition vocabulary in config — the words
 * that make a name worth a request are the words that make it worth a second
 * look. It reads the repo name as well as the host: a repo called
 * `metamask-recovery-portal` whose homepage points at `neutral-name.vercel.app`
 * is exactly the case a host-only test misses. It reads the label rather than
 * the host, so `account.github.io/wallet-restore` matches on the path — where
 * a github.io project page keeps its actual name.
 */
const lureLane = (label: string, repo: string) => looksLikeLure(`${label} ${repo}`);

/** Union of every rule, used to pick the evidence lines that go in the dossier. */
export const ANY_RULE = new RegExp(
  Object.values(RULES)
    .map((r) => r.pattern.source)
    .join('|'),
  'i',
);

export function classify(dossier: Dossier): Classification {
  const text = dossier.corpus;
  const hits: RuleHits = {};
  let score = 0;

  for (const [name, rule] of Object.entries(RULES)) {
    const matches = [...text.matchAll(new RegExp(rule.pattern.source, 'gi'))];
    if (!matches.length) continue;
    hits[name] = [...new Set(matches.map((m) => m[0].slice(0, 60)))].sort().slice(0, 8);
    score += rule.weight;
  }

  // A wallet *picker* — several brands side by side — with no actual web3 code
  // behind it is the drainer shape. One stray brand string is not.
  const brands = new Set([...text.matchAll(BRANDS)].map((m) => m[0].toLowerCase().replace(/\s+/g, '')));
  if (brands.size >= 2 && !WEB3_API.test(text)) {
    hits.fake_wallet_picker = [`${brands.size} brands, no web3 API`];
    score += 3;
  }

  const lanes: Classification['lanes'] = [];
  if (lureLane(dossier.site.label, dossier.site.repo)) lanes.push('hostname');
  if (score >= CONTENT_SCORE_THRESHOLD) lanes.push('content');

  return { score, hits, lanes };
}
