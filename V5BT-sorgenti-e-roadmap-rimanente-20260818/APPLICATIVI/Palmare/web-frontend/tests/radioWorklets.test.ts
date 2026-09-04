import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

type WorkletMessage = {
  type?: string;
  pcm?: Float32Array;
  level?: number;
};

type WorkletProcessor = {
  port: {
    onmessage: ((event: { data: WorkletMessage }) => void) | null;
    postMessage: ReturnType<typeof vi.fn>;
  };
  process: (inputs: Float32Array[][], outputs: Float32Array[][]) => boolean;
};

type WorkletProcessorConstructor = new (options?: {
  processorOptions?: Record<string, number>;
}) => WorkletProcessor;

function loadWorklet(fileName: string, workletSampleRate = 48_000) {
  let Processor: WorkletProcessorConstructor | null = null;

  class FakeAudioWorkletProcessor {
    port = {
      onmessage: null as ((event: { data: WorkletMessage }) => void) | null,
      postMessage: vi.fn(),
    };
  }

  const source = readFileSync(resolve(process.cwd(), "public", fileName), "utf8");
  vm.runInNewContext(source, {
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    Float32Array,
    Math,
    Number,
    sampleRate: workletSampleRate,
    registerProcessor: (_name: string, constructor: WorkletProcessorConstructor) => {
      Processor = constructor;
    },
  });

  if (!Processor) throw new Error(`Worklet ${fileName} non registrato.`);
  return Processor;
}

function renderQuantum(value: number) {
  const input = new Float32Array(128);
  input.fill(value);
  const output = new Float32Array(128);
  return { input, output };
}

describe("radio audio worklets", () => {
  it("raggruppa la cattura in frame da 20 ms prima di coinvolgere il main thread", () => {
    const Processor = loadWorklet("radio-capture-worklet.js");
    const processor = new Processor({ processorOptions: { frameMs: 20 } });

    for (let index = 0; index < 7; index += 1) {
      const { input, output } = renderQuantum(0.5);
      processor.process([[input]], [[output]]);
      expect(output.every((sample) => sample === 0)).toBe(true);
    }
    expect(processor.port.postMessage).not.toHaveBeenCalled();

    const eighth = renderQuantum(0.5);
    processor.process([[eighth.input]], [[eighth.output]]);
    expect(processor.port.postMessage).toHaveBeenCalledTimes(1);

    const firstMessage = processor.port.postMessage.mock.calls[0]?.[0] as WorkletMessage;
    expect(firstMessage.type).toBe("chunk");
    expect(firstMessage.pcm).toBeInstanceOf(Float32Array);
    expect(firstMessage.pcm).toHaveLength(960);
    expect(firstMessage.level).toBeCloseTo(0.5, 5);

    for (let index = 0; index < 7; index += 1) {
      const { input, output } = renderQuantum(0.25);
      processor.process([[input]], [[output]]);
    }
    expect(processor.port.postMessage).toHaveBeenCalledTimes(2);
  });

  it("limita a 50 callback il lavoro TX di un secondo a 48 kHz", () => {
    const Processor = loadWorklet("radio-capture-worklet.js");
    const processor = new Processor({ processorOptions: { frameMs: 20 } });

    for (let quantum = 0; quantum < 375; quantum += 1) {
      const { input, output } = renderQuantum(0.1);
      processor.process([[input]], [[output]]);
    }

    expect(processor.port.postMessage).toHaveBeenCalledTimes(50);
    for (const [message] of processor.port.postMessage.mock.calls) {
      expect((message as WorkletMessage).pcm).toHaveLength(960);
    }
  });

  it("prebufferizza la ricezione e si riaggancia dopo un underrun breve", () => {
    const Processor = loadWorklet("radio-playback-worklet.js");
    const processor = new Processor({
      processorOptions: {
        jitterSamples: 256,
        rebufferSamples: 128,
        concealmentSamples: 256,
        resumeFadeSamples: 32,
      },
    });

    const firstFrame = new Float32Array(128);
    firstFrame.fill(1);
    processor.port.onmessage?.({ data: { type: "enqueue", pcm: firstFrame } });
    const beforeJitter = renderQuantum(0).output;
    processor.process([], [[beforeJitter]]);
    expect(beforeJitter.every((sample) => sample === 0)).toBe(true);

    const secondFrame = new Float32Array(128);
    secondFrame.fill(0.5);
    processor.port.onmessage?.({ data: { type: "enqueue", pcm: secondFrame } });
    const firstOutput = renderQuantum(0).output;
    processor.process([], [[firstOutput]]);
    expect(firstOutput.every((sample) => sample === 1)).toBe(true);

    const secondOutput = renderQuantum(0).output;
    processor.process([], [[secondOutput]]);
    expect(secondOutput.every((sample) => sample === 0.5)).toBe(true);

    const underrunOutput = renderQuantum(0).output;
    processor.process([], [[underrunOutput]]);
    expect(processor.port.postMessage).toHaveBeenCalledWith({ type: "underrun" });
    expect(underrunOutput[0]).toBeGreaterThan(underrunOutput[127]);

    const recoveryFrame = new Float32Array(128);
    recoveryFrame.fill(0.25);
    processor.port.onmessage?.({ data: { type: "enqueue", pcm: recoveryFrame } });
    const recoveredOutput = renderQuantum(0).output;
    processor.process([], [[recoveredOutput]]);
    expect(recoveredOutput.every((sample) => sample === 0.25)).toBe(true);
  });

  it("rebufferizza solo quando il vuoto audio supera la finestra di continuita", () => {
    const Processor = loadWorklet("radio-playback-worklet.js");
    const processor = new Processor({
      processorOptions: {
        jitterSamples: 128,
        rebufferSamples: 256,
        concealmentSamples: 256,
        resumeFadeSamples: 32,
      },
    });

    const frame = new Float32Array(128);
    frame.fill(0.8);
    processor.port.onmessage?.({ data: { type: "enqueue", pcm: frame } });
    processor.process([], [[renderQuantum(0).output]]);

    const firstGap = renderQuantum(0).output;
    processor.process([], [[firstGap]]);
    expect(firstGap[0]).toBeGreaterThan(firstGap[127]);
    expect(firstGap[127]).toBeGreaterThan(0);

    const secondGap = renderQuantum(0).output;
    processor.process([], [[secondGap]]);
    expect(secondGap[0]).toBeGreaterThan(secondGap[127]);

    const tooEarlyFrame = new Float32Array(128);
    tooEarlyFrame.fill(0.4);
    processor.port.onmessage?.({ data: { type: "enqueue", pcm: tooEarlyFrame } });
    const waitingForRebuffer = renderQuantum(0).output;
    processor.process([], [[waitingForRebuffer]]);
    expect(waitingForRebuffer.every((sample) => sample === 0)).toBe(true);

    const secondRecoveryFrame = new Float32Array(128);
    secondRecoveryFrame.fill(0.4);
    processor.port.onmessage?.({ data: { type: "enqueue", pcm: secondRecoveryFrame } });
    const recovered = renderQuantum(0).output;
    processor.process([], [[recovered]]);
    expect(recovered[127]).toBeCloseTo(0.4, 5);
  });
});
