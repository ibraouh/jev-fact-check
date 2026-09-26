"use client";

import { useEffect, useRef, useState } from "react";
import { Listener } from "@/lib/listener";
import type { CheckEvent, CitedEvidence, EvidencePack, TranscriptLine, Verdict } from "@/lib/types";

/** One speaker turn: sentences arrive one by one while they talk. */
interface Turn {
  key: string;
  speaker: number;
  sentences: string[];
  claims: Claim[];
  error?: string;
}

/** A claim card. Later sentences can extend it; each re-check bumps the version. */
interface Claim {
  id: string;
  text: string;
  version: number;
  status: "checking" | "done" | "error";
  updated?: boolean;
  verdict?: Extract<CheckEvent, { type: "verdict" }>;
  deep?: Extract<CheckEvent, { type: "deep" }>;
  deepPending?: boolean;
  error?: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const store = {
  get(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

export default function DebateApp() {
  const [passcode, setPasscode] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [setup, setSetup] = useState({ topic: "", nameA: "", nameB: "", deepChecks: true });
  const [pack, setPack] = useState<EvidencePack | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);

  useEffect(() => {
    setPasscode(store.get("passcode") ?? "");
    const saved = store.get("setup");
    if (saved) setSetup((s) => ({ ...s, ...JSON.parse(saved) }));
    const savedPack = store.get("pack");
    if (savedPack) setPack(JSON.parse(savedPack));
  }, []);

  if (passcode === null) return null;
  if (!passcode) return <PasscodeGate onUnlock={(p) => (store.set("passcode", p), setPasscode(p))} />;

  const api = async (path: string, body: unknown) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-app-passcode": passcode },
      body: JSON.stringify(body),
    });
    // Passcode was changed on the server: ask for the new one.
    if (res.status === 401) {
      store.set("passcode", "");
      setPasscode("");
    }
    return res;
  };

  if (live) {
    return <LiveScreen api={api} setup={setup} pack={pack} audioCtx={audioCtx.current} onExit={() => setLive(false)} />;
  }
  return (
    <SetupScreen
      api={api}
      setup={setup}
      setSetup={(s) => (setSetup(s), store.set("setup", JSON.stringify(s)))}
      pack={pack}
      setPack={(p) => (setPack(p), p ? store.set("pack", JSON.stringify(p)) : store.set("pack", ""))}
      onStart={() => {
        audioCtx.current = Listener.unlockAudio();
        setLive(true);
      }}
    />
  );
}

type Api = (path: string, body: unknown) => Promise<Response>;
type Setup = { topic: string; nameA: string; nameB: string; deepChecks: boolean };

