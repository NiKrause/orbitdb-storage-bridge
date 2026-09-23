// SPDX-License-Identifier: MIT
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://localhost:4175" },
  webServer: {
    command: "npm run build && npm run preview -- --port 4175 --strictPort",
    port: 4175,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
