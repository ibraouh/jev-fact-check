# Live Fact Check

A phone web app that listens to a live debate and fact-checks claims as they're spoken.

```
mic ──► Deepgram (live transcript + who's speaking)
          │ each finished sentence, while the speaker keeps talking
          ▼
        Jev: is there a checkable claim? does it add to a claim from earlier in this turn?
             what kind? which prep topic?                                                 (~150 ms)
          │ yes
          ▼
        evidence: Claude's pre-built evidence pack ── or ── Brave live search
          ▼
        Jev: does each passage support / contradict it? overall verdict + confidence     (~150 ms)
          ▼
        card on screen  ──►  Claude double-checks numbers and unsure claims in the background
```

If a sentence adds to an earlier claim ("…and that was in 2023"), that card is re-checked with the
combined claim instead of getting a new card. There is no LLM in the live path. Claude works **before** the debate (building the evidence pack) and in
the **background** (second opinions). Jev makes every per-sentence decision. A verdict is only shown when
Jev is confident *and* a cited passage backs it; otherwise the card shows the evidence and says "Unclear".

## Get the API keys

| Variable | Where to get it |
|---|---|
| `TYPESAFE_API_KEY` | TypeSafe console (console.typesafe.ai) → API keys |
| `ANTHROPIC_API_KEY` | platform.claude.com → API keys (the account needs credits) |
| `DEEPGRAM_API_KEY` | console.deepgram.com → API Keys → Create Key → **Advanced → permission "Member"**. Member is required: the app mints short-lived browser tokens with this key. |
| `BRAVE_API_KEY` | api-dashboard.search.brave.com → subscribe to a Web Search plan → API Keys |
| `APP_PASSCODE` | Make one up. The app asks for it so strangers who find the URL can't spend your credits. |

Never commit these. Put them in Vercel's environment variables (below) or in `.env.local` for local runs.

## Deploy on Vercel

1. vercel.com/new → import this GitHub repo. The Next.js framework preset is detected automatically.
2. Before deploying, open **Environment Variables** and add all five variables above.
3. Deploy, then open the URL on your phone and enter the passcode.
4. Optional: Share → **Add to Home Screen** for a full-screen app.

The mic needs HTTPS, which Vercel provides. Building an evidence pack can take 1–3 minutes, so `/api/prep`
asks for a 300 s function limit. If your plan caps it lower, the pack build may time out; live checking is unaffected.

## Run locally

```sh
cp .env.example .env.local   # fill in the keys
npm install
npm run dev                  # http://localhost:3000
```

Phones won't allow the mic on plain `http://` over your LAN. Test the mic on the Vercel URL, or on the desktop at `localhost`.
The "Type a claim" box at the bottom of the live screen runs the same pipeline without the mic.

## Where to tune

- `lib/jev.ts` → `THRESHOLDS`: when a sentence counts as a claim, when the pack is trusted over search,
  and how confident Jev must be before a verdict is shown. These are starting guesses; tune them on real debates.
- `lib/jev.ts`: the Jev questions (claim detection and verdict wording).
- `lib/claude.ts`: the evidence-pack and double-check prompts.
- Each card shows per-stage timings (Jev · evidence · Jev · total) so you can see where the time goes.
