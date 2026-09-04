import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readSource(relativePath: string) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("tables room long press", () => {
  it("ripristina il long press sulla sala per aprire il cambio sala", () => {
    const source = readSource("src/pages/home/tables/TablesWorkspace.tsx");

    expect(source).toContain("startRoomTitleLongPress");
    expect(source).toContain("onPointerDown");
    expect(source).toContain("tables-room-title-button");
    expect(source).toContain("tables-room-change-backdrop");
    expect(source).toContain("fetchAvailableRooms");
    expect(source).toContain("requestRoomChange");
    expect(source).toContain("currentRoomId: effectiveRoomId");
    expect(source).toContain("targetRoomId === effectiveRoomId");
    expect(source).toContain("setSelectedTableSnapshot(null)");
    expect(source).toContain("roomId: result.room.id");
    expect(source).toContain("roomName: result.room.name");
    expect(source).toContain("activityId: result.room.activityId");
    expect(source).toContain("activityName: result.room.activityName");
    expect(source).toContain("const closeRoomPicker = useCallback");
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain("if (isCurrent) {");
    expect(source).toContain("closeRoomPicker();");
  });

  it("non cambia sala automaticamente se la sala corrente non e nella lista", () => {
    const source = readSource("src/pages/home/tables/TablesWorkspace.tsx");

    expect(source).not.toContain("lastAutoRoomSwitchRef");
    expect(source).not.toContain("const fallbackRoom = rooms[0]");
    expect(source).not.toContain("roomId: fallbackRoom.id");
  });

  it("monta la modale cambio sala dentro il body della card tavoli", () => {
    const source = readSource("src/pages/home/tables/TablesWorkspace.tsx");

    const cardBodyIndex = source.indexOf('<div className="card-body tables-card-body">');
    const roomModalIndex = source.indexOf('className="tables-room-change-backdrop"');
    const detailPanelIndex = source.indexOf("<TableDetailPanel", cardBodyIndex);

    expect(cardBodyIndex).toBeGreaterThanOrEqual(0);
    expect(roomModalIndex).toBeGreaterThan(cardBodyIndex);
    expect(roomModalIndex).toBeLessThan(detailPanelIndex);
  });

  it("mantiene gli stili della modale di cambio sala", () => {
    const css = readSource("src/styles/tables.css");

    expect(css).toContain(".tables-card-body {\n  position: relative;");
    expect(css).toContain(".tables-room-change-backdrop");
    expect(css).toContain(".tables-room-change-backdrop {\n  position: absolute;");
    expect(css).not.toContain(".tables-room-change-backdrop {\n  position: fixed;");
    expect(css).toContain(".tables-room-change-modal");
    expect(css).toContain(".tables-room-change-option.is-current");
    expect(css).toContain(".tables-room-change-option.is-current-room");
    expect(css).toContain(':root[data-theme="light"] .tables-room-change-modal');
  });
});
