import { defineConfig, devices } from "@playwright/test";

import {
  e2eBaseUrl,
  e2eBootstrapFile,
  e2ePort,
  e2eStateFile
} from "./environment.js";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  globalSetup: "./global-setup.ts",
  outputDir: "/tmp/luna-studio-playwright-results",
  use: {
    baseURL: e2eBaseUrl,
    storageState: e2eStateFile,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: {
    command: "node server.mjs",
    wait: { stdout: /LUNA_STUDIO_E2E_READY/u },
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    env: {
      ...process.env,
      LUNA_STUDIO_E2E_PORT: String(e2ePort),
      LUNA_STUDIO_E2E_BOOTSTRAP_FILE: e2eBootstrapFile
    }
  }
});
