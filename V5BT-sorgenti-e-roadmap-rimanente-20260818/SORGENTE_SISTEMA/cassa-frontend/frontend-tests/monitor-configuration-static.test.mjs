import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cassaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(cassaRoot, "..");
const monitorAppPath = path.join(projectRoot, "monitor-frontend", "dist", "app.js");

test("[FE][MONITOR] monitor carica lo snapshot configurazione operativa", async () => {
  const source = await fs.readFile(monitorAppPath, "utf8");

  assert.match(source, /\/api\/settings\/configuration\/snapshot/);
  assert.match(source, /loadConfigurationSnapshot/);
  assert.match(source, /clientApp:\s*"monitor-frontend"/);
});

test("[FE][MONITOR] monitor espone modello configurazione v2", async () => {
  const source = await fs.readFile(monitorAppPath, "utf8");

  assert.match(source, /Schema configurazione/);
  assert.match(source, /Attivita RT\/Fiscalita/);
  assert.match(source, /Binding Attivita-Sala/);
  assert.match(source, /Resolved contexts/);
  assert.match(source, /Postazioni configurate/);
  assert.match(source, /Stampanti non fiscali \/ RT/);
  assert.match(source, /Routing stampa risolto/);
  assert.match(source, /Assegnazioni stampa attivita/);
  assert.match(source, /Menu\/Listini attivita/);
  assert.match(source, /Menu\/Listini per sala/);
  assert.match(source, /Personale per sala/);
  assert.match(source, /Personale configurato/);
  assert.match(source, /Legacy fiscale sala/);
  assert.match(source, /configuration\.workstations/);
  assert.match(source, /configuration\.fiscalDevices/);
  assert.match(source, /configuration\.activityRoomBindings/);
  assert.match(source, /configuration\.resolvedContexts/);
  assert.match(source, /configuration\.activityPrinterAssignments/);
  assert.match(source, /configuration\.activityMenuAssignments/);
  assert.match(source, /configuration\.roomMenuAssignments/);
  assert.match(source, /configuration\.roomStaffAssignments/);
  assert.match(source, /configuration\.staffAssignments/);
  assert.match(source, /configuration\.legacyRoomFiscalAssignments/);
  assert.doesNotMatch(source, /RT per Sala/);
});
