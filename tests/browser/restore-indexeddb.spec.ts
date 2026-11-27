import { expect, test } from '@playwright/test';

test('recovers a two-database backup restore after a real Chromium IndexedDB abort', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/tests/browser/restore-harness.html');
  const result = page.locator('#result');
  await expect(result).toHaveAttribute('data-status', 'passed', { timeout: 90_000 });
  await expect(result).toContainText('Chromium IndexedDB crash injection and forward recovery');
  expect(pageErrors).toEqual([]);
});
