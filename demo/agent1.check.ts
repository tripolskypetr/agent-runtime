/**
 * Post-validation of an agent-1 answer from AGENT.md sections 3 and 5: what the
 * JSON Schema cannot express. Returns a list of problems, empty when the answer
 * is consistent with the article it was produced from.
 */
export interface Agent1Claim {
  id: string;
  evidence_quote: string;
  kind: string;
  direction: string;
  falsifiable: boolean;
  expressible_on_target: boolean;
}

export interface Agent1Answer {
  verdict: string;
  claims: Agent1Claim[];
  signal: null | {
    based_on_claim_ids: string[];
    entry: unknown;
    invalidation: unknown;
  };
}

const MAX_DEPTH = 3;
const MAX_LEAVES = 8;

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
/** "84 900" and "84900" compare equal; decimal comma and point too. */
const squashNumbers = (text: string) => text.replace(/(\d)[\s ](?=\d)/g, "$1").replace(/(\d),(\d)/g, "$1.$2");

export const predicateStats = (node: unknown): { depth: number; leaves: number; numbers: number[] } => {
  if (!node || typeof node !== "object") return { depth: 0, leaves: 0, numbers: [] };
  const p = node as Record<string, unknown>;
  const children = Array.isArray(p.all) ? p.all : Array.isArray(p.any) ? p.any : p.not !== undefined ? [p.not] : null;
  if (!children) {
    return { depth: 1, leaves: 1, numbers: typeof p.value === "number" ? [p.value] : [] };
  }
  const stats = children.map(predicateStats);
  return {
    depth: 1 + Math.max(0, ...stats.map((s) => s.depth)),
    leaves: stats.reduce((sum, s) => sum + s.leaves, 0),
    numbers: stats.flatMap((s) => s.numbers),
  };
};

export const checkAgent1Answer = (answer: Agent1Answer, articleText: string): string[] => {
  const problems: string[] = [];
  const text = squash(articleText);
  const textNumbers = squashNumbers(text);

  // 1. every evidence_quote is a verbatim substring of the article
  for (const claim of answer.claims) {
    if (!text.includes(squash(claim.evidence_quote))) problems.push(`${claim.id}: evidence_quote is not a substring of the article: "${claim.evidence_quote.slice(0, 80)}"`);
  }

  if (answer.signal === null) {
    if (answer.verdict === "forecast_expressible") problems.push("verdict forecast_expressible with signal null");
    return problems;
  }
  if (answer.verdict !== "forecast_expressible") problems.push(`signal present with verdict ${answer.verdict}`);

  // 4. based_on_claim_ids reference existing forward_directional / up / falsifiable / expressible claims
  const byId = new Map(answer.claims.map((claim) => [claim.id, claim]));
  for (const id of answer.signal.based_on_claim_ids) {
    const claim = byId.get(id);
    if (!claim) {
      problems.push(`based_on_claim_ids references unknown claim ${id}`);
      continue;
    }
    if (claim.kind !== "forward_directional" || claim.direction !== "up" || !claim.falsifiable || !claim.expressible_on_target) {
      problems.push(`${id} is not a forward_directional/up/falsifiable/expressible claim (${claim.kind}/${claim.direction}/${claim.falsifiable}/${claim.expressible_on_target})`);
    }
  }

  // 3 + 5. numeric literals come from the text; depth and leaf limits
  for (const [name, node] of [["entry", answer.signal.entry], ["invalidation", answer.signal.invalidation]] as const) {
    const stats = predicateStats(node);
    if (stats.depth > MAX_DEPTH) problems.push(`${name}: depth ${stats.depth} > ${MAX_DEPTH}`);
    if (stats.leaves > MAX_LEAVES) problems.push(`${name}: ${stats.leaves} leaves > ${MAX_LEAVES}`);
    for (const value of stats.numbers) {
      if (!textNumbers.includes(String(value))) problems.push(`${name}: numeric literal ${value} does not occur in the article`);
    }
  }
  return problems;
};
