import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertRepositoryImplementation,
  defineRepositoryContract,
  repositorySourceRole,
} from "../core/repository-contract.js";
import {
  auditRepositoryBoundaries,
  findSqlBoundaryViolations,
} from "../../scripts/postgresql-migration/mig022-repository-boundary.mjs";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(testDir, "../..");

test("il contratto repository dichiara dominio, operazioni e requisiti transazionali", () => {
  const contract = defineRepositoryContract({
    domain: "orders",
    methods: [
      { name: "byId", kind: "read", transaction: "supported" },
      { name: "save", kind: "write", transaction: "required" },
    ],
  });

  assert.equal(contract.domain, "orders");
  assert.deepEqual(contract.methods, [
    { name: "byId", kind: "read", transaction: "supported" },
    { name: "save", kind: "write", transaction: "required" },
  ]);
  assert.equal(Object.isFrozen(contract), true);
  assert.equal(Object.isFrozen(contract.methods), true);
  assert.equal(Object.isFrozen(contract.methods[0]), true);
});

test("il contratto rifiuta definizioni ambigue e implementazioni incomplete", () => {
  assert.throws(
    () => defineRepositoryContract({
      domain: "orders",
      methods: [
        { name: "save", kind: "write", transaction: "required" },
        { name: "save", kind: "write", transaction: "required" },
      ],
    }),
    /duplicato/,
  );
  assert.throws(
    () => defineRepositoryContract({
      domain: "orders",
      methods: [{ name: "save", kind: "write", transaction: "sometimes" }],
    }),
    /transaction/,
  );

  const contract = defineRepositoryContract({
    domain: "orders",
    methods: [{ name: "save", kind: "write", transaction: "required" }],
  });
  assert.throws(
    () => assertRepositoryImplementation(contract, {}),
    (error) => error?.code === "REPOSITORY_CONTRACT_MISMATCH" && /orders\.save/.test(error.message),
  );
  const implementation = { save() {} };
  assert.equal(assertRepositoryImplementation(contract, implementation), implementation);
});

test("la classificazione copre repository, infrastruttura e tutti gli handler", () => {
  assert.equal(repositorySourceRole("backend/db/postgresql/transactions.js"), "infrastructure");
  assert.equal(repositorySourceRole("backend/modules/menu/menu.repository.js"), "repository");
  assert.equal(repositorySourceRole("backend/modules/menu/menu.repo.js"), "repository");
  assert.equal(repositorySourceRole("backend/modules/menu/menu.handlers.js"), "handler");
  assert.equal(repositorySourceRole("backend/modules/menu/menu.routes.js"), "handler");
  assert.equal(repositorySourceRole("backend/server.js"), "handler");
  assert.equal(repositorySourceRole("backend/modules/menu/menu.domain.js"), "application");
});

test("il gate rileva SQL negli handler ma ammette repository e comandi non SQL", () => {
  const handlerViolations = findSqlBoundaryViolations(
    `export async function handle(client) {
      return client.query("SELECT id FROM orders WHERE id = $1", ["1"]);
    }`,
    { relativePath: "backend/modules/orders/orders.handlers.js" },
  );
  assert.equal(handlerViolations.length >= 1, true);
  assert.equal(handlerViolations.every(({ code }) => code === "SQL_IN_HANDLER"), true);

  assert.deepEqual(findSqlBoundaryViolations(
    `export function byId(db) {
      return db.prepare("SELECT id FROM orders WHERE id = ?").get("1");
    }`,
    { relativePath: "backend/modules/orders/orders.repository.js" },
  ), []);
  assert.deepEqual(findSqlBoundaryViolations(
    `commandList.push(["SELECT", "2"]);
     await pinProof.prepare(req, pathname);`,
    { relativePath: "backend/modules/redis/redis-volatile-store.js" },
  ), []);
});

test("SQL in un service viene segnalato come responsabilita fuori repository", () => {
  const violations = findSqlBoundaryViolations(
    `const statement = "UPDATE orders SET status = $1 WHERE id = $2";`,
    { relativePath: "backend/modules/orders/orders.service.js" },
  );
  assert.deepEqual(violations.map(({ code }) => code), ["SQL_OUTSIDE_REPOSITORY"]);
});

test("l'intero backend runtime non contiene SQL fuori dai proprietari ammessi", async () => {
  const result = await auditRepositoryBoundaries({ appDir });
  assert.equal(
    result.violations.length,
    0,
    result.violations.map(({ code, file, line }) => `${code} ${file}:${line}`).join("\n"),
  );
  assert.equal(result.runtimeFiles > 0, true);
  assert.equal(result.handlerFiles > 0, true);
  assert.equal(result.repositoryFiles > 0, true);
});

test("il confine repository e parte degli audit architetturali e dei comandi MIG-022", () => {
  const auditSource = readFileSync(
    path.join(appDir, "scripts", "backend-architecture-security-audit.mjs"),
    "utf8",
  );
  const gateSource = readFileSync(
    path.join(appDir, "scripts", "architecture-security-gate.mjs"),
    "utf8",
  );
  const packageJson = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8"));

  assert.match(auditSource, /auditRepositoryBoundaries/);
  assert.match(gateSource, /auditRepositoryBoundaries/);
  assert.equal(
    packageJson.scripts["audit:repository-boundary"],
    "node scripts/postgresql-migration/mig022-repository-boundary.mjs",
  );
  assert.match(packageJson.scripts["test:migration:pg:mig022"], /repository-boundary\.test\.mjs/);
});
