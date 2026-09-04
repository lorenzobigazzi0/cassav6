import assert from "node:assert/strict";
import test from "node:test";
import { calculateMysqlStatusDelta } from "./loadtest-mysql-status.mjs";

test("calcola solo delta monotoni dei contatori MySQL", () => {
  const result = calculateMysqlStatusDelta(
    { Uptime: 100, Questions: 1_000, Innodb_data_written: 5_000 },
    { Uptime: 160, Questions: 1_125, Innodb_data_written: 5_900 },
  );

  assert.deepEqual(result, {
    delta: { Uptime: 60, Questions: 125, Innodb_data_written: 900 },
    resetKeys: [],
    serverRestarted: false,
  });
});

test("invalida il singolo contatore che torna indietro", () => {
  const result = calculateMysqlStatusDelta(
    { Uptime: 100, Questions: 1_000, Innodb_data_written: 5_000 },
    { Uptime: 160, Questions: 1_125, Innodb_data_written: 400 },
  );

  assert.equal(result.delta.Questions, 125);
  assert.equal(result.delta.Innodb_data_written, null);
  assert.deepEqual(result.resetKeys, ["Innodb_data_written"]);
  assert.equal(result.serverRestarted, false);
});

test("invalida tutti i delta se l'uptime indica un riavvio MySQL", () => {
  const result = calculateMysqlStatusDelta(
    { Uptime: 5_000, Questions: 20_000, Innodb_data_written: 50_000 },
    { Uptime: 20, Questions: 30, Innodb_data_written: 80 },
  );

  assert.deepEqual(result.delta, {
    Uptime: null,
    Questions: null,
    Innodb_data_written: null,
  });
  assert.deepEqual(result.resetKeys, ["Innodb_data_written", "Questions", "Uptime"]);
  assert.equal(result.serverRestarted, true);
});

test("ignora valori mancanti o non numerici", () => {
  const result = calculateMysqlStatusDelta(
    { Uptime: 100, Questions: 10, error: "start" },
    { Uptime: 120, Innodb_data_written: 50, error: "end" },
  );

  assert.deepEqual(result.delta, { Uptime: 20 });
  assert.deepEqual(result.resetKeys, []);
});
