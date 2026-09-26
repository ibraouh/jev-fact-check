import type { Evidence } from "./types";

interface BraveResult {
  title: string;
  url: string;
  description?: string;
  extra_snippets?: string[];
  page_age?: string;
  profile?: { name?: string };
  meta_url?: { hostname?: string };
}

const stripTags = (s: string) =>
  s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&");

/** Brave web search, flattened into passages Jev can judge one by one. */
export async function searchEvidence(query: string, maxPassages = 10): Promise<Evidence[]> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error("BRAVE_API_KEY is not configured");

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query.slice(0, 380));
  url.searchParams.set("count", "8");
  url.searchParams.set("extra_snippets", "true");
  url.searchParams.set("safesearch", "moderate");

  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": key },
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`Brave search failed (${res.status})`);
  const body = (await res.json()) as { web?: { results?: BraveResult[] } };

  const passages: Evidence[] = [];
  for (const r of body.web?.results ?? []) {
    const source = r.profile?.name || r.meta_url?.hostname || new URL(r.url).hostname;
    // The description plus the first extra snippet usually carry the relevant sentence.
    const text = [r.description, ...(r.extra_snippets ?? []).slice(0, 2)]
      .filter(Boolean)
      .map((t) => stripTags(t!))
      .join(" … ");
    if (!text) continue;
    passages.push({
      id: `e${passages.length}`,
      text: r.page_age ? `(${r.page_age.slice(0, 10)}) ${r.title}: ${text}` : `${r.title}: ${text}`,
      source,
      url: r.url,
      origin: "search",
    });
    if (passages.length >= maxPassages) break;
  }
  return passages;
}
