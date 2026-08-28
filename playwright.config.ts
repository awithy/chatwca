import { defineConfig } from "@playwright/test";

const port = Number(process.env.CHATWCA_BROWSER_TEST_PORT ?? 28787);

export default defineConfig({
  testDir: "tests/browser",
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  webServer: {
    command: "npm run build:web && tsx tests/browser/fixture-server.ts",
    url: `http://127.0.0.1:${String(port)}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${String(port)}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
