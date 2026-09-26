"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Listener } from "@/lib/listener";
import type { CheckEvent, CitedEvidence, EvidencePack, TranscriptLine, Verdict } from "@/lib/types";

type LineStatus = "checking" | "no_claim" | "claim" | "done" | "error";

interface Line {
  id: number;
  speaker: number;
  text: string;
  status: LineStatus;
  claim?: string;
  packTopic?: string | null;
  verdict?: Extract<CheckEvent, { type: "verdict" }>;
  deep?: Extract<CheckEvent, { type: "deep" }>;
  deepPending?: boolean;
  error?: string;
}

const LABELS: Record<Verdict | "unclear", string> = {
  supported: "Supported",
  contradicted: "False",
  misleading: "Misleading",
  unverified: "Unverified",
  unclear: "Unclear",
};

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
  const [lines, setLines] = useState<Line[]>([]);
  const [interim, setInterim] = useState<{ speaker: number; text: string } | null>(null);
  const [status, setStatus] = useState<string>("idle");
  const [statusDetail, setStatusDetail] = useState("");
  const [claimsOnly, setClaimsOnly] = useState(false);
  const [swapped, setSwapped] = useState(false);
  const [typed, setTyped] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const listener = useRef<Listener | null>(null);
  const linesRef = useRef<Line[]>([]);
  const nextId = useRef(0);
  linesRef.current = lines;

  const names = [setup.nameA || "Speaker 1", setup.nameB || "Speaker 2"];
  const nameOf = useCallback(
    (speaker: number) => {
      const i = speaker < 2 && swapped ? 1 - speaker : speaker;
      return names[i] ?? `Speaker ${i + 1}`;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [swapped, setup.nameA, setup.nameB],
  );

  const update = (id: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const check = useCallback(
    async (speaker: number, text: string) => {
      const id = nextId.current++;
      const recent: TranscriptLine[] = linesRef.current.slice(-6).map((l) => ({ speaker: nameOf(l.speaker), text: l.text }));
      setLines((ls) => [...ls, { id, speaker, text, status: "checking" }]);

      try {
        const res = await api("/api/check", {
          utterance: text,
          speaker: nameOf(speaker),
          recent,
          debateTopic: setup.topic,
          pack,
          deepChecks: setup.deepChecks,
        });
        if (!res.ok || !res.body) throw new Error(((await res.json()) as { error: string }).error);

        // Read the NDJSON stream: each stage updates the card as it lands.
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
            if (ev.type === "no_claim") update(id, { status: "no_claim" });
            else if (ev.type === "claim") update(id, { status: "claim", claim: ev.claim, packTopic: ev.packTopic });
            else if (ev.type === "verdict") update(id, { status: "done", verdict: ev, deepPending: ev.deepPending });
            else if (ev.type === "deep") update(id, { deep: ev, deepPending: false });
            else if (ev.type === "error") update(id, { status: "error", error: ev.message, deepPending: false });
          }
        }
        update(id, { deepPending: false });
      } catch (err) {
        update(id, { status: "error", error: err instanceof Error ? err.message : String(err) });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, nameOf, pack, setup.topic, setup.deepChecks],
  );

  const checkRef = useRef(check);
  checkRef.current = check;

  // Start the mic. The tap on "Start listening" counts as the user gesture iOS requires.
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
        onUtterance: (u) => {
          setInterim(null);
          void checkRef.current(u.speaker, u.text);
        },
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

  // Follow new lines unless the user scrolled up to read something.
  useEffect(() => {
    const onScroll = () => setAtBottom(window.innerHeight + window.scrollY >= document.body.scrollHeight - 80);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (atBottom) window.scrollTo({ top: document.body.scrollHeight });
  }, [lines, interim, atBottom]);

  const stop = async () => {
    await listener.current?.stop();
    props.onExit();
  };

  const visible = claimsOnly ? lines.filter((l) => l.status !== "no_claim") : lines;
  const dotClass = status === "live" ? "dot live" : status === "reconnecting" || status === "connecting" ? "dot warn" : "dot";
  const statusText =
    status === "live" ? "Listening" : status === "connecting" ? "Connecting…" : status === "reconnecting" ? "Reconnecting…" : status === "error" ? "Mic error" : "Stopped";

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
            Start talking. Factual claims will get a card{pack ? " (evidence pack loaded)" : ""}.
          </p>
        )}
        {visible.map((l) => (
          <LineView key={l.id} line={l} name={nameOf(l.speaker)} />
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

      <div className="bottom-bar">
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) void check(0, typed.trim());
            setTyped("");
          }}
        >
          <input className="input" placeholder={`Type a claim as ${nameOf(0)}…`} value={typed} onChange={(e) => setTyped(e.target.value)} />
          <button className="btn" disabled={!typed.trim()} aria-label="Check typed claim">
            Check
          </button>
        </form>
        <div className="bottom-bar-inner">
          <button className="btn btn-danger btn-big" onClick={stop}>
            ■ Stop
          </button>
        </div>
      </div>
    </div>
  );
}

