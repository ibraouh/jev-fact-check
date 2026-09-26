import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { ClaimKind, Evidence, EvidencePack, TranscriptLine, Verdict } from "./types";

// Pin the version so tuned thresholds don't drift when the alias moves.
const MODEL = process.env.TYPESAFE_MODEL ?? "jev-1.13.0";

// Every number the pipeline reads lives here, so a policy change is one edit.
// These are starting points to tune on real debates, not measured values.
export const THRESHOLDS = {
  claimMin: 0.6, // is_claim above this -> the sentence gets checked
  packTopicMin: 0.6, // pack topic probability above this -> skip live search
  continuesMin: 0.6, // a sentence this likely to extend an earlier claim re-checks that claim
  verdictConfidenceMin: 0.75, // below this the card shows evidence, not a verdict
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
  verdict: Verdict;
  confidence: number;
  confident: boolean;
  cited: (Evidence & { relation: "supports" | "contradicts"; probability: number })[];
}

/**
 * One Jev request judges every passage against the claim, plus an overall
 * verdict across all of them. Code decides what is solid enough to show.
 */
export async function judgeClaim(input: {
  claim: string;
  speaker: string;
  recent: TranscriptLine[];
  evidence: Evidence[];
}): Promise<Judgment> {
  if (input.evidence.length === 0) {
    return { verdict: "unverified", confidence: 0, confident: false, cited: [] };
  }

  const evidence = input.evidence.map((e) => ({ id: e.id, source: e.source, text: e.text.slice(0, 700) }));
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
    overall: choice(
      "Based only on the passages in `evidence`, what is the status of the claim in `claim`? Use `recent_transcript` only to understand what the claim refers to.",
      {
        supported: "At least one passage clearly confirms the claim and none refute it",
        contradicted: "At least one passage clearly shows the claim is false or substantially wrong",
        misleading:
          "The passages show the claim is partly true, exaggerated, or technically accurate but missing important context",
        unverified: "The passages do not contain enough information to confirm or refute the claim",
      },
    ),
    ...Object.fromEntries(
      evidence.map((e, i) => [
        `rel_${i}`,
        choice(`How does the passage \`evidence[${i}].text\` relate to the claim in \`claim\`?`, relationCriteria),
      ]),
    ),
  };

  const res = await jev().systemOne({ state, questions });
  const answers = res.answers as Record<string, { choice: string; confidence: number; probabilities: Record<string, number> }>;
  const overall = answers.overall;
  const verdict = overall.choice as Verdict;

  const cited = input.evidence
    .map((e, i) => {
      const p = answers[`rel_${i}`].probabilities;
      const relation: "supports" | "contradicts" = p.contradicts > p.supports ? "contradicts" : "supports";
      return { ...e, relation, probability: p[relation] };
    })
    .filter((e) => e.probability >= THRESHOLDS.citeMin)
    .sort((x, y) => y.probability - x.probability)
    .slice(0, 3);

  // A verdict is only shown when Jev is confident AND a passage backs it up.
  const needed = verdict === "supported" ? "supports" : verdict === "contradicted" ? "contradicts" : null;
  const backed = needed === null ? cited.length > 0 : cited.some((c) => c.relation === needed);
  const confident = verdict !== "unverified" && overall.confidence >= THRESHOLDS.verdictConfidenceMin && backed;

  return { verdict, confidence: overall.confidence, confident, cited };
}
