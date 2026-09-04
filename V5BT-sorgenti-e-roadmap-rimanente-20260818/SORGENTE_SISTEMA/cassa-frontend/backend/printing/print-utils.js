export function sanitizePrintFileToken(value, fallback = "doc") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return normalized || fallback;
}

export function makePrintSeparator(width) {
  return "-".repeat(Math.max(16, Math.trunc(Number(width) || 32)));
}

export function formatPrintMoneyCompact(value) {
  return new Intl.NumberFormat("it-IT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(Number(value)) ? Number(value) : 0);
}

export function formatPrintMoney(value) {
  return `${formatPrintMoneyCompact(value)} EUR`;
}

export function centerPrintText(value, width) {
  const text = String(value ?? "").trim();
  const safeWidth = Math.max(16, Math.trunc(Number(width) || 32));
  if (!text) return "";
  if (text.length >= safeWidth) return text;
  const leftPadding = Math.max(0, Math.floor((safeWidth - text.length) / 2));
  return `${" ".repeat(leftPadding)}${text}`;
}

export function padPrintRight(value, width) {
  const text = String(value ?? "");
  const safeWidth = Math.max(0, Math.trunc(Number(width) || 0));
  if (text.length >= safeWidth) {
    return safeWidth > 0 ? `${text.slice(0, Math.max(0, safeWidth - 1))} ` : text;
  }
  return `${text}${" ".repeat(safeWidth - text.length)}`;
}

export function formatPrintAmountLine(label, amountText, width) {
  const safeWidth = Math.max(16, Math.trunc(Number(width) || 32));
  const safeAmount = String(amountText ?? "").trim();
  const leftWidth = Math.max(12, safeWidth - safeAmount.length - 1);
  return `${padPrintRight(label, leftWidth)} ${safeAmount}`.trimEnd();
}

export function toPrintSafeUppercase(value) {
  const source = String(value ?? "").trim();
  if (!source) return "";
  return source
    .toLocaleUpperCase("it-IT")
    .replace(/[\u00c0\u00c1\u00c2\u00c4\u00c3\u00c5]/g, "A'")
    .replace(/[\u00c8\u00c9\u00ca\u00cb]/g, "E'")
    .replace(/[\u00cc\u00cd\u00ce\u00cf]/g, "I'")
    .replace(/[\u00d2\u00d3\u00d4\u00d6\u00d5]/g, "O'")
    .replace(/[\u00d9\u00da\u00db\u00dc]/g, "U'");
}

export function wrapPrintText(value, width, indent = "") {
  const safeWidth = Math.max(8, Math.trunc(Number(width) || 32));
  const baseIndent = String(indent ?? "");
  const source = String(value ?? "").replace(/\r\n?/g, "\n");
  const lines = [];

  source.split("\n").forEach((rawLine) => {
    const normalized = String(rawLine ?? "").trim();
    if (!normalized) {
      lines.push(baseIndent.trimEnd());
      return;
    }
    const words = normalized.split(/\s+/);
    let current = "";
    words.forEach((word) => {
      const candidate = current ? `${current} ${word}` : word;
      if ((baseIndent.length + candidate.length) <= safeWidth || !current) {
        current = candidate;
        return;
      }
      lines.push(`${baseIndent}${current}`.trimEnd());
      current = word;
    });
    if (current) {
      lines.push(`${baseIndent}${current}`.trimEnd());
    }
  });

  return lines.length > 0 ? lines : [baseIndent.trimEnd()];
}

export function buildPrintLabelLines(label, value, width) {
  const safeLabel = String(label ?? "").trim();
  const safeValue = String(value ?? "").trim();
  if (!safeLabel) {
    return wrapPrintText(safeValue, width);
  }
  if (!safeValue) {
    return [safeLabel];
  }
  const inline = `${safeLabel}: ${safeValue}`;
  if (inline.length <= width) {
    return [inline];
  }
  return [`${safeLabel}:`, ...wrapPrintText(safeValue, width, "  ")];
}

export function buildPrintTwoColumnLines(leftValue, rightValue, width) {
  const safeWidth = Math.max(16, Math.trunc(Number(width) || 32));
  const left = String(leftValue ?? "").trim();
  const right = String(rightValue ?? "").trim();
  if (!left && !right) return [];
  if (!right) return wrapPrintText(left, safeWidth);
  if (!left) return wrapPrintText(right, safeWidth);
  if (left.length + right.length < safeWidth) {
    return [`${left}${" ".repeat(safeWidth - left.length - right.length)}${right}`];
  }
  const reservedRight = Math.max(0, safeWidth - right.length - 1);
  if (reservedRight >= 8) {
    const wrappedLeft = wrapPrintText(left, reservedRight);
    if (wrappedLeft.length > 0 && wrappedLeft[0].length + right.length < safeWidth) {
      return [
        `${wrappedLeft[0]}${" ".repeat(safeWidth - wrappedLeft[0].length - right.length)}${right}`,
        ...wrappedLeft.slice(1),
      ];
    }
  }
  return [...wrapPrintText(left, safeWidth), ...wrapPrintText(right, safeWidth)];
}
