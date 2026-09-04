import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5190/mobile/",
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
  },
});
