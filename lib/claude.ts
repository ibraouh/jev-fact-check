import Anthropic from "@anthropic-ai/sdk";
import type { Evidence, EvidencePack, PackTopic, Rating, TranscriptLine } from "./types";

const MODEL = "claude-opus-5";

let client: Anthropic | null = null;
const claude = () => (client ??= new Anthropic());

const webSearch = (maxUses: number) => ({ type: "web_search_20260209" as const, name: "web_search" as const, max_uses: maxUses });

/**
 * Runs Claude with web search until it calls `toolName`, then returns that
 * tool's input. Server-side web search can pause a turn, so this resumes it.
 */
async function runUntilSubmitted<T>(params: {
  system: string;
  prompt: string;
  tool: Anthropic.Beta.BetaTool;
  maxSearches: number;
  effort: "low" | "medium" | "high";
  maxTokens: number;
}): Promise<T> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: params.prompt }];

  for (let turn = 0; turn < 6; turn++) {
    const response = await claude().beta.messages.create({
      model: MODEL,
      max_tokens: params.maxTokens,
      system: params.system,
      thinking: { type: "adaptive" },
      output_config: { effort: params.effort },
      tools: [webSearch(params.maxSearches), params.tool],
      messages,
      // On a safety decline, the API retries on Anthropic's recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    if (response.stop_reason === "refusal") throw new Error("Claude declined this request");

    const submitted = response.content.find(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === params.tool.name,
    );
    if (submitted) return submitted.input as T;

    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "pause_turn") {
      messages.push({ role: "user", content: `Call the ${params.tool.name} tool now with what you have found.` });
    }
  }
  throw new Error(`Claude did not call ${params.tool.name}`);
}

const PACK_TOOL: Anthropic.Beta.BetaTool = {
  name: "submit_pack",
  description: "Submit the finished evidence pack.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["topics"],
    properties: {
      topics: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "facts"],
          properties: {
            title: { type: "string" },
            facts: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["statement", "quote", "source", "url"],
                properties: {
                  statement: { type: "string" },
                  quote: { type: "string" },
                  source: { type: "string" },
                  url: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
};

/** Before the debate: Claude researches the likely factual battlegrounds. */
export async function buildEvidencePack(topic: string, sides: string): Promise<EvidencePack> {
  const result = await runUntilSubmitted<{ topics: Omit<PackTopic, "id">[] }>({
    system:
      "You prepare evidence for a live fact-checker that will listen to a spoken debate. A fast classifier will later compare each spoken claim against the facts you collect, so every fact must be a precise, self-contained statement backed by a short verbatim quote from a reputable source (official statistics, government sites, major news organizations, peer-reviewed research).",
    prompt: `Debate topic: ${topic}
${sides ? `Positions / participants: ${sides}\n` : ""}
Research the factual claims most likely to come up in this debate: key statistics, recent events, what relevant laws and policies actually say, and commonly repeated claims that are false or misleading. Use web search to find current figures.

Organize the result into 6 to 10 topics, each with a short descriptive title (for example "US unemployment rate 2020-2026") and 3 to 6 facts. For each fact give:
- statement: one sentence with the specific fact, including numbers, dates, and units
- quote: a short verbatim excerpt (under 300 characters) from the source supporting it
- source: the publication or organization name
- url: the page URL

When you are done, call submit_pack.`,
    tool: PACK_TOOL,
    maxSearches: 12,
    effort: "medium",
    maxTokens: 32000,
  });

  return {
    topic,
    builtAt: new Date().toISOString(),
    topics: result.topics.slice(0, 12).map((t, i) => ({ id: `t${i}`, title: t.title, facts: t.facts.slice(0, 8) })),
  };
}

const VERDICT_TOOL: Anthropic.Beta.BetaTool = {
  name: "report_verdict",
  description: "Report the fact-check verdict.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["rating", "explanation", "sources"],
    properties: {
      rating: {
        type: "string",
        enum: ["true", "mostly_true", "half_true", "mostly_false", "false", "misleading", "no_evidence"],
      },
      explanation: { type: "string" },
      sources: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "url"],
          properties: { title: { type: "string" }, url: { type: "string" } },
        },
      },
    },
  },
};

/** The slow path: runs in the background for numbers and low-confidence claims. */
export async function deepCheck(input: {
  claim: string;
  speaker: string;
  recent: TranscriptLine[];
  /** Passages Jev already judged, so Claude can often answer without searching. */
  evidence: Evidence[];
}): Promise<{ rating: Rating; explanation: string; sources: { title: string; url: string }[] }> {
  const context = input.recent.map((l) => `${l.speaker}: ${l.text}`).join("\n");
  const passages = input.evidence
    .slice(0, 8)
    .map((e, i) => `[${i + 1}] ${e.source} (${e.url})\n${e.text.slice(0, 700)}`)
    .join("\n\n");
  return runUntilSubmitted({
    system:
      "You fact-check claims made in a live spoken debate. Be fast and precise. Do arithmetic explicitly when numbers are involved. Account for exaggeration, cherry-picked time windows, and missing context.",
    prompt: `Recent transcript:
${context}

Claim by ${input.speaker}: "${input.claim}"

Passages already retrieved for this claim:
${passages || "(none)"}

Decide from these passages if they are enough. Only use web search (one or two searches at most) if they don't settle the claim; speed matters because this is shown live. Then call report_verdict with:
- rating, on the PolitiFact scale:
  true (accurate, nothing significant missing), mostly_true (needs a minor clarification),
  half_true (partly accurate, leaves out important details), mostly_false (a grain of truth but substantially wrong),
  false (wrong), misleading (literally accurate but creates a false impression), or no_evidence (can't be determined)
- explanation: at most two short sentences a debater could glance at, including the correct figure if the claim's number is wrong
- sources: the 1-3 pages you relied on`,
    tool: VERDICT_TOOL,
    maxSearches: 2,
    effort: "low",
    maxTokens: 8000,
  });
}
