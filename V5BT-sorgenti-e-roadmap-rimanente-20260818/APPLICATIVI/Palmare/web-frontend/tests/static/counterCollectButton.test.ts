import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("counter collect button", () => {
  it("enables RISCUOTI only with a valid cart payload and keeps long press stable", () => {
    const counter = readSource("src/pages/home/tables/counter/CounterWorkspace.tsx");
    const composer = readSource("src/pages/home/tables/components/TableOrderComposer.tsx");
    const longPressHook = readSource(
      "src/pages/home/tables/components/useSubmitLongPressAction.ts"
    );
    const tablesCss = readSource("src/styles/tables.css");

    expect(counter).toContain('submitLabel="RISCUOTI"');
    expect(counter).toContain("onSubmitLongPress={handleSubmitLongPress}");
    expect(counter).toContain("setAdjustmentOpen(true)");
    expect(counter).toContain("setActionError(message)");
    expect(counter).toContain("inlineStatus=");
    expect(composer).toContain("const submitPayloadReady = useMemo");
    expect(composer).toContain("inlineStatus?:");
    expect(composer).toContain("table-order-inline-status");
    expect(composer).toContain("hasPayload: submitPayloadReady");
    expect(composer).toContain("disabled={interactionBusy || !submitPayloadReady}");
    expect(composer).toContain("onTouchStart={submitLongPress.onTouchStart}");
    expect(composer).toContain("onTouchEnd={submitLongPress.onTouchEnd}");
    expect(composer).toContain("onTouchCancel={submitLongPress.onTouchCancel}");
    expect(composer).toContain("onContextMenu={(event) => event.preventDefault()}");
    expect(longPressHook).not.toContain('if (event.pointerType === "touch") return;');
    expect(longPressHook).toContain("onTouchStart");
    expect(longPressHook).toContain("onTouchEnd");
    expect(longPressHook).toContain("onTouchCancel");
    expect(longPressHook).toContain("setPointerCapture?.(event.pointerId)");
    expect(longPressHook).toContain("releasePointerCapture?.(event.pointerId)");
    expect(tablesCss).toContain(".table-order-submit:disabled");
    expect(tablesCss).toContain(".table-order-inline-status.is-error");
    expect(tablesCss).toContain("touch-action: none;");
    expect(tablesCss).toContain("-webkit-touch-callout: none;");
  });
});
