import { defineConfig } from '@playwright/test';

const basePath = '/Holo-11.29-/';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:4173${basePath}`,
    browserName: 'chromium',
    headless: true,
  },
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 4173 --strictPort',
    url: `http://127.0.0.1:4173${basePath}tests/browser/restore-harness.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
