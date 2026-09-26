import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import type { ClaimKind, Evidence, EvidencePack, Rating, TranscriptLine } from "./types";

// Pin the version so tuned thresholds don't drift when the alias moves.
const MODEL = process.env.TYPESAFE_MODEL ?? "jev-1.13.0";

// Every number the pipeline reads lives here, so a policy change is one edit.
// These are starting points to tune on real debates, not measured values.
export const THRESHOLDS = {
  claimMin: 0.6, // is_claim above this -> the sentence gets checked
  packTopicMin: 0.6, // pack topic probability above this -> skip live search
  continuesMin: 0.6, // a sentence this likely to extend an earlier claim re-checks that claim
  firmMin: 0.7, // truth-scale mass on one side needed for a firm rating; below it the card says "leaning"
  hasEvidenceMin: 0.5, // below this (and nothing citable) the rating is "no evidence"
  misleadingMin: 0.6, // misleading probability that overrides a true-ish rating
  citeMin: 0.6, // a passage must support/contradict at least this strongly to be cited
};

let client: TypeSafeClient | null = null;
const jev = () => (client ??= new TypeSafeClient({ defaultModel: MODEL, timeout: 5000 }));

export interface OpenClaim {
  id: string;
  text: string;
}

export interface ClaimDetection {
  /** "update" when the sentence adds to a claim already on screen, which is then re-checked. */
  target: { mode: "new" } | { mode: "update"; claimId: string } | { mode: "none" };
  claimProbability: number;
  claim: string;
  kind: ClaimKind;
  packTopicId: string | null;
}

/**
 * One Jev request per finished sentence, sent while the speaker is still
 * talking. All questions share the same state and run in parallel; code
 * only reads the ones that apply.
 */
export async function detectClaim(input: {
  sentence: string;
  speaker: string;
  recent: TranscriptLine[];
  openClaims: OpenClaim[];
  debateTopic?: string;
  pack?: EvidencePack | null;
}): Promise<ClaimDetection> {
  const topics = input.pack?.topics ?? [];
  const openClaims = input.openClaims.slice(-4);

  const state = {
    debate_topic: input.debateTopic || "unspecified",
    speaker: input.speaker,
    sentence: input.sentence,
    open_claims: openClaims.map((c) => c.text),
    recent_transcript: input.recent.slice(-6),
  };

  const questions = {
    is_claim: noul(
      "Does `sentence` assert at least one specific factual claim that public records, statistics, official documents, or reputable reporting could confirm or refute? Use `recent_transcript` only to understand what `sentence` refers to.",
      {
        true: "Contains a concrete checkable assertion: a number or statistic, a historical event, what a law or policy does, or what a named person or organization said or did.",
        false:
          "Only opinions, value judgments, predictions, promises, questions, personal anecdotes, insults, rhetoric, filler, or statements too vague to check.",
      },
    ),
    kind: choice("What kind of factual claim does `sentence` make?", {
      statistic: "A number, percentage, amount, ranking, or change over time",
      event: "Something that happened, or something a person or organization said or did",
      policy: "What a law, rule, program, or official position says or does",
      other_fact: "Any other checkable fact",
    }),
    ...(openClaims.length > 0 && {
      continues: choice(
        "The speaker just said `sentence`. Does it add to one of the claims in `open_claims`, which the same speaker made moments earlier, by giving more detail, a number, a time frame, a qualifier, or a correction for that same claim?",
        {
          ...Object.fromEntries(openClaims.map((c, i) => [`c${i}`, `Adds to this earlier claim: ${c.text}`])),
          separate: "Makes a different point, or does not add to any of the earlier claims",
        },
      ),
    }),
    ...(topics.length > 0 && {
      pack_topic: choice(
        "Which research topic covers the factual claim in `sentence` (read together with `open_claims` if the sentence continues one of them)? Choose none if no topic covers it.",
        {
          ...Object.fromEntries(topics.map((t) => [t.id, t.title])),
          none: "None of these topics covers the claim",
        },
      ),
    }),
  };

  const res = await jev().systemOne({ state, questions });
  const a = res.answers;

  const claimProbability = a.is_claim.noul;
  let packTopicId: string | null = null;
  if ("pack_topic" in a && a.pack_topic) {
    const pick = a.pack_topic.choice as string;
    const p = (a.pack_topic.probabilities as Record<string, number>)[pick];
    if (pick !== "none" && p >= THRESHOLDS.packTopicMin) packTopicId = pick;
  }

  // A sentence that extends an earlier claim re-checks the combined claim, even
  // when it isn't checkable on its own ("...and that was just last year").
  if ("continues" in a && a.continues) {
    const pick = a.continues.choice as string;
    const p = (a.continues.probabilities as Record<string, number>)[pick];
    if (pick !== "separate" && p >= THRESHOLDS.continuesMin) {
      const earlier = openClaims[Number(pick.slice(1))];
      return {
        target: { mode: "update", claimId: earlier.id },
        claimProbability,
        claim: `${earlier.text} ${input.sentence}`,
        kind: a.kind.choice,
        packTopicId,
      };
    }
  }

  return {
    target: claimProbability >= THRESHOLDS.claimMin ? { mode: "new" } : { mode: "none" },
    claimProbability,
    claim: input.sentence,
    kind: a.kind.choice,
    packTopicId,
  };
}