function LineView({ line, name }: { line: Line; name: string }) {
  const showCard = line.status !== "no_claim";
  return (
    <div className={`line ${line.status === "no_claim" ? "dim" : ""}`}>
      <span className="speaker" style={{ color: `var(--speaker-${line.speaker % 3})` }}>
        {name}
      </span>
      <span className="line-text">{line.text}</span>
      {showCard && <VerdictCard line={line} />}
    </div>
  );
}

function VerdictCard({ line }: { line: Line }) {
  if (line.status === "checking") {
    return null; // Most lines have no claim; don't flash a card until Jev finds one.
  }
  if (line.status === "error") {
    return <p className="meta">Couldn't check: {line.error}</p>;
  }
  if (line.status === "claim") {
    return (
      <div className="verdict-card checking">
        <span className="badge checking">
          <span className="spinner" /> Checking
        </span>
        <span className="claim-text">“{line.claim}”</span>
      </div>
    );
  }

  const v = line.verdict!;
  const shown: Verdict | "unclear" = v.confident ? v.verdict : "unclear";
  const deepVerdict = line.deep?.verdict;
  const t = v.timings;

  return (
    <div className={`verdict-card ${deepVerdict && !v.confident ? deepVerdict : shown}`}>
      <span className={`badge ${shown}`}>
        {LABELS[shown]}
        {v.confident && <span style={{ fontWeight: 500 }}>{Math.round(v.confidence * 100)}%</span>}
      </span>
      <span className="claim-text">“{line.claim}”</span>
      {v.cited.slice(0, 2).map((c) => (
        <Source key={c.id} c={c} />
      ))}
      {!v.confident && v.cited.length === 0 && <span className="hint">No clear evidence found yet.</span>}
      {line.deepPending && (
        <div className="deep hint" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="spinner" /> Claude is double-checking…
        </div>
      )}
      {line.deep && (
        <div className="deep">
          <span className={`badge ${line.deep.verdict}`}>Claude: {LABELS[line.deep.verdict]}</span>
          <p style={{ margin: "6px 0 4px" }}>{line.deep.explanation}</p>
          {line.deep.sources.slice(0, 2).map((s) => (
            <div key={s.url} className="meta">
              <a href={s.url} target="_blank" rel="noreferrer">
                {s.title}
              </a>
            </div>
          ))}
          <div className="meta">Claude {(line.deep.ms / 1000).toFixed(1)}s</div>
        </div>
      )}
      <span className="meta">
        {v.path === "pack" ? "Evidence pack" : "Live search"} · Jev {t.claimMs}ms · {v.path === "pack" ? "pack" : "search"} {t.evidenceMs}ms · Jev{" "}
        {t.verdictMs}ms · <strong>{t.totalMs}ms</strong>
      </span>
    </div>
  );
}

function Source({ c }: { c: CitedEvidence }) {
  return (
    <div className="source">
      <span style={{ color: c.relation === "supports" ? "var(--ok)" : "var(--bad)", fontWeight: 700 }}>
        {c.relation === "supports" ? "Supports" : "Contradicts"}
      </span>{" "}
      ·{" "}
      <a href={c.url} target="_blank" rel="noreferrer">
        {c.source}
      </a>
      <div style={{ marginTop: 4 }}>{c.text.length > 260 ? c.text.slice(0, 260) + "…" : c.text}</div>
    </div>
  );
}
