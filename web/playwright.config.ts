import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  timeout: 90000,
  expect: { timeout: 20000 },
  workers: 1,
  use: {
    baseURL: process.env.WORKDECK_TEST_URL || "http://127.0.0.1:8090",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      executablePath:
        process.env.CHROMIUM_PATH ||
        "/home/workdeck-user/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
  },
  reporter: "list",
});