export interface Judgment {
  rating: Rating;
  /** Probability-weighted position on the truth scale, 0 (false) to 1 (true). */
  truth: number;
  /** False for "leaning" ratings, where Jev's probability is spread across the scale. */
  firm: boolean;
  cited: (Evidence & { relation: "supports" | "contradicts"; probability: number })[];
}

// Ordered truth levels, PolitiFact style. Each level describes a concrete situation.
const TRUTH_LEVELS = [
  "False: the passages show the claim is wrong",
  "Mostly false: the claim contains a grain of truth, but the passages show it is substantially wrong or greatly exaggerated",
  "Half true: the passages show the claim is partly accurate but leaves out important details or mixes accurate and inaccurate parts",
  "Mostly true: the passages confirm the claim, but it needs a minor clarification or a figure is slightly off",
  "True: the passages confirm the claim is accurate, with nothing significant missing",
] as const;

/**
 * One Jev request judges the claim on a five-level truth scale, checks
 * separately whether the evidence is relevant at all and whether the claim is
 * misleading, and rates every passage for citing. Code turns the
 * probabilities into a rating.
 */
export async function judgeClaim(input: {
  claim: string;
  speaker: string;
  recent: TranscriptLine[];
  evidence: Evidence[];
}): Promise<Judgment> {
  if (input.evidence.length === 0) {
    return { rating: "no_evidence", truth: 0.5, firm: false, cited: [] };
  }

  const evidence = input.evidence.map((e) => ({ id: e.id, source: e.source, text: e.text.slice(0, 1000) }));
  const state = {
    claim: input.claim,
    speaker: input.speaker,
    recent_transcript: input.recent.slice(-4),
    evidence,
  };

  const relationCriteria = {
    supports: "The passage states something that confirms the claim",
    contradicts: "The passage states something showing the claim is false or substantially wrong",
    unrelated:
      "The passage does not address this specific claim, or mentions the topic without confirming or refuting it",
  };

  const questions = {
    truth: score(
      "Based only on the passages in `evidence`, how accurate is the claim in `claim`? Use `recent_transcript` only to understand what the claim refers to.",
      TRUTH_LEVELS,
    ),
    has_evidence: noul(
      "Do the passages in `evidence` contain information that directly shows whether the claim in `claim` is accurate?",
      {
        true: "At least one passage directly addresses the specific fact, figure, or event in the claim",
        false: "The passages are only loosely related to the topic and don't address the specific claim",
      },
    ),
    misleading: noul(
      "According to the passages in `evidence`, would the claim in `claim` leave a listener with a false impression even if its literal wording is accurate, for example through a cherry-picked time window, a misleading comparison, or missing context that reverses its meaning?",
    ),
    ...Object.fromEntries(
      evidence.map((e, i) => [
        `rel_${i}`,
        choice(`How does the passage \`evidence[${i}].text\` relate to the claim in \`claim\`?`, relationCriteria),
      ]),
    ),
  };

  const res = await jev().systemOne({ state, questions });
  const a = res.answers as unknown as Record<string, { score: number; noul: number; probabilities: Record<string, number> }>;

  const cited = input.evidence
    .map((e, i) => {
      const p = a[`rel_${i}`].probabilities;
      const relation: "supports" | "contradicts" = p.contradicts > p.supports ? "contradicts" : "supports";
      return { ...e, relation, probability: p[relation] };
    })
    .filter((e) => e.probability >= THRESHOLDS.citeMin)
    .sort((x, y) => y.probability - x.probability)
    .slice(0, 3);

  const s = a.truth.score; // 0..4
  const p = a.truth.probabilities;
  const falseSide = (p["0"] ?? 0) + (p["1"] ?? 0);
  const trueSide = (p["3"] ?? 0) + (p["4"] ?? 0);
  const half = p["2"] ?? 0;
  const truth = s / 4;

  if (a.has_evidence.noul < THRESHOLDS.hasEvidenceMin && cited.length === 0) {
    return { rating: "no_evidence", truth, firm: false, cited };
  }
  if (a.misleading.noul >= THRESHOLDS.misleadingMin && falseSide < 0.5) {
    return { rating: "misleading", truth, firm: true, cited };
  }
  // Firm when most of the probability sits on one part of the scale (false side,
  // true side, or the middle). Otherwise it's only a lean.
  if (falseSide >= THRESHOLDS.firmMin) {
    return { rating: (p["0"] ?? 0) >= (p["1"] ?? 0) ? "false" : "mostly_false", truth, firm: true, cited };
  }
  if (trueSide >= THRESHOLDS.firmMin) {
    return { rating: (p["4"] ?? 0) >= (p["3"] ?? 0) ? "true" : "mostly_true", truth, firm: true, cited };
  }
  if (half >= THRESHOLDS.firmMin) {
    return { rating: "half_true", truth, firm: true, cited };
  }
  const rating: Rating = s >= 2.5 ? "leaning_true" : s <= 1.5 ? "leaning_false" : "half_true";
  return { rating, truth, firm: false, cited };
}
