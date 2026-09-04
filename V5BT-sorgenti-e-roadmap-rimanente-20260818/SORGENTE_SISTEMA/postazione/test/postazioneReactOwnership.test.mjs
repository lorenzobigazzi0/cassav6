import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const projectUrl = new URL("../", import.meta.url);

test("the Postazione bootstrap has no legacy web bridges", async () => {
  const index = await readFile(new URL("index.html", projectUrl), "utf8");
  const scripts = [...index.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);

  assert.deepEqual(scripts, [
    "/src/main.jsx",
    "/postazione/assets/postazione-disable-context-menu.js?v=20260724-react-runtime",
    "/postazione/assets/postazione-order-sound.js?v=20260623-station-canonical",
    "/postazione/assets/postazione-apericena-summary.js?v=20260508-apericena-sync",
  ]);
  assert.doesNotMatch(index, /(?:bridge|bootstrap|guard|fix|live-sync|auto-next|auto-print)\.js/i);
});

test("public runtime assets do not wrap fetch or retain bridge files", async () => {
  const assetsUrl = new URL("public/assets/", projectUrl);
  const files = await readdir(assetsUrl);
  assert.equal(files.some((name) => /bridge/i.test(name)), false);

  for (const name of files.filter((entry) => entry.endsWith(".js"))) {
    const source = await readFile(new URL(name, assetsUrl), "utf8");
    assert.doesNotMatch(source, /window\.fetch\s*=/, `${name} must not replace window.fetch`);
  }
});

test("React owns the former station, session, history and support behaviors", async () => {
  const source = await readFile(new URL("src/App.jsx", projectUrl), "utf8");
  assert.match(source, /\/api\/integration\/stations\/active/);
  assert.match(source, /Authorization: `Bearer/);
  assert.match(source, /pauseTransferMode/);
  assert.match(source, /station_support_request/);
  assert.match(source, /settingsVersionRef/);
  assert.match(source, /sortOrdersOperationalFirst/);
  assert.match(source, /activeApiControllersRef\.current\.forEach/);
});

test("Postazione completes login only after an allowed workstation is selected", async () => {
  const source = await readFile(new URL("src/App.jsx", projectUrl), "utf8");
  const loginStart = source.indexOf("/api/auth/login");
  const loginEnd = source.indexOf("const payload = await res.json()", loginStart);

  assert.ok(loginStart >= 0);
  assert.ok(loginEnd > loginStart);
  assert.doesNotMatch(
    source.slice(loginStart, loginEnd),
    /\bstation(?:Name)?\s*:/,
  );
  assert.match(source, /setEntryStage\("workstation"\)/);
  assert.match(source, /normalizeAvailableWorkstations\(payload\)/);
  assert.match(source, /const nextAuth = \{ \.\.\.pendingAuth, loggedIn: true \}/);
  assert.match(source, /station-selector station-selector-static/);
  assert.doesNotMatch(source, /modal\.station/);
});
