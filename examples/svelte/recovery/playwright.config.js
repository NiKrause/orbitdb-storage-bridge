// SPDX-License-Identifier: MIT
import { defineConfig } from "@playwright/test";

// Honoured like the sibling examples', so a second run can have its own server.
// With the port fixed, `reuseExistingServer` below quietly serves whatever an
// earlier run built: the spec file is read fresh, the page is not, and a change
// to src/ then looks as if it had no effect.
const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 4175;

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    command: `npm run build && npm run preview -- --port ${port} --strictPort`,
    port,
    reuseExistingServer: !process.env.CI,
    // The build is 35 s on a developer's machine and this is a CI job now, so
    // the siblings' 300 s rather than a margin that only holds here.
    timeout: 300_000,
  },
});
