import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

// This is the same complete desktop workflow set. WebKit is not branded Safari;
// the native macOS Safari job records its own separate WebDriver coverage.
export default defineConfig({
  ...base,
  forbidOnly: true,
  retries: 0,
  // Route fixtures must reach Playwright, including after a reload. Real service
  // worker coverage stays enabled explicitly in the offline workflow and Safari.
  use: {
    ...base.use,
    serviceWorkers: "block",
    ...(process.env.YZT_BROWSER_PROXY_URL
      ? { proxy: { server: process.env.YZT_BROWSER_PROXY_URL, bypass: "127.0.0.1,localhost,[::1]" } }
      : {}),
  },
  reporter: [
    ["line"],
    ["json", { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME || "test-results/desktop-browser-results.json" }],
  ],
  projects: [
    { name: "firefox-desktop", use: { ...devices["Desktop Firefox"], browserName: "firefox" } },
    { name: "webkit-desktop", use: { ...devices["Desktop Safari"], browserName: "webkit" } },
  ],
});
