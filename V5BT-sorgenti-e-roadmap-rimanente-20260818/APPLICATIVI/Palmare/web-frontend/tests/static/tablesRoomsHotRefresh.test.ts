import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readSource(relativePath: string) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

describe("tables rooms hot refresh", () => {
  it("aggiorna a caldo le sale senza riavviare il mobile", () => {
    const source = readSource("src/pages/home/tables/TablesWorkspace.tsx");

    expect(source).toContain("const ROOMS_HOT_REFRESH_MS = 30_000");
    expect(source).toContain("refetchInterval: ROOMS_HOT_REFRESH_MS");
    expect(source).toContain("refetchIntervalInBackground: true");
    expect(source).toContain("refetchOnReconnect: true");
  });

  it("mantiene la sala corrente e non sceglie fallback automatici", () => {
    const source = readSource("src/pages/home/tables/TablesWorkspace.tsx");

    expect(source).toContain(
      "const currentRoom = rooms.find((room) => room.id === effectiveRoomId)"
    );
    expect(source).toContain("if (currentRoom)");
    expect(source).toContain("currentRoom.name !== roomName");
    expect(source).not.toContain("const fallbackRoom = rooms[0]");
    expect(source).not.toContain("roomId: fallbackRoom.id");
    expect(source).not.toContain("roomName: fallbackRoom.name");
    expect(source).not.toContain("activityId: fallbackRoom.activityId");
    expect(source).not.toContain("activityName: fallbackRoom.activityName");
    expect(source).not.toContain("lastAutoRoomSwitchRef.current");
  });
});
