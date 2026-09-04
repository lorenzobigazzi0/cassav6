import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const readSource = (relativePath: string) => readFileSync(resolve(repoRoot, relativePath), "utf8");

describe("radio visual contrast contracts", () => {
  it("keeps Radio UI readable in light and dark themes", () => {
    const css = readSource("src/styles/glass.css");

    expect(css).toMatch(
      /\.radio-incoming-pill\s*\{[\s\S]*?color:\s*rgba\(255,\s*255,\s*255,\s*0\.98\);[\s\S]*?color-mix\(in srgb, var\(--radio-pill-color\) 58%, #020617 42%\)/
    );
    expect(css).toMatch(
      /\.radio-page-control-feedback\s*\{[\s\S]*?color:\s*rgba\(255,\s*255,\s*255,\s*0\.96\);/
    );
    expect(css).toMatch(
      /:root\[data-theme="light"\] \.radio-page-control-feedback,[\s\S]*?:root:not\(\[data-theme\]\) \.radio-page-control-feedback\s*\{[\s\S]*?color:\s*rgba\(255,\s*255,\s*255,\s*0\.98\);/
    );
    expect(css).toMatch(
      /:root\[data-theme="light"\] \.radio-echo-btn \.radio-page-control-feedback,[\s\S]*?:root:not\(\[data-theme\]\) \.radio-echo-btn \.radio-page-control-feedback\s*\{[\s\S]*?color:\s*rgba\(10,\s*14,\s*20,\s*0\.94\);[\s\S]*?background:\s*transparent;/
    );
    expect(css).toMatch(/\.radio-echo-btn\s*\{[\s\S]*?0 8px 18px rgba\(0,\s*0,\s*0,\s*0\.16\)/);
    expect(css).toMatch(
      /:root\[data-theme="light"\] \.radio-echo-btn,[\s\S]*?:root:not\(\[data-theme\]\) \.radio-echo-btn\s*\{[\s\S]*?0 8px 16px rgba\(15,\s*23,\s*42,\s*0\.08\)/
    );
    expect(css).toMatch(
      /:root\[data-theme="light"\] \.radio-slot-option\.is-selected,[\s\S]*?:root:not\(\[data-theme\]\) \.radio-slot-option\.is-selected\s*\{[\s\S]*?color:\s*rgba\(12,\s*21,\s*35,\s*0\.98\);/
    );
    expect(css).toMatch(
      /:root\[data-theme="light"\] \.radio-status-panel span,[\s\S]*?:root:not\(\[data-theme\]\) \.radio-status-panel span\s*\{[\s\S]*?color:\s*rgba\(45,\s*60,\s*82,\s*0\.82\);/
    );
  });

  it("keeps custom slot dropdowns overlaid without resizing Radio slot rows", () => {
    const css = readSource("src/styles/glass.css");
    const radioSlotMenuBlock = css.match(/\.radio-slot-menu\s*\{([\s\S]*?)\}/)?.[1] ?? "";

    expect(css).toMatch(/\.radio-slot-list\s*\{[\s\S]*?overflow:\s*visible;/);
    expect(css).toMatch(/\.settings-ios-list\.radio-slot-list\s*\{[\s\S]*?overflow:\s*visible;/);
    expect(css).toMatch(/\.radio-slot-row\s*\{[\s\S]*?overflow:\s*visible;/);
    expect(css).toMatch(
      /\.radio-slot-row:focus-within,[\s\S]*?\.radio-slot-row:has\(\.radio-slot-trigger\.is-open\)\s*\{[\s\S]*?z-index:\s*80;/
    );
    expect(radioSlotMenuBlock).toMatch(/position:\s*absolute;/);
    expect(radioSlotMenuBlock).toMatch(/top:\s*calc\(100% \+ 6px\);/);
    expect(radioSlotMenuBlock).not.toMatch(/position:\s*static;/);
  });

  it("keeps Radio PTT touch holds active while the finger moves", () => {
    const css = readSource("src/styles/glass.css");
    const bottomBar = readSource("src/pages/home/components/BottomBar.tsx");

    expect(css).toMatch(/\.radio-page-ptt-btn\s*\{[\s\S]*?touch-action:\s*none\s*!important;/);
    expect(css).toMatch(/\.radio-echo-btn\s*\{[\s\S]*?touch-action:\s*none\s*!important;/);
    expect(css).toMatch(/\.bottom-bar-wrap\s*\{[\s\S]*?touch-action:\s*none\s*!important;/);
    expect(css).toMatch(/\.bottom-btn\s*\{[\s\S]*?touch-action:\s*none\s*!important;/);
    expect(css).toMatch(
      /\.bottom-btn \*,[\s\S]*?\.bottom-radio-ptt-panel\s*\{[\s\S]*?touch-action:\s*none\s*!important;/
    );
    expect(bottomBar).toContain("passive: false");
    expect(bottomBar).toContain(
      'bar.addEventListener("touchmove", onNativeTouchMove, touchOptions)'
    );
    expect(bottomBar).toContain("gesture.pointerId !== TOUCH_RADIO_POINTER_ID");
    expect(bottomBar).not.toContain("onTouchCancelCapture={onTouchEnd}");
  });

  it("keeps bottom-bar PTT color on the bar instead of separate overlays", () => {
    const css = readSource("src/styles/glass.css");
    const bottomBar = readSource("src/pages/home/components/BottomBar.tsx");

    expect(bottomBar).toContain("--radio-zone-center");
    expect(bottomBar).not.toContain("bottom-radio-segments");
    expect(bottomBar).not.toContain("bottom-radio-zone-glow");
    expect(css).not.toContain(".bottom-radio-segments");
    expect(css).not.toContain(".bottom-radio-zone-glow");
    expect(css).toMatch(/\.bottom-bar::before\s*\{[\s\S]*?var\(--radio-zone-center, 50%\)/);
    expect(css).toMatch(
      /\.bottom-bar-wrap\.is-radio-active \.bottom-bar\s*\{[\s\S]*?border-color:[\s\S]*?box-shadow:/
    );
    expect(css).toMatch(
      /\.bottom-bar-wrap\.is-radio-active \.bottom-bar::before\s*\{[\s\S]*?opacity:\s*0\.9;/
    );
  });

  it("does not render the generic settings status banner inside Radio", () => {
    const radioPage = readSource("src/pages/RadioPage.tsx");

    expect(radioPage).not.toContain("settings-status-banner");
  });

  it("keeps the transmission spectrum visually rich but size-stable", () => {
    const css = readSource("src/styles/glass.css");
    const bottomBar = readSource("src/pages/home/components/BottomBar.tsx");
    const radioPage = readSource("src/pages/RadioPage.tsx");
    const systemRow = readSource("src/pages/home/components/SystemRow.tsx");

    expect(systemRow).toContain("levels.slice(0, RADIO_PILL_WAVEFORM_BAR_COUNT)");
    expect(radioPage).toContain("levels.slice(0, RADIO_WAVEFORM_BAR_COUNT)");
    expect(systemRow).toContain("--radio-pill-wave-delay");
    expect(radioPage).toContain("--radio-wave-delay");
    expect(bottomBar).not.toContain("bottom-radio-waveform");
    expect(bottomBar).toContain("RILASCIA PER TERMINARE");
    expect(css).toContain(".radio-pill-waveform");
    expect(css).toMatch(
      /\.radio-activity-pill\.is-outgoing\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\) auto minmax\(0,\s*1fr\);/
    );
    expect(css).toContain("radio-pill-channel-marquee");
    expect(css).toContain(".radio-page-waveform::before");
    expect(css).toMatch(
      /\.radio-pill-waveform\s*\{[\s\S]*?width:\s*46px;[\s\S]*?height:\s*16px;[\s\S]*?grid-template-columns:\s*repeat\(12,\s*2px\);/
    );
    expect(css).toMatch(
      /\.radio-pill-waveform i\s*\{[\s\S]*?width:\s*2px;[\s\S]*?height:\s*calc\(2px \+ \(var\(--radio-pill-wave-level, 0\.2\) \* 14px\)\);/
    );
    expect(css).toMatch(
      /\.radio-page-waveform\s*\{[\s\S]*?height:\s*44px;[\s\S]*?grid-template-columns:\s*repeat\(32,\s*2px\);/
    );
    expect(css).toMatch(
      /\.radio-page-waveform i\s*\{[\s\S]*?width:\s*2px;[\s\S]*?height:\s*calc\(2px \+ \(var\(--radio-wave-level, 0\.2\) \* 40px\)\);/
    );
    expect(css).toMatch(
      /\.radio-page-waveform i\s*\{[\s\S]*?animation-delay:\s*var\(--radio-wave-delay, 0ms\);/
    );
    expect(css).toMatch(
      /\.bottom-radio-ptt-panel\.is-busy\s*\{[\s\S]*?radio-busy-panel-fade 2s ease forwards;/
    );
    expect(css).toMatch(
      /\.radio-page-control-feedback\.is-busy\s*\{[\s\S]*?radio-busy-panel-fade 2s ease forwards;/
    );
  });
});
