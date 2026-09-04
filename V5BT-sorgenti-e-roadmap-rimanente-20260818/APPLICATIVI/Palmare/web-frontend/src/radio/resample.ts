function normalizeSampleRate(sampleRate: number) {
  return Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 0;
}

export function resampleLinear(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number
) {
  const fromRate = normalizeSampleRate(inputSampleRate);
  const toRate = normalizeSampleRate(outputSampleRate);
  if (input.length === 0 || fromRate === 0 || toRate === 0) {
    return new Float32Array();
  }
  if (fromRate === toRate) {
    return new Float32Array(input);
  }

  const outputLength = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const output = new Float32Array(outputLength);
  const ratio = fromRate / toRate;

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(input.length - 1, leftIndex + 1);
    const amount = sourceIndex - leftIndex;
    const left = input[Math.min(input.length - 1, leftIndex)] ?? 0;
    const right = input[rightIndex] ?? left;
    output[index] = left + (right - left) * amount;
  }

  return output;
}

export function concatFloat32(left: Float32Array, right: Float32Array) {
  if (left.length === 0) return new Float32Array(right);
  if (right.length === 0) return new Float32Array(left);
  const merged = new Float32Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
}
