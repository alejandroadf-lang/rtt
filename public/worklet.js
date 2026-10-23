// Microphone audio, down to what speech-to-text wants: 16 kHz, mono, 16-bit.
//
// The browser captures at its own rate (44.1 or 48 kHz). Averaging the samples that
// fall in each output step is a low-pass filter as well as a decimation, which is
// what keeps the high frequencies from folding back into the speech band. Frames of
// 100 ms go to the page: small enough to stay live, large enough not to flood the
// socket.

const OUT_RATE = 16000;
const FRAME = 1600;

class Downsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / OUT_RATE;
    this.next = this.ratio;
    this.index = 0;
    this.sum = 0;
    this.count = 0;
    this.frame = new Int16Array(FRAME);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this.sum += channel[i];
      this.count += 1;
      this.index += 1;
      if (this.index >= this.next) {
        const v = Math.max(-1, Math.min(1, this.sum / this.count));
        this.frame[this.filled++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        this.sum = 0;
        this.count = 0;
        this.next += this.ratio;
        if (this.filled === FRAME) {
          const out = this.frame.buffer;
          this.port.postMessage(out, [out]);
          this.frame = new Int16Array(FRAME);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('downsampler', Downsampler);
