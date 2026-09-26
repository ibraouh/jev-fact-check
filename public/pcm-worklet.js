// Converts the mic's float audio (44.1/48 kHz) into 16 kHz 16-bit PCM for Deepgram.
// Raw PCM works the same on iOS Safari and Android Chrome, unlike MediaRecorder formats.
class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.chunk = new Int16Array(1600); // 100 ms at 16 kHz
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    // Average each window of input samples down to one output sample.
    while (this.pos < channel.length) {
      const start = Math.floor(this.pos);
      const end = Math.min(channel.length, Math.floor(this.pos + this.ratio));
      let sum = 0;
      for (let i = start; i < end; i++) sum += channel[i];
      const v = end > start ? sum / (end - start) : channel[start];
      const s = Math.max(-1, Math.min(1, v));
      this.chunk[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.filled === this.chunk.length) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
        this.chunk = new Int16Array(1600);
        this.filled = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= channel.length;
    return true;
  }
}

registerProcessor("pcm-worklet", PcmWorklet);
