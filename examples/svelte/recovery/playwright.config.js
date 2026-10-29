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
    // The build is 35 s on a developer's machine and this is a CI job now, so
    // the siblings' 300 s rather than a margin that only holds here.
    timeout: 300_000,
  },
});
