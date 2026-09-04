class RadioCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const configuredFrameMs = Number(options?.processorOptions?.frameMs);
    const frameMs =
      Number.isFinite(configuredFrameMs) && configuredFrameMs > 0 ? configuredFrameMs : 20;
    this.frameSamples = Math.max(128, Math.round((sampleRate * frameMs) / 1000));
    this.frame = new Float32Array(this.frameSamples);
    this.frameOffset = 0;
    this.frameSquareSum = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (output) {
      output.fill(0);
    }
    if (!input || input.length === 0) return true;

    let inputOffset = 0;
    while (inputOffset < input.length) {
      const copyCount = Math.min(input.length - inputOffset, this.frameSamples - this.frameOffset);
      const copyEnd = inputOffset + copyCount;
      for (; inputOffset < copyEnd; inputOffset += 1) {
        const sample = Math.max(-1, Math.min(1, input[inputOffset] || 0));
        this.frame[this.frameOffset] = sample;
        this.frameOffset += 1;
        this.frameSquareSum += sample * sample;
      }

      if (this.frameOffset === this.frameSamples) {
        const pcm = this.frame;
        const level = Math.sqrt(this.frameSquareSum / this.frameSamples);
        this.frame = new Float32Array(this.frameSamples);
        this.frameOffset = 0;
        this.frameSquareSum = 0;
        this.port.postMessage({ type: "chunk", pcm, level }, [pcm.buffer]);
      }
    }
    return true;
  }
}

registerProcessor("radio-capture-processor", RadioCaptureProcessor);
