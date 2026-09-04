#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_HANDLERS = [
  "handleFiscalCommand",
  "handlePaymentMovementReprint",
  "handlePayTable",
  "handlePaymentFreeSplit",
];

const RESERVED = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "of",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "false",
  "null",
]);

const GLOBALS = new Set([
  "Array",
  "BigInt",
  "Boolean",
  "Buffer",
  "Date",
  "Error",
  "JSON",
  "Map",
  "Math",
  "Number",
  "Object",
  "Promise",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "URL",
  "console",
  "decodeURIComponent",
  "encodeURIComponent",
  "fetch",
  "globalThis",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "process",
  "queueMicrotask",
  "setInterval",
  "setTimeout",
  "clearInterval",
  "clearTimeout",
]);

function parseArgs(argv) {
  const out = {
    source: "backend/server.js",
    out: "docs/architecture/payments-dependency-audit.json",
    handlers: DEFAULT_HANDLERS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source") out.source = argv[++index] ?? out.source;
    else if (arg === "--out") out.out = argv[++index] ?? out.out;
    else if (arg === "--handlers") {
      out.handlers = String(argv[++index] ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/dependency-audit.mjs --source backend/server.js --out docs/architecture/payments-dependency-audit-YYYYMMDD.json",
      );
      process.exit(0);
    } else {
      throw new Error(`Argomento non riconosciuto: ${arg}`);
    }
  }
  return out;
}

function buildLineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function offsetToLine(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  return high + 1;
}

function isIdentifierStart(char) {
  return /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char) {
  return /[A-Za-z0-9_$]/.test(char);
}

function previousNonSpace(source, offset) {
  for (let index = offset - 1; index >= 0; index -= 1) {
    if (!/\s/.test(source[index])) return source[index];
  }
  return "";
}

function nextNonSpace(source, offset) {
  for (let index = offset; index < source.length; index += 1) {
    if (!/\s/.test(source[index])) return source[index];
  }
  return "";
}

function maskCommentsAndQuotedStrings(source, options = {}) {
  const maskTemplates = options.maskTemplates !== false;
  const chars = [...source];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const next = chars[index + 1];
    if (char === "/" && next === "/") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 2;
      while (index < chars.length && chars[index] !== "\n") {
        chars[index] = " ";
        index += 1;
      }
    } else if (char === "/" && next === "*") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 2;
      while (index < chars.length) {
        const blockChar = chars[index];
        const blockNext = chars[index + 1];
        chars[index] = blockChar === "\n" ? "\n" : " ";
        if (blockChar === "*" && blockNext === "/") {
          chars[index + 1] = " ";
          index += 1;
          break;
        }
        index += 1;
      }
    } else if (char === "'" || char === '"') {
      const quote = char;
      chars[index] = " ";
      index += 1;
      while (index < chars.length) {
        const stringChar = chars[index];
        chars[index] = stringChar === "\n" ? "\n" : " ";
        if (stringChar === "\\") {
          index += 1;
          if (index < chars.length) chars[index] = chars[index] === "\n" ? "\n" : " ";
        } else if (stringChar === quote) {
          break;
        }
        index += 1;
      }
    } else if (char === "`" && maskTemplates) {
      chars[index] = " ";
      index += 1;
      while (index < chars.length) {
        const templateChar = chars[index];
        chars[index] = templateChar === "\n" ? "\n" : " ";
        if (templateChar === "\\") {
          index += 1;
          if (index < chars.length) chars[index] = chars[index] === "\n" ? "\n" : " ";
        } else if (templateChar === "`") {
          break;
        }
        index += 1;
      }
    }
  }
  return chars.join("");
}

function computeDepths(masked) {
  const depths = new Array(masked.length).fill(0);
  let depth = 0;
  for (let index = 0; index < masked.length; index += 1) {
    depths[index] = depth;
    const char = masked[index];
    if (char === "{") depth += 1;
    else if (char === "}") depth = Math.max(0, depth - 1);
  }
  return depths;
}

function findMatchingBrace(masked, openOffset) {
  let depth = 0;
  for (let index = openOffset; index < masked.length; index += 1) {
    const char = masked[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`Graffa chiusa non trovata per offset ${openOffset}`);
}

function splitTopLevel(source, separator = ",") {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") depth = Math.max(0, depth - 1);
    else if (char === separator && depth === 0) {
      out.push(source.slice(start, index));
      start = index + 1;
    }
  }
  out.push(source.slice(start));
  return out;
}

function findTopLevelEquals(source) {
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") depth = Math.max(0, depth - 1);
    else if (char === "=" && depth === 0 && source[index + 1] !== ">" && source[index - 1] !== "=") return index;
  }
  return -1;
}

