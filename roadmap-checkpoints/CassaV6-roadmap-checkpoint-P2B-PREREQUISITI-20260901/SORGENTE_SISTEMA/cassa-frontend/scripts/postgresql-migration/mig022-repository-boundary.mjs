import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { repositorySourceRole } from "../../backend/core/repository-contract.js";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const defaultAppDir = path.resolve(scriptDir, "../..");
const RUNTIME_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const EXCLUDED_BACKEND_DIRECTORIES = new Set(["scripts", "tests"]);

function normalizedRelativePath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function templateText(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (!ts.isTemplateExpression(node)) return null;
  return [
    node.head.text,
    ...node.templateSpans.flatMap((span) => ["${expression}", span.literal.text]),
  ].join("");
}

function normalizedSqlCandidate(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikeSqlStatement(value) {
  const candidate = normalizedSqlCandidate(value);
  if (!candidate) return false;
  return (
    /^SELECT\s+(?:GET_LOCK|RELEASE_LOCK)\s*\(/i.test(candidate)
    || /^SELECT\s+.+\s+FROM\s+/i.test(candidate)
    || /^INSERT\s+INTO\s+/i.test(candidate)
    || /^UPDATE\s+\S+\s+SET\s+/i.test(candidate)
    || /^DELETE\s+FROM\s+/i.test(candidate)
    || /^(?:CREATE|ALTER|DROP|TRUNCATE)\s+(?:TABLE|SCHEMA|INDEX|DATABASE|ROLE)\b/i.test(candidate)
    || /^(?:BEGIN(?:\s+ISOLATION\s+LEVEL\b)?|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\s*;?$/i.test(candidate)
    || /^PRAGMA\s+/i.test(candidate)
    || /^WITH\s+.+\b(?:SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM)\b/i.test(candidate)
  );
}

function propertyCallName(node) {
  if (!ts.isCallExpression(node)) return null;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  if (
    ts.isElementAccessExpression(node.expression)
    && ts.isStringLiteralLike(node.expression.argumentExpression)
  ) {
    return node.expression.argumentExpression.text;
  }
  return null;
}

function lineForNode(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

export function findSqlBoundaryViolations(source, options = {}) {
  const relativePath = normalizedRelativePath(options.relativePath);
  const role = repositorySourceRole(relativePath);
  if (role === "infrastructure" || role === "repository") return [];

  const sourceFile = ts.createSourceFile(
    relativePath || "source.js",
    String(source ?? ""),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const violations = new Map();
  const code = role === "handler" ? "SQL_IN_HANDLER" : "SQL_OUTSIDE_REPOSITORY";

  function addViolation(node) {
    const line = lineForNode(sourceFile, node);
    const key = `${code}:${relativePath}:${line}`;
    if (!violations.has(key)) violations.set(key, { code, file: relativePath, line });
  }

  function visit(node) {
    const literal = templateText(node);
    if (literal !== null && looksLikeSqlStatement(literal)) addViolation(node);

    if (role === "handler" && ts.isCallExpression(node)) {
      const callName = propertyCallName(node);
      if (callName === "query" || callName === "execute") {
        addViolation(node);
      } else if (callName === "prepare" || callName === "exec") {
        const firstArgument = node.arguments[0];
        const firstText = firstArgument ? templateText(firstArgument) : null;
        if (firstText !== null && looksLikeSqlStatement(firstText)) addViolation(node);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return [...violations.values()].sort((left, right) => left.line - right.line);
}

async function listRuntimeFiles(backendDir) {
  const files = [];
  async function visit(directory, relativeDirectory = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!relativeDirectory && EXCLUDED_BACKEND_DIRECTORIES.has(entry.name)) continue;
        await visit(absolute, relative);
        continue;
      }
      if (entry.isFile() && RUNTIME_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push({ absolute, relative: `backend/${normalizedRelativePath(relative)}` });
      }
    }
  }
  await visit(backendDir);
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

export async function auditRepositoryBoundaries(options = {}) {
  const appDir = path.resolve(options.appDir ?? defaultAppDir);
  const backendDir = path.join(appDir, "backend");
  const files = await listRuntimeFiles(backendDir);
  const violations = [];
  let handlerFiles = 0;
  let repositoryFiles = 0;

  for (const file of files) {
    const role = repositorySourceRole(file.relative);
    if (role === "handler") handlerFiles += 1;
    if (role === "repository" || role === "infrastructure") repositoryFiles += 1;
    const source = await fs.readFile(file.absolute, "utf8");
    violations.push(...findSqlBoundaryViolations(source, { relativePath: file.relative }));
  }

  return {
    appDir,
    handlerFiles,
    repositoryFiles,
    runtimeFiles: files.length,
    violations: violations.sort((left, right) => (
      left.file.localeCompare(right.file) || left.line - right.line
    )),
  };
}

async function runCli() {
  const result = await auditRepositoryBoundaries({ appDir: defaultAppDir });
  const outputArgIndex = process.argv.findIndex((argument) => argument === "--output");
  const outputPath = outputArgIndex >= 0
    ? path.resolve(defaultAppDir, process.argv[outputArgIndex + 1] ?? "")
    : null;
  if (outputArgIndex >= 0 && !process.argv[outputArgIndex + 1]) {
    throw new Error("--output richiede un percorso.");
  }
  if (outputPath) {
    const report = {
      task: "MIG-022",
      generatedAt: new Date().toISOString(),
      ok: result.violations.length === 0,
      scope: "backend-runtime",
      runtimeFiles: result.runtimeFiles,
      handlerFiles: result.handlerFiles,
      repositoryFiles: result.repositoryFiles,
      violations: result.violations,
    };
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (result.violations.length > 0) {
    console.error(
      `[repository-boundary] FAIL: ${result.violations.length} violazioni in ${result.runtimeFiles} file runtime.`,
    );
    for (const violation of result.violations) {
      console.error(`- ${violation.code} ${violation.file}:${violation.line}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `[repository-boundary] OK: ${result.runtimeFiles} file runtime, `
    + `${result.handlerFiles} handler, ${result.repositoryFiles} owner persistence.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await runCli();
}
