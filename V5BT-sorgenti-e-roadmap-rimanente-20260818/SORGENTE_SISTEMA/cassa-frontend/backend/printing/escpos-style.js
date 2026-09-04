export function createEscPosStyleHelpers(options = {}) {
  const {
    clampInt = (value, min, max, fallback = min) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(max, Math.max(min, Math.trunc(parsed)));
    },
  } = options;

  function escPos(bytes) {
    return String.fromCharCode(...bytes);
  }

  function escPosAlign(mode = "left") {
    const normalizedMode = String(mode ?? "").trim().toLowerCase();
    const value = normalizedMode === "center" ? 1 : normalizedMode === "right" ? 2 : 0;
    return escPos([0x1b, 0x61, value]);
  }

  function escPosBold(enabled) {
    return escPos([0x1b, 0x45, enabled ? 0x01 : 0x00]);
  }

  function escPosUnderline(enabled) {
    return escPos([0x1b, 0x2d, enabled ? 0x01 : 0x00]);
  }

  function escPosItalic(enabled) {
    return escPos([0x1b, 0x34, enabled ? 0x01 : 0x00]);
  }

  function escPosCharSpacing(value = 0) {
    const spacing = clampInt(value, 0, 8, 0);
    return escPos([0x1b, 0x20, spacing]);
  }

  function escPosSize(widthScale = 0, heightScale = 0) {
    return escPos([0x1d, 0x21, ((widthScale & 0x07) << 4) | (heightScale & 0x07)]);
  }

  function escPosInlineReset() {
    return `${escPosBold(false)}${escPosItalic(false)}${escPosUnderline(false)}${escPosCharSpacing(0)}${escPosSize(0, 0)}`;
  }

  function styleEscPosPrintLine(value, options = {}) {
    const text = String(value ?? "").trimEnd();
    if (!text) return "";
    return `${escPosAlign(options.align)}${escPosBold(options.bold === true)}${escPosItalic(options.italic === true)}${escPosUnderline(options.underline === true)}${escPosCharSpacing(options.charSpacing ?? 0)}${escPosSize(options.widthScale ?? 0, options.heightScale ?? 0)}${text}${escPosInlineReset()}`;
  }

  function styleEscPosPrintLines(values, options = {}) {
    return (Array.isArray(values) ? values : [values])
      .map((value) => styleEscPosPrintLine(value, options))
      .filter(Boolean);
  }

  return {
    escPos,
    escPosAlign,
    escPosBold,
    escPosCharSpacing,
    escPosInlineReset,
    escPosItalic,
    escPosSize,
    escPosUnderline,
    styleEscPosPrintLine,
    styleEscPosPrintLines,
  };
}