function extractBindingNames(pattern) {
  const cleaned = pattern
    .replace(/\.\.\./g, " ")
    .replace(/\b(as|async|await)\b/g, " ");
  const names = new Set();
  if (/^[A-Za-z_$][\w$]*/.test(cleaned.trim())) {
    names.add(cleaned.trim().match(/^[A-Za-z_$][\w$]*/)[0]);
    return [...names];
  }
  const tokens = [...cleaned.matchAll(/\b[A-Za-z_$][\w$]*\b/g)];
  for (const token of tokens) {
    const name = token[0];
    const after = nextNonSpace(cleaned, token.index + name.length);
    if (RESERVED.has(name)) continue;
    if (after === ":" && !cleaned.slice(token.index + name.length).trimStart().startsWith(": =")) continue;
    names.add(name);
  }
  return [...names];
}

function extractParamNames(paramsText) {
  const out = new Set();
  for (const part of splitTopLevel(paramsText)) {
    const equalsIndex = findTopLevelEquals(part);
    const binding = (equalsIndex >= 0 ? part.slice(0, equalsIndex) : part).trim();
    for (const name of extractBindingNames(binding)) out.add(name);
  }
  return [...out];
}

function extractDeclarationNames(declarationList) {
  const out = new Set();
  for (const part of splitTopLevel(declarationList)) {
    const equalsIndex = findTopLevelEquals(part);
    const binding = (equalsIndex >= 0 ? part.slice(0, equalsIndex) : part).trim();
    for (const name of extractBindingNames(binding)) out.add(name);
  }
  return [...out];
}

function collectTopLevelDeclarations(source, masked, depths, lineStarts) {
  const declarations = new Map();
  const add = (name, kind, offset) => {
    if (!name || RESERVED.has(name)) return;
    if (!declarations.has(name)) {
      declarations.set(name, { name, kind, line: offsetToLine(lineStarts, offset) });
    }
  };

  const importRegex = /^\s*import\s+([\s\S]*?)\s+from\s+["'][^"']+["'];?/gm;
  for (const match of source.matchAll(importRegex)) {
    if (depths[match.index] !== 0) continue;
    const spec = match[1].trim();
    const named = spec.match(/\{([\s\S]*?)\}/);
    const defaultImport = spec.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
    const namespaceImport = spec.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (defaultImport) add(defaultImport[1], "import", match.index);
    if (namespaceImport) add(namespaceImport[1], "import", match.index);
    if (named) {
      for (const entry of splitTopLevel(named[1])) {
        const parts = entry.trim().split(/\s+as\s+/);
        const local = (parts[1] ?? parts[0] ?? "").trim();
        if (/^[A-Za-z_$][\w$]*$/.test(local)) add(local, "import", match.index);
      }
    }
  }

  const declarationRegex = /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|\bclass\s+([A-Za-z_$][\w$]*)\b|\b(const|let|var)\s+/g;
  for (const match of masked.matchAll(declarationRegex)) {
    if (depths[match.index] !== 0) continue;
    if (match[1]) add(match[1], "function", match.index);
    else if (match[2]) add(match[2], "class", match.index);
    else if (match[3]) {
      const start = match.index + match[0].length;
      let end = masked.indexOf(";", start);
      if (end < 0) end = masked.indexOf("\n", start);
      if (end < 0) end = masked.length;
      for (const name of extractDeclarationNames(masked.slice(start, end))) {
        add(name, match[3], match.index);
      }
    }
  }
  return declarations;
}

function findFunctionRange(source, masked, lineStarts, name) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, "g");
  const match = pattern.exec(masked);
  if (!match) throw new Error(`Handler non trovato: ${name}`);
  const paramsStart = masked.indexOf("(", match.index);
  let paramsEnd = paramsStart;
  let parenDepth = 0;
  for (; paramsEnd < masked.length; paramsEnd += 1) {
    if (masked[paramsEnd] === "(") parenDepth += 1;
    else if (masked[paramsEnd] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) break;
    }
  }
  const openBrace = masked.indexOf("{", paramsEnd);
  const closeBrace = findMatchingBrace(masked, openBrace);
  return {
    name,
    startOffset: match.index,
    paramsStart,
    paramsEnd,
    bodyStart: openBrace + 1,
    bodyEnd: closeBrace,
    endOffset: closeBrace + 1,
    startLine: offsetToLine(lineStarts, match.index),
    endLine: offsetToLine(lineStarts, closeBrace),
    params: extractParamNames(source.slice(paramsStart + 1, paramsEnd)),
  };
}

