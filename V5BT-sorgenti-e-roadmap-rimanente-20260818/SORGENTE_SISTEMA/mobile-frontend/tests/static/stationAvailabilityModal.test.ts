import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("station availability modal", () => {
  it("mostra una sola modale nativa per evento nessuna postazione attiva", () => {
    const composer = readFileSync(
      resolve(repoRoot, "src/pages/home/tables/components/TableOrderComposer.tsx"),
      "utf8"
    );
    const stationsApi = readFileSync(resolve(repoRoot, "src/api/stations.ts"), "utf8");

    expect(composer).toContain("const [stationWarningVisible, setStationWarningVisible]");
    expect(composer).toContain("const stationWarningAckedRef = useRef(false)");
    expect(composer).toContain("const previousNoActiveStationsRef = useRef(false)");
    expect(composer).toContain("previousNoActiveStationsRef.current !== nextNoActiveStations");
    expect(composer).toContain("stationWarningAckedRef.current = true");
    expect(composer).toContain("onClick={dismissNoActiveStationsWarning}");
    expect(composer).toContain("{noActiveStations && stationWarningVisible && (");
    expect(composer).not.toContain("stationWarningDismissed");
    expect(stationsApi).toContain("/api/integration/stations/state");
    expect(stationsApi).toContain("configuredStation !== true");
    expect(stationsApi).toContain("realStation === true");

    const modalBackdrops = composer.match(/mobile-no-active-stations-backdrop/g) ?? [];
    expect(modalBackdrops).toHaveLength(1);
  });

  it("mantiene l'avviso nel dettaglio fino al ripristino realtime della postazione", () => {
    const workspace = readFileSync(
      resolve(repoRoot, "src/pages/home/tables/TablesWorkspace.tsx"),
      "utf8"
    );
    const recovery = readFileSync(
      resolve(
        repoRoot,
        "src/pages/home/tables/hooks/useStationAvailabilityRecovery.ts"
      ),
      "utf8"
    );
    const closeDetailBlock = workspace.slice(
      workspace.indexOf("const closeTableDetail"),
      workspace.indexOf("const effectiveRoomId")
    );

    // L'avviso postazioni resta in linea; gli errori d'azione passano dalla modale.
    expect(workspace).toContain(
      "errorMessage={noActiveStationsWarning ? NO_ACTIVE_STATIONS_MESSAGE : null}"
    );
    expect(workspace).toContain("actionError={actionError}");
    expect(closeDetailBlock).not.toContain("setNoActiveStationsWarning(false)");
    expect(recovery).toContain('window.addEventListener("pos:server-payload", handleRealtime)');
    expect(recovery).toContain("if (count > 0) markRestored()");
  });
});
