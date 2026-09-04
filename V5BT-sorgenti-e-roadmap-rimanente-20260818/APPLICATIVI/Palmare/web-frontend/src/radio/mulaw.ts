const MU_LAW_MU = 255;
const MU_LAW_MAX_MAGNITUDE = Math.log1p(MU_LAW_MU);

function clampPcmSample(sample: number) {
  if (!Number.isFinite(sample)) return 0;
  return Math.max(-1, Math.min(1, sample));
}

export function encodeMuLawSample(sample: number) {
  const safeSample = clampPcmSample(sample);
  const sign = safeSample < 0 ? 0x80 : 0;
  const magnitude =
    Math.log1p(MU_LAW_MU * Math.abs(safeSample)) / MU_LAW_MAX_MAGNITUDE;
  const quantized = Math.min(0x7f, Math.max(0, Math.round(magnitude * 0x7f)));
  return ~(sign | quantized) & 0xff;
}

export function decodeMuLawSample(byte: number) {
  const value = ~byte & 0xff;
  const sign = value & 0x80 ? -1 : 1;
  const quantized = value & 0x7f;
  const magnitude =
    (Math.exp((quantized / 0x7f) * MU_LAW_MAX_MAGNITUDE) - 1) / MU_LAW_MU;
  return clampPcmSample(sign * magnitude);
}

export function encodeMuLaw(pcm: Float32Array) {
  const encoded = new Uint8Array(pcm.length);
  for (let index = 0; index < pcm.length; index += 1) {
    encoded[index] = encodeMuLawSample(pcm[index]);
  }
  return encoded;
}

export function decodeMuLaw(payload: Uint8Array) {
  const decoded = new Float32Array(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    decoded[index] = decodeMuLawSample(payload[index]);
  }
  return decoded;
}

export function calculatePcmLevel(pcm: Float32Array) {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = clampPcmSample(pcm[index]);
    sum += sample * sample;
  }
  return Math.max(0, Math.min(1, Math.sqrt(sum / pcm.length)));
}
