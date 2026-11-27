import { expect, test } from '@playwright/test';

test('Web Lock prevents a second tab from entering backup restore while the first tab owns it', async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  await first.goto('tests/browser/restore-lock-harness.html');
  await second.goto('tests/browser/restore-lock-harness.html');

  await first.evaluate(async () => {
    const moduleUrl = new URL('/Holo-11.29-/src/lib/completeBackupRestore.ts', location.origin).href;
    const { withCompleteRestoreLock } = await import(/* @vite-ignore */ moduleUrl);
    const state = window as unknown as Record<string, unknown>;
    state.firstAcquired = false;
    state.firstDone = false;
    void withCompleteRestoreLock(() => new Promise<void>((resolve) => {
      state.firstAcquired = true;
      void resolve;
    })).then(() => { state.firstDone = true; });
  });
  await expect.poll(() => first.evaluate(() => Boolean((window as unknown as Record<string, unknown>).firstAcquired))).toBe(true);

  await second.evaluate(async () => {
    const moduleUrl = new URL('/Holo-11.29-/src/lib/completeBackupRestore.ts', location.origin).href;
    const { withCompleteRestoreLock } = await import(/* @vite-ignore */ moduleUrl);
    const state = window as unknown as Record<string, unknown>;
    state.secondAcquired = false;
    state.secondDone = false;
    void withCompleteRestoreLock(async () => {
      state.secondAcquired = true;
    }).then(() => { state.secondDone = true; });
  });

  await expect.poll(() => second.evaluate(() => Boolean((window as unknown as Record<string, unknown>).secondAcquired)), { timeout: 500 }).toBe(false);
  // Closing the owner tab simulates a browser crash: Chromium must release
  // its Web Lock so the recovery tab can acquire the lock and inspect the journal.
  await first.close();
  await expect.poll(() => second.evaluate(() => Boolean((window as unknown as Record<string, unknown>).secondDone))).toBe(true);
  await second.close();
});
