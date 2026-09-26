"use client";

// Streams the phone's mic to Deepgram and turns its results into finished
// utterances, one per speaker turn.

export interface Utterance {
  speaker: number;
  text: string;
}

export interface ListenerCallbacks {
  onInterim: (speaker: number, text: string) => void;
  onUtterance: (u: Utterance) => void;
  onStatus: (status: "connecting" | "live" | "reconnecting" | "stopped" | "error", detail?: string) => void;
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

/** Group consecutive words by speaker so a turn change splits the utterance. */
function segments(words: DeepgramWord[]): Utterance[] {
  const out: Utterance[] = [];
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
  private pending: Utterance | null = null;
  private stopped = false;

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
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(e.data);
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
      this.cb.onStatus("live");
      this.keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" }));
      }, 8000);
    };
    ws.onmessage = (e) => this.handle(JSON.parse(e.data as string));
    ws.onerror = () => this.cb.onStatus("error", "Connection to Deepgram failed");
    ws.onclose = () => {
      if (this.keepAlive) clearInterval(this.keepAlive);
      this.flush();
      if (!this.stopped) {
        // Mobile networks drop sockets; reconnect with a fresh token.
        this.cb.onStatus("reconnecting");
        setTimeout(() => !this.stopped && this.connect().catch((err) => this.cb.onStatus("error", String(err))), 800);
      }
    };
  }

  private handle(msg: DeepgramResults | { type: string }) {
    if (msg.type === "UtteranceEnd") {
      this.flush();
      return;
    }
    if (msg.type !== "Results") return;
    const r = msg as DeepgramResults;
    const alt = r.channel.alternatives[0];
    if (!alt || !alt.transcript) return;

    const segs = segments(alt.words);
    if (!r.is_final) {
      const last = segs[segs.length - 1];
      if (last) this.cb.onInterim(last.speaker, (this.pending?.speaker === last.speaker ? this.pending.text + " " : "") + last.text);
      return;
    }

    for (const seg of segs) {
      if (this.pending && this.pending.speaker !== seg.speaker) this.flush();
      this.pending = this.pending ? { speaker: seg.speaker, text: this.pending.text + " " + seg.text } : { ...seg };
    }
    this.cb.onInterim(this.pending?.speaker ?? 0, this.pending?.text ?? "");
    // Check long monologues sentence by sentence instead of waiting for a pause.
    const longTurn = (this.pending?.text.split(" ").length ?? 0) > 45 && /[.!?]$/.test(this.pending?.text ?? "");
    if (r.speech_final || longTurn) this.flush();
  }

  private flush() {
    if (this.pending && this.pending.text.trim()) this.cb.onUtterance(this.pending);
    this.pending = null;
  }

  async stop() {
    this.stopped = true;
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "CloseStream" }));
    this.ws?.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => {});
    this.flush();
    this.cb.onStatus("stopped");
  }
}
