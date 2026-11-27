import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    headless: true,
  },
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/tests/browser/restore-harness.html',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
