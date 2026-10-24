import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

// This is the same complete desktop workflow set. WebKit is not branded Safari;
// the native macOS Safari job records its own separate WebDriver coverage.
export default defineConfig({
  ...base,
  retries: 0,
  reporter: [
    ["line"],
    ["json", { outputFile: process.env.PLAYWRIGHT_JSON_OUTPUT_NAME || "test-results/desktop-browser-results.json" }],
  ],
  projects: [
    { name: "firefox-desktop", use: { ...devices["Desktop Firefox"], browserName: "firefox" } },
    { name: "webkit-desktop", use: { ...devices["Desktop Safari"], browserName: "webkit" } },
  ],
});
