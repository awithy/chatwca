import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  webServer: {
    command: "npm run build:web && tsx tests/browser/fixture-server.ts",
    url: "http://127.0.0.1:8787/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
  use: {
    baseURL: "http://127.0.0.1:8787",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
