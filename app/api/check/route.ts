import { checkPasscode } from "@/lib/auth";
import { deepCheck } from "@/lib/claude";
import { detectClaim, judgeClaim } from "@/lib/jev";
import { searchEvidence } from "@/lib/search";
import type { CheckEvent, CheckRequest, Evidence } from "@/lib/types";

export const maxDuration = 60;

/**
 * The live loop for one finished sentence (sent while the speaker keeps
 * talking), streamed as NDJSON so the phone can show "checking…" the moment
 * Jev spots a claim:
 *   Jev (claim?) -> evidence pack or Brave search -> Jev (verdict) -> [Claude, in the background]
 */
export async function POST(request: Request) {
  const denied = checkPasscode(request);
  if (denied) return denied;

  const body = (await request.json()) as CheckRequest;
  const sentence = body.sentence?.trim();
  if (!sentence) return Response.json({ error: "Empty sentence" }, { status: 400 });
  body.openClaims ??= [];

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: CheckEvent) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      const started = performance.now();
      const since = (t: number) => Math.round(performance.now() - t);

      try {
        // 1. Is there a checkable claim? (Jev)
        const detection = await detectClaim({ ...body, sentence });
        const claimMs = since(started);
        if (detection.target.mode === "none") {
          send({ type: "no_claim", claimProbability: detection.claimProbability, ms: claimMs });
          return;
        }
        send({
          type: "claim",
          target: detection.target,
          claim: detection.claim,
          kind: detection.kind,
          claimProbability: detection.claimProbability,
          packTopic: body.pack?.topics.find((t) => t.id === detection.packTopicId)?.title ?? null,
          ms: claimMs,
        });

        // 2. Evidence: the pre-built pack when it covers the claim, otherwise live search.
        const evidenceStart = performance.now();
        let path: "pack" | "search" = "pack";
        let evidence: Evidence[] = [];
        let judgment = null;
        let verdictStart = evidenceStart;
        const topic = body.pack?.topics.find((t) => t.id === detection.packTopicId);

        // 3. Verdict (Jev). If the pack doesn't settle it, fall through to live search.
        if (topic) {
          evidence = topic.facts.map((f, i) => ({
            id: `p${i}`,
            text: `${f.statement} Source quote: "${f.quote}"`,
            source: f.source,
            url: f.url,
            origin: "pack",
          }));
          judgment = await judgeClaim({ ...body, claim: detection.claim, evidence });
        }
        // A pack that can't settle the claim firmly falls through to one live search.
        if (!judgment || !judgment.firm) {
          try {
            const found = await searchEvidence(detection.claim);
            verdictStart = performance.now();
            const fromSearch = await judgeClaim({ ...body, claim: detection.claim, evidence: found });
            path = "search";
            evidence = found;
            judgment = fromSearch;
          } catch (err) {
            // If search fails but the pack gave an answer, show that instead of an error.
            if (!judgment) throw err;
          }
        }
        const evidenceMs = Math.round(verdictStart - evidenceStart);

        // 4. Claude re-checks numbers and anything Jev wasn't sure about.
        const needsDeep =
          body.deepChecks &&
          (detection.kind === "statistic" || !judgment.firm || judgment.rating === "misleading");

        send({
          type: "verdict",
          rating: judgment.rating,
          truth: judgment.truth,
          firm: judgment.firm,
          cited: judgment.cited,
          evidenceCount: evidence.length,
          path,
          deepPending: needsDeep,
          timings: { claimMs, evidenceMs, verdictMs: since(verdictStart), totalMs: since(started) },
        });

        if (needsDeep) {
          const deepStart = performance.now();
          const deep = await deepCheck({ claim: detection.claim, speaker: body.speaker, recent: body.recent, evidence });
          send({ type: "deep", ...deep, ms: since(deepStart) });
        }
      } catch (err) {
        send({ type: "error", stage: "check", message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
