"use client";

// Streams the phone's mic to Deepgram and emits each sentence the moment it is
// finished, so checks start while the speaker is still talking.

export interface Sentence {
  speaker: number;
  text: string;
  /** Increments on every speaker change or pause; sentences in one turn share it. */
  turn: number;
}

export interface ListenerCallbacks {
  /** Words heard in the current turn that don't form a finished sentence yet. */
  onInterim: (speaker: number, text: string) => void;
  onSentence: (s: Sentence) => void;
  onStatus: (status: "connecting" | "live" | "paused" | "reconnecting" | "stopped" | "error", detail?: string) => void;
}

interface DeepgramWord {
  word: string;
  punctuated_word?: string;
  speaker?: number;
}

interface DeepgramResults {
  type: "Results";
  is_final?: boolean;
  speech_final?: boolean;
  channel: { alternatives: { transcript: string; words: DeepgramWord[] }[] };
}

const DEEPGRAM_URL =
  "wss://api.deepgram.com/v1/listen?" +
  new URLSearchParams({
    model: "nova-3",
    language: "en",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
    diarize: "true",
    endpointing: "400",
    utterance_end_ms: "1200",
    vad_events: "true",
  }).toString();

// "U.S." or "Dr." end in a period but don't end a sentence.
const ABBREVIATION = /(?:\b(?:[A-Z]\.){2,}|\b(?:Mr|Mrs|Ms|Dr|St|vs|etc|approx|No|Jr|Sr)\.)$/;

/** Splits off every finished sentence; returns them plus the unfinished rest. */
function takeSentences(text: string): { done: string[]; rest: string } {
  const done: string[] = [];
  let start = 0;
  const re = /[.!?]+(?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    const candidate = text.slice(start, end).trim();
    if (ABBREVIATION.test(candidate)) continue;
    if (candidate) done.push(candidate);
    start = end;
  }
  return { done, rest: text.slice(start).trim() };
}

/** Group consecutive words by speaker so a turn change splits the text. */
function segments(words: DeepgramWord[]): { speaker: number; text: string }[] {
  const out: { speaker: number; text: string }[] = [];
  for (const w of words) {
    const speaker = w.speaker ?? 0;
    const text = w.punctuated_word ?? w.word;
    const last = out[out.length - 1];
    if (last && last.speaker === speaker) last.text += " " + text;
    else out.push({ speaker, text });
  }
  return out;
}

export class Listener {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  // Finalized words of the current turn that haven't completed a sentence yet.
  private pending: { speaker: number; text: string } | null = null;
  private turn = 0;
  private stopped = false;
  private paused = false;

  constructor(
    private getToken: () => Promise<string>,
    private cb: ListenerCallbacks,
    ctx?: AudioContext,
  ) {
    this.ctx = ctx ?? null;
  }

  /** Create the AudioContext inside the tap handler: iOS only starts audio on a user gesture. */
  static unlockAudio(): AudioContext {
    const ctx = new AudioContext();
    void ctx.resume();
    return ctx;
  }

  async start() {
    this.stopped = false;
    this.cb.onStatus("connecting");
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (!this.ctx || this.ctx.state === "closed") this.ctx = new AudioContext();
    await this.ctx.resume();
    await this.ctx.audioWorklet.addModule("/pcm-worklet.js");
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm-worklet");
    this.node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (!this.paused && this.ws?.readyState === WebSocket.OPEN) this.ws.send(e.data);
    };
    source.connect(this.node);
    await this.connect();
  }

  private async connect() {
    const token = await this.getToken();
    // Browsers can't set headers on a WebSocket; Deepgram takes the token as a subprotocol.
    const ws = new WebSocket(DEEPGRAM_URL, ["bearer", token]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.cb.onStatus(this.paused ? "paused" : "live");
      this.keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
      }, 8000);
    };
    ws.onmessage = (e) => this.handle(JSON.parse(e.data as string));
    ws.onerror = () => this.cb.onStatus("error", "Connection to Deepgram failed");
    ws.onclose = () => {
      if (this.keepAlive) clearInterval(this.keepAlive);
      this.endTurn();
      if (!this.stopped) {
        // Mobile networks drop sockets; reconnect with a fresh token.
        this.cb.onStatus("reconnecting");
        setTimeout(() => !this.stopped && this.connect().catch((err) => this.cb.onStatus("error", String(err))), 800);
      }
    };
  }

  private handle(msg: DeepgramResults | { type: string }) {
    if (msg.type === "UtteranceEnd") {
      this.endTurn();
      return;
    }
    if (msg.type !== "Results" || this.paused) return;
    const r = msg as DeepgramResults;
    const alt = r.channel.alternatives[0];
    if (!alt || !alt.transcript) return;

    const segs = segments(alt.words);
    if (!r.is_final) {
      const last = segs[segs.length - 1];
      if (last) {
        const before = this.pending?.speaker === last.speaker ? this.pending.text + " " : "";
        this.cb.onInterim(last.speaker, before + last.text);
      }
      return;
    }

    for (const seg of segs) {
      if (this.pending && this.pending.speaker !== seg.speaker) this.endTurn();
      const text = this.pending ? `${this.pending.text} ${seg.text}` : seg.text;
      // Emit every finished sentence right away; keep the unfinished tail.
      const { done, rest } = takeSentences(text);
      for (const sentence of done) this.cb.onSentence({ speaker: seg.speaker, text: sentence, turn: this.turn });
      this.pending = { speaker: seg.speaker, text: rest };
    }
    this.cb.onInterim(this.pending?.speaker ?? 0, this.pending?.text ?? "");
    if (r.speech_final) this.endTurn();
  }

  /** A pause or speaker change: send any unfinished words as a last sentence. */
  private endTurn() {
    if (this.pending?.text.trim()) {
      this.cb.onSentence({ speaker: this.pending.speaker, text: this.pending.text.trim(), turn: this.turn });
    }
    if (this.pending) this.turn++;
    this.pending = null;
    this.cb.onInterim(0, "");
  }

  /** Stops sending audio but keeps the connection (and the screen) as they are. */
  pause() {
    this.endTurn();
    this.paused = true;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = false));
    this.cb.onStatus("paused");
  }

  resume() {
    this.paused = false;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = true));
    this.cb.onStatus(this.ws?.readyState === WebSocket.OPEN ? "live" : "reconnecting");
  }

  async stop() {
    this.stopped = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "CloseStream" }));
    this.ws?.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => {});
    this.endTurn();
    this.cb.onStatus("stopped");
  }
}
