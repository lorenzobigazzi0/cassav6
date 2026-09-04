class RadioPlaybackProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.queue = [];
    this.current = null;
    this.currentOffset = 0;
    this.queuedSamples = 0;
    this.started = false;
    this.stopping = false;
    this.initialJitterSamples = this.normalizeSampleCount(options?.processorOptions?.jitterSamples);
    this.rebufferSamples = this.normalizeSampleCount(options?.processorOptions?.rebufferSamples);
    this.maxConcealmentSamples = this.normalizeSampleCount(
      options?.processorOptions?.concealmentSamples
    );
    this.resumeFadeSamples = this.normalizeSampleCount(
      options?.processorOptions?.resumeFadeSamples
    );
    this.requiredStartSamples = this.initialJitterSamples;
    this.lastSample = 0;
    this.concealmentStartSample = 0;
    this.concealedSamples = 0;
    this.resumeFadeRemaining = 0;
    this.resumeFadeStartSample = 0;
    this.underrunActive = false;
    this.port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "enqueue" && message.pcm instanceof Float32Array) {
        if (this.concealedSamples > 0) {
          this.resumeFadeStartSample = this.lastSample;
          this.resumeFadeRemaining = this.resumeFadeSamples;
          this.concealedSamples = 0;
          this.concealmentStartSample = 0;
        }
        this.queue.push(message.pcm);
        this.queuedSamples += message.pcm.length;
        this.stopping = false;
        this.underrunActive = false;
      } else if (message.type === "stop") {
        this.stopping = true;
      }
    };
  }

  normalizeSampleCount(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
  }

  fadeToSilence(output, startOffset) {
    const available = output.length - startOffset;
    if (available <= 0 || this.lastSample === 0) return;
    const fadeSamples = Math.min(available, Math.max(1, Math.round(sampleRate * 0.003)));
    for (let index = 0; index < fadeSamples; index += 1) {
      output[startOffset + index] = this.lastSample * (1 - (index + 1) / fadeSamples);
    }
    this.lastSample = 0;
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    output.fill(0);

    if (!this.started) {
      if (this.queuedSamples < this.requiredStartSamples && !this.stopping) return true;
      this.started = true;
      this.underrunActive = false;
    }

    let written = 0;
    while (written < output.length) {
      if (!this.current || this.currentOffset >= this.current.length) {
        this.current = this.queue.shift() || null;
        this.currentOffset = 0;
        if (!this.current) {
          if (!this.stopping) {
            if (!this.underrunActive) {
              this.underrunActive = true;
              this.port.postMessage({ type: "underrun" });
            }
            if (
              this.maxConcealmentSamples > 0 &&
              this.concealedSamples < this.maxConcealmentSamples
            ) {
              if (this.concealedSamples === 0) {
                this.concealmentStartSample = this.lastSample;
              }
              const concealedNow = Math.min(
                output.length - written,
                this.maxConcealmentSamples - this.concealedSamples
              );
              for (let index = 0; index < concealedNow; index += 1) {
                const progress = (this.concealedSamples + index + 1) / this.maxConcealmentSamples;
                output[written + index] = this.concealmentStartSample * (1 - progress);
              }
              this.concealedSamples += concealedNow;
              written += concealedNow;
              this.lastSample = output[written - 1] || 0;
              if (this.concealedSamples >= this.maxConcealmentSamples) {
                this.started = false;
                this.requiredStartSamples = this.rebufferSamples;
              }
              if (written >= output.length) break;
            }
            this.started = false;
            this.requiredStartSamples = this.rebufferSamples;
            this.fadeToSilence(output, written);
          }
          break;
        }
      }

      const available = this.current.length - this.currentOffset;
      const needed = output.length - written;
      const count = Math.min(available, needed);
      output.set(this.current.subarray(this.currentOffset, this.currentOffset + count), written);
      if (this.resumeFadeRemaining > 0) {
        const fadeCount = Math.min(count, this.resumeFadeRemaining);
        const fadeOffset = this.resumeFadeSamples - this.resumeFadeRemaining;
        for (let index = 0; index < fadeCount; index += 1) {
          const progress = (fadeOffset + index + 1) / this.resumeFadeSamples;
          const outputIndex = written + index;
          output[outputIndex] =
            this.resumeFadeStartSample * (1 - progress) + output[outputIndex] * progress;
        }
        this.resumeFadeRemaining -= fadeCount;
      }
      this.lastSample = output[written + count - 1] || 0;
      this.currentOffset += count;
      this.queuedSamples = Math.max(0, this.queuedSamples - count);
      written += count;
    }

    if (this.stopping && this.queuedSamples === 0 && !this.current) {
      this.started = false;
      this.stopping = false;
      this.requiredStartSamples = this.initialJitterSamples;
      this.lastSample = 0;
      this.concealmentStartSample = 0;
      this.concealedSamples = 0;
      this.resumeFadeRemaining = 0;
      this.resumeFadeStartSample = 0;
      this.underrunActive = false;
    }
    return true;
  }
}

registerProcessor("radio-playback-processor", RadioPlaybackProcessor);
