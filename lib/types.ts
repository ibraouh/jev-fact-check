// Types shared by the browser and the API routes.

// A type alias (not an interface) so it is assignable to the SDK's JSON state type.
export type TranscriptLine = {
  speaker: string;
  text: string;
};

/** One fact Claude gathered before the debate, with the quote it rests on. */
export interface PackFact {
  statement: string;
  quote: string;
  source: string;
  url: string;
}

export interface PackTopic {
  id: string;
  title: string;
  facts: PackFact[];
}

/** The evidence pack Claude builds before the debate starts. */
export interface EvidencePack {
  topic: string;
  topics: PackTopic[];
  builtAt: string;
}

export interface CheckRequest {
  utterance: string;
  speaker: string;
  recent: TranscriptLine[];
  debateTopic?: string;
  pack?: EvidencePack | null;
  deepChecks: boolean;
}

export type ClaimKind = "statistic" | "event" | "policy" | "other_fact";
export type Verdict = "supported" | "contradicted" | "misleading" | "unverified";

export interface Evidence {
  id: string;
  text: string;
  source: string;
  url: string;
  origin: "pack" | "search";
}

export interface CitedEvidence extends Evidence {
  relation: "supports" | "contradicts";
  probability: number;
}

/** Events streamed back from /api/check as newline-delimited JSON. */
export type CheckEvent =
  | { type: "no_claim"; claimProbability: number; ms: number }
  | {
      type: "claim";
      claim: string;
      kind: ClaimKind;
      claimProbability: number;
      packTopic: string | null;
      ms: number;
    }
  | {
      type: "verdict";
      verdict: Verdict;
      confidence: number;
      /** False when confidence or evidence is too weak to show a verdict. */
      confident: boolean;
      cited: CitedEvidence[];
      evidenceCount: number;
      path: "pack" | "search";
      /** True when Claude will send a "deep" event after this one. */
      deepPending: boolean;
      timings: { claimMs: number; evidenceMs: number; verdictMs: number; totalMs: number };
    }
  | {
      type: "deep";
      verdict: Verdict;
      explanation: string;
      sources: { title: string; url: string }[];
      ms: number;
    }
  | { type: "error"; stage: string; message: string };
