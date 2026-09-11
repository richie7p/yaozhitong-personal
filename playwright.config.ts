import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 40000,
  use: { baseURL: "http://127.0.0.1:5190", trace: "retain-on-failure" },
  webServer: {
    command: "npm run build && tsx tests/support/e2e-server.ts",
    env: {
      APP_MODE: "local",
      PORT: "5190",
      LOCAL_DATA_PATH: ".local/e2e-run-" + Date.now(),
      NVIDIA_API_KEY: "",
    },
    url: "http://127.0.0.1:5190/health",
    reuseExistingServer: false,
    timeout: 120000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: { ...devices["Pixel 5"], viewport: { width: 375, height: 812 } },
    },
  ],
});