function PasscodeGate({ onUnlock }: { onUnlock: (p: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const res = await fetch("/api/verify-passcode", { method: "POST", headers: { "x-app-passcode": value } });
    if (res.ok) onUnlock(value);
    else setError(((await res.json()) as { error: string }).error);
  };
  return (
    <form className="screen" onSubmit={submit}>
      <h1 className="title">Live Fact Check</h1>
      <p className="subtitle">Enter the app passcode to continue.</p>
      <div className="field">
        <label htmlFor="pc">Passcode</label>
        <input id="pc" className="input" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
      </div>
      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary btn-big" disabled={!value}>
        Unlock
      </button>
    </form>
  );
}

function SetupScreen(props: {
  api: Api;
  setup: Setup;
  setSetup: (s: Setup) => void;
  pack: EvidencePack | null;
  setPack: (p: EvidencePack | null) => void;
  onStart: () => void;
}) {
  const { setup, setSetup, pack } = props;
  const [prepping, setPrepping] = useState(false);
  const [prepError, setPrepError] = useState("");
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!prepping) return;
    const start = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [prepping]);

  const prep = async () => {
    setPrepping(true);
    setPrepError("");
    try {
      const res = await props.api("/api/prep", {
        topic: setup.topic,
        sides: [setup.nameA, setup.nameB].filter(Boolean).join(" vs "),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      props.setPack(body as EvidencePack);
    } catch (err) {
      setPrepError(err instanceof Error ? err.message : String(err));
    } finally {
      setPrepping(false);
    }
  };

  const packMatches = pack && pack.topic === setup.topic.trim();

  return (
    <div className="screen">
      <h1 className="title">Live Fact Check</h1>
      <p className="subtitle">Listens to your debate and checks factual claims as they're made.</p>

      <div className="field">
        <label htmlFor="topic">Debate topic</label>
        <input
          id="topic"
          className="input"
          placeholder="e.g. Is remote work good for the economy?"
          value={setup.topic}
          onChange={(e) => setSetup({ ...setup, topic: e.target.value })}
        />
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor="a">Speaker 1</label>
          <input id="a" className="input" placeholder="You" value={setup.nameA} onChange={(e) => setSetup({ ...setup, nameA: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="b">Speaker 2</label>
          <input id="b" className="input" placeholder="Opponent" value={setup.nameB} onChange={(e) => setSetup({ ...setup, nameB: e.target.value })} />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <strong>Evidence pack</strong>
        <p className="hint" style={{ margin: "4px 0 10px" }}>
          Optional. Claude researches the topic now so claims it covers get checked in about half a second, with no live search.
        </p>
        {packMatches ? (
          <p className="hint" style={{ margin: "0 0 10px" }}>
            ✓ Ready: {plural(pack.topics.length, "topic")}, {plural(pack.topics.reduce((n, t) => n + t.facts.length, 0), "fact")}
          </p>
        ) : null}
        <button className="btn" style={{ width: "100%" }} onClick={prep} disabled={prepping || !setup.topic.trim()}>
          {prepping ? (
            <>
              <span className="spinner" /> Researching… {elapsed}s
            </>
          ) : packMatches ? (
            "Rebuild evidence pack"
          ) : (
            "Build evidence pack (1–3 min)"
          )}
        </button>
        {prepError && <p className="error">{prepError}</p>}
      </div>

      <label className="toggle">
        <span>
          Claude double-checks
          <small>Numbers and uncertain claims get a second look a few seconds later</small>
        </span>
        <input type="checkbox" checked={setup.deepChecks} onChange={(e) => setSetup({ ...setup, deepChecks: e.target.checked })} />
      </label>

      <div className="spacer" />
      <p className="hint" style={{ textAlign: "center" }}>
        Put the phone between both speakers. Let the other person know it's listening.
      </p>
      <button className="btn btn-primary btn-big" onClick={props.onStart}>
        🎙 Start listening
      </button>
    </div>
  );
}

function LiveScreen(props: {
  api: Api;
  setup: Setup;
  pack: EvidencePack | null;
  audioCtx: AudioContext | null;
  onExit: () => void;
}) {
  const { api, setup } = props;
  const pack = props.pack && props.pack.topic === setup.topic.trim() ? props.pack : null;
  const [turns, setTurns] = useState<Turn[]>([]);
  const [interim, setInterim] = useState<{ speaker: number; text: string } | null>(null);
  const [status, setStatus] = useState<string>("connecting");
  const [statusDetail, setStatusDetail] = useState("");
  const [claimsOnly, setClaimsOnly] = useState(false);
  const [swapped, setSwapped] = useState(false);
  const [typed, setTyped] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const listener = useRef<Listener | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const turnsRef = useRef<Turn[]>([]);
  const counter = useRef(0);
  turnsRef.current = turns;

  const names = [setup.nameA || "Speaker 1", setup.nameB || "Speaker 2"];
  const nameOf = (speaker: number) => {
    const i = speaker < 2 && swapped ? 1 - speaker : speaker;
    return names[i] ?? `Speaker ${i + 1}`;
  };
  const nameRef = useRef(nameOf);
  nameRef.current = nameOf;

  const patchClaim = (turnKey: string, claimId: string, patch: (c: Claim) => Claim | null) =>
    setTurns((ts) =>
      ts.map((t) => {
        if (t.key !== turnKey) return t;
        return { ...t, claims: t.claims.map((c) => (c.id === claimId ? (patch(c) ?? c) : c)) };
      }),
    );

  /** Check one finished sentence. Runs while the speaker keeps talking. */
  const check = async (turnKey: string, speaker: number, sentence: string) => {
    const all = turnsRef.current;
    const turn = all.find((t) => t.key === turnKey);
    const recent: TranscriptLine[] = all
      .flatMap((t) => t.sentences.map((s) => ({ speaker: nameRef.current(t.speaker), text: s })))
      .slice(-7, -1);
    const openClaims = (turn?.claims ?? []).map((c) => ({ id: c.id, text: c.text }));

    // The card this request owns, and which version of it. A later sentence can
    // extend the claim and re-check it; stale answers for older versions are dropped.
    let owned: { id: string; version: number } | null = null;
    const apply = (patch: (c: Claim) => Partial<Claim>) => {
      const o = owned;
      if (!o) return;
      patchClaim(turnKey, o.id, (c) => (c.version === o.version ? { ...c, ...patch(c) } : null));
    };

    try {
      const res = await api("/api/check", {
        sentence,
        speaker: nameRef.current(speaker),
        recent,
        openClaims,
        debateTopic: setup.topic,
        pack,
        deepChecks: setup.deepChecks,
      });
      if (!res.ok || !res.body) throw new Error(((await res.json()) as { error: string }).error);

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.trim()) continue;
          const ev = JSON.parse(part) as CheckEvent;
          if (ev.type === "claim") {
            if (ev.target.mode === "update") {
              const id = ev.target.claimId;
              const current = turnsRef.current.find((t) => t.key === turnKey)?.claims.find((c) => c.id === id);
              const version = (current?.version ?? 0) + 1;
              owned = { id, version };
              patchClaim(turnKey, id, () => ({ id, text: ev.claim, version, status: "checking", updated: true }));
            } else {
              const id = `c${counter.current++}`;
              owned = { id, version: 1 };
              const claim: Claim = { id, text: ev.claim, version: 1, status: "checking" };
              setTurns((ts) => ts.map((t) => (t.key === turnKey ? { ...t, claims: [...t.claims, claim] } : t)));
            }
          } else if (ev.type === "verdict") apply(() => ({ status: "done", verdict: ev, deepPending: ev.deepPending }));
          else if (ev.type === "deep") apply(() => ({ deep: ev, deepPending: false }));
          else if (ev.type === "error") {
            if (owned) apply(() => ({ status: "error", error: ev.message, deepPending: false }));
            else setTurns((ts) => ts.map((t) => (t.key === turnKey ? { ...t, error: ev.message } : t)));
          }
        }
      }
      apply(() => ({ deepPending: false }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (owned) apply(() => ({ status: "error", error: message, deepPending: false }));
      else setTurns((ts) => ts.map((t) => (t.key === turnKey ? { ...t, error: message } : t)));
    }
  };
  const checkRef = useRef(check);
  checkRef.current = check;

  /** Add a finished sentence to its turn (creating the turn if new) and check it. */
  const addSentence = (turnKey: string, speaker: number, text: string) => {
    const exists = turnsRef.current.some((t) => t.key === turnKey);
    const next = exists
      ? turnsRef.current.map((t) => (t.key === turnKey ? { ...t, sentences: [...t.sentences, text] } : t))
      : [...turnsRef.current, { key: turnKey, speaker, sentences: [text], claims: [] }];
    turnsRef.current = next; // so the check below sees this turn immediately
    setTurns(next);
    void checkRef.current(turnKey, speaker, text);
  };
  const addRef = useRef(addSentence);
  addRef.current = addSentence;

  // Start the mic. The tap on "Start listening" already unlocked audio for iOS.
  useEffect(() => {
    const l = new Listener(
      async () => {
        const res = await api("/api/deepgram-token", {});
        const body = await res.json();
        if (!res.ok) throw new Error(body.error);
        return body.token as string;
      },
      {
        onInterim: (speaker, text) => setInterim(text ? { speaker, text } : null),
        onSentence: (s) => addRef.current(`m${s.turn}`, s.speaker, s.text),
        onStatus: (s, detail) => {
          setStatus(s);
          setStatusDetail(detail ?? "");
        },
      },
      props.audioCtx ?? undefined,
    );
    listener.current = l;
    l.start().catch((err) => {
      setStatus("error");
      setStatusDetail(err instanceof Error ? err.message : String(err));
    });
    return () => void l.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the screen awake while listening.
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const acquire = async () => {
      try {
        lock = await navigator.wakeLock?.request("screen");
      } catch {}
    };
    const onVisible = () => document.visibilityState === "visible" && acquire();
    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release();
    };
  }, []);

  // The bottom bar's height varies (safe area, wrapping); pad the feed by the real
  // height so the newest card is never hidden behind it.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const ro = new ResizeObserver(() =>
      document.documentElement.style.setProperty("--bar-h", `${bar.getBoundingClientRect().height}px`),
    );
    ro.observe(bar);
    return () => ro.disconnect();
  }, []);

  // Follow new text unless the user scrolled up to read something.
  useEffect(() => {
    const onScroll = () => setAtBottom(window.innerHeight + window.scrollY >= document.body.scrollHeight - 80);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (atBottom) window.scrollTo({ top: document.body.scrollHeight });
  }, [turns, interim, atBottom]);

  const paused = status === "paused";
  const ended = status === "stopped";
  const togglePause = () => (paused ? listener.current?.resume() : listener.current?.pause());
  const end = async () => {
    await listener.current?.stop();
    setInterim(null);
  };

  const visible = claimsOnly ? turns.filter((t) => t.claims.length > 0) : turns;
  const dotClass =
    status === "live" ? "dot live" : status === "reconnecting" || status === "connecting" || paused ? "dot warn" : "dot";
  const statusText =
    ({ live: "Listening", connecting: "Connecting…", reconnecting: "Reconnecting…", paused: "Paused", error: "Mic error", stopped: "Ended" } as Record<string, string>)[status] ??
    status;

  return (
    <div className="screen">
      <header className="live-header">
        <span className="status">
          <span className={dotClass} /> {statusText}
        </span>
        <span className="spacer" />
        <button className="chip" aria-pressed={claimsOnly} onClick={() => setClaimsOnly((v) => !v)}>
          Claims only
        </button>
        <button className="chip" onClick={() => setSwapped((v) => !v)} title="Swap speaker names">
          ⇄ Names
        </button>
      </header>

      {status === "error" && <p className="error">{statusDetail || "Something went wrong with the microphone."}</p>}

      <main className="feed" aria-live="polite">
        {visible.length === 0 && !interim && (
          <p className="hint" style={{ textAlign: "center", marginTop: 40 }}>
            Start talking. Each factual claim gets a card as soon as the sentence ends{pack ? " (evidence pack loaded)" : ""}.
          </p>
        )}
        {visible.map((t) => (
          <TurnView key={t.key} turn={t} name={nameOf(t.speaker)} />
        ))}
        {interim && (
          <div className="line interim">
            <span className="speaker" style={{ color: `var(--speaker-${interim.speaker % 3})` }}>
              {nameOf(interim.speaker)}
            </span>
            <span className="line-text">{interim.text}</span>
          </div>
        )}
      </main>

      {!atBottom && (
        <button className="chip jump" onClick={() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })}>
          ↓ Latest
        </button>
      )}

      <div className="bottom-bar" ref={barRef}>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            const text = typed.trim();
            if (text) addSentence(`t${counter.current++}`, 0, text);
            setTyped("");
          }}
        >
          <input className="input" placeholder={`Type a claim as ${nameOf(0)}…`} value={typed} onChange={(e) => setTyped(e.target.value)} />
          <button className="btn" disabled={!typed.trim()} aria-label="Check typed claim">
            Check
          </button>
        </form>
        <div className="bottom-bar-inner">
          {ended ? (
            <button className="btn btn-primary btn-big" onClick={props.onExit}>
              New debate
            </button>
          ) : (
            <>
              <button className="btn btn-big" onClick={togglePause} disabled={status === "error" || status === "connecting"}>
                {paused ? "▶ Resume" : "❚❚ Pause"}
              </button>
              <button className="btn btn-danger btn-big" onClick={end}>
                ■ End
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TurnView({ turn, name }: { turn: Turn; name: string }) {
  return (
    <div className={`line ${turn.claims.length === 0 ? "dim" : ""}`}>
      <span className="speaker" style={{ color: `var(--speaker-${turn.speaker % 3})` }}>
        {name}
      </span>
      <span className="line-text">{turn.sentences.join(" ")}</span>
      {turn.claims.map((c) => (
        <ClaimCard key={c.id} claim={c} />
      ))}
      {turn.error && <p className="meta">Couldn't check: {turn.error}</p>}
    </div>
  );
}

const VERDICT_UI: Record<Verdict | "unclear" | "checking", { label: string; icon: string; cls: string }> = {
  supported: { label: "TRUE", icon: "✓", cls: "supported" },
  contradicted: { label: "FALSE", icon: "✗", cls: "contradicted" },
  misleading: { label: "MISLEADING", icon: "!", cls: "misleading" },
  unverified: { label: "UNVERIFIED", icon: "?", cls: "unclear" },
  unclear: { label: "UNCLEAR", icon: "?", cls: "unclear" },
  checking: { label: "CHECKING", icon: "", cls: "checking" },
};

function ClaimCard({ claim }: { claim: Claim }) {
  if (claim.status === "error") {
    return (
      <div className="verdict-card unclear">
        <span className="claim-text">“{claim.text}”</span>
        <span className="meta">Couldn't check: {claim.error}</span>
      </div>
    );
  }

  const v = claim.verdict;
  const deep = claim.deep;
  // The banner shows the best answer available: Jev when it's confident, else
  // Claude's second opinion. While Claude works, Jev's lean shows right away.
  let shown: keyof typeof VERDICT_UI = "checking";
  let by = "";
  let leaning = false;
  if (claim.status === "done" && v) {
    const jevPct = `${Math.round(v.confidence * 100)}%`;
    if (v.confident) {
      shown = v.verdict;
      by = `Jev · ${jevPct}`;
      // Claude's second opinion on numbers can overrule; make a disagreement visible.
      if (deep && deep.verdict !== v.verdict) by += ` · ⚠ Claude says ${VERDICT_UI[deep.verdict].label.toLowerCase()}`;
    } else if (deep) {
      shown = deep.verdict === "unverified" ? "unclear" : deep.verdict;
      by = `Claude · Jev leaned ${VERDICT_UI[v.verdict].label.toLowerCase()}`;
    } else if (v.verdict !== "unverified") {
      shown = v.verdict;
      leaning = true;
      by = `Jev · ${jevPct}`;
    } else {
      shown = "unclear";
      by = "Jev found no clear evidence";
    }
  }
  const ui = VERDICT_UI[shown];
  const disagrees = v?.confident && deep && deep.verdict !== v.verdict;

  return (
    <div className={`verdict-card ${leaning ? "unclear" : ui.cls}`}>
      <div className={`verdict-banner ${leaning ? `leaning ${ui.cls}` : ""}`}>
        {shown === "checking" ? <span className="spinner big" /> : <span className="verdict-icon">{ui.icon}</span>}
        <span className="verdict-label">{leaning ? `LEANING ${ui.label}` : ui.label}</span>
        {by && <span className="verdict-by">{by}</span>}
      </div>
      <span className="claim-text">
        “{claim.text}”{claim.updated && <span className="updated"> · updated</span>}
      </span>

      {v?.cited.slice(0, 3).map((c) => <SourceRow key={c.id} c={c} />)}

      {deep && (
        <details className="src">
          <summary>
            <span className={`rel ${deep.verdict}`}>Claude</span> {deep.explanation}
          </summary>
          <div className="src-body">
            {disagrees && <p style={{ margin: "0 0 6px" }}>Claude disagrees with Jev: {VERDICT_UI[deep.verdict].label}.</p>}
            <p style={{ margin: "0 0 6px" }}>{deep.explanation}</p>
            {deep.sources.slice(0, 3).map((s) => (
              <div key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.title} ↗
                </a>
              </div>
            ))}
            <div className="meta">Claude {(deep.ms / 1000).toFixed(1)}s</div>
          </div>
        </details>
      )}
      {claim.deepPending && (
        <span className="meta" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="spinner" /> Claude double-checking…
        </span>
      )}
      {v && (
        <span className="meta">
          {v.path === "pack" ? "Evidence pack" : "Live search"} · {v.timings.totalMs}ms (Jev {v.timings.claimMs} · evidence {v.timings.evidenceMs} · Jev{" "}
          {v.timings.verdictMs})
        </span>
      )}
    </div>
  );
}

/** One line per source; tap to expand the passage and link. */
function SourceRow({ c }: { c: CitedEvidence }) {
  return (
    <details className="src">
      <summary>
        <span className={`rel ${c.relation === "supports" ? "supported" : "contradicted"}`}>{c.relation === "supports" ? "✓" : "✗"}</span>{" "}
        <strong>{c.source}</strong> — {c.text}
      </summary>
      <div className="src-body">
        <p style={{ margin: "0 0 6px" }}>{c.text}</p>
        <a href={c.url} target="_blank" rel="noreferrer">
          Open source ↗
        </a>
      </div>
    </details>
  );
}
