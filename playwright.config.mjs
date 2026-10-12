import { defineConfig, devices } from "@playwright/test";

// The page is static: a tiny server (scripts/serve.mjs) serves the repo root during the run.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:8790",
    trace: "retain-on-failure",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node scripts/serve.mjs 8790",
    url: "http://127.0.0.1:8790/",
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
  },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
  ],
});