function collectLocalNames(bodyMasked, params) {
  const locals = new Set(params);
  const add = (name) => {
    if (name && !RESERVED.has(name)) locals.add(name);
  };

  const declarationRegex = /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|\bclass\s+([A-Za-z_$][\w$]*)\b|\b(const|let|var)\s+/g;
  for (const match of bodyMasked.matchAll(declarationRegex)) {
    if (match[1]) add(match[1]);
    else if (match[2]) add(match[2]);
    else if (match[3]) {
      const start = match.index + match[0].length;
      let end = bodyMasked.indexOf(";", start);
      if (end < 0) end = bodyMasked.indexOf("\n", start);
      if (end < 0) end = bodyMasked.length;
      for (const name of extractDeclarationNames(bodyMasked.slice(start, end))) add(name);
    }
  }

  for (const match of bodyMasked.matchAll(/\bcatch\s*\(([^)]*)\)/g)) {
    for (const name of extractBindingNames(match[1])) add(name);
  }
  for (const match of bodyMasked.matchAll(/\(([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)\)\s*=>/g)) {
    for (const name of extractBindingNames(match[1])) add(name);
  }
  for (const match of bodyMasked.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*=>/g)) {
    add(match[2]);
  }
  return locals;
}

function collectUsedIdentifiers(masked) {
  const used = new Set();
  const identifierRegex = /\b[A-Za-z_$][\w$]*\b/g;
  for (const match of masked.matchAll(identifierRegex)) {
    const name = match[0];
    const previous = previousNonSpace(masked, match.index);
    if (RESERVED.has(name) || GLOBALS.has(name)) continue;
    if (previous === ".") continue;
    used.add(name);
  }
  return used;
}

function auditHandler(source, masked, lineStarts, topLevelDeclarations, range) {
  const body = source.slice(range.bodyStart, range.bodyEnd);
  const bodyMasked = maskCommentsAndQuotedStrings(body, { maskTemplates: false });
  const locals = collectLocalNames(bodyMasked, range.params);
  const used = collectUsedIdentifiers(bodyMasked);
  const dependencies = [];
  const unknownExternalIdentifiers = [];

  for (const name of [...used].sort((a, b) => a.localeCompare(b))) {
    if (locals.has(name)) continue;
    const declaration = topLevelDeclarations.get(name);
    if (declaration) dependencies.push(declaration);
    else unknownExternalIdentifiers.push(name);
  }

  dependencies.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  return {
    name: range.name,
    startLine: range.startLine,
    endLine: range.endLine,
    lineCount: range.endLine - range.startLine + 1,
    params: range.params,
    dependencyCount: dependencies.length,
    dependencies,
    sharedDependencyCandidates: dependencies.map((entry) => entry.name),
    unknownExternalIdentifiers,
    localIdentifierCount: locals.size,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const sourcePath = path.resolve(cwd, args.source);
  const outPath = path.resolve(cwd, args.out);
  const source = await fs.readFile(sourcePath, "utf8");
  const lineStarts = buildLineStarts(source);
  const masked = maskCommentsAndQuotedStrings(source);
  const depths = computeDepths(masked);
  const topLevelDeclarations = collectTopLevelDeclarations(source, masked, depths, lineStarts);
  const handlers = args.handlers.map((name) => {
    const range = findFunctionRange(source, masked, lineStarts, name);
    return auditHandler(source, masked, lineStarts, topLevelDeclarations, range);
  });

  const shared = new Map();
  for (const handler of handlers) {
    for (const dependency of handler.dependencies) {
      const current = shared.get(dependency.name) ?? {
        ...dependency,
        handlers: [],
      };
      current.handlers.push(handler.name);
      shared.set(dependency.name, current);
    }
  }

  const result = {
    roadmapStep: "K-PRE.0",
    generatedAt: new Date().toISOString(),
    sourceFile: path.relative(cwd, sourcePath),
    sourceLineCount: lineStarts.length,
    handlerNames: args.handlers,
    topLevelDeclarationCount: topLevelDeclarations.size,
    handlers,
    sharedDependencies: [...shared.values()]
      .filter((entry) => entry.handlers.length > 1)
      .sort((a, b) => b.handlers.length - a.handlers.length || a.line - b.line || a.name.localeCompare(b.name)),
    notes: [
      "Parser minimale senza dipendenze esterne: maschera commenti/stringhe, individua range funzione, binding locali e dichiarazioni top-level.",
      "dependencies contiene identificatori liberi dell'handler che corrispondono a dichiarazioni top-level di server.js: sono i candidati da passare alla factory durante K-PRE.1.",
      "unknownExternalIdentifiers va rivisto manualmente: in genere contiene chiavi oggetto, parole in template literal o globali non mappati.",
    ],
  };

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Dependency audit scritto: ${path.relative(cwd, outPath)}`);
  for (const handler of handlers) {
    console.log(
      `${handler.name}: ${handler.startLine}-${handler.endLine}, deps=${handler.dependencyCount}, unknown=${handler.unknownExternalIdentifiers.length}`,
    );
  }
  console.log(`Dipendenze condivise: ${result.sharedDependencies.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
