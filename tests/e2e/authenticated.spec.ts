import { test, expect } from '@playwright/test';
import { credentials, canRunMutating } from './fixtures';

/**
 * Mutating-flow placeholder tests.
 *
 * These are SKIPPED unless E2E_USERNAME and E2E_PASSWORD point at a
 * disposable account on a staging database. They exist so Phase 2+ work
 * can extend them without redesigning the harness.
 */

test.describe.skip('Authenticated flows (staging-only)', () => {
  test.skip(!canRunMutating, 'Requires disposable staging credentials');

  test('operator can log in and reach assignment screen', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /pilih nama anda/i }).click();
    await page.locator('.user-picker-option', { hasText: credentials.username }).click();
    for (let i = 0; i < 6; i++) {
      await page.locator(`#pin-input-${i}`).fill(credentials.pin[i] ?? '');
    }
    await expect(page.getByText(/halo,/i)).toBeVisible({ timeout: 15_000 });
  });

  test('first-run opening surfaces initialization state, not fake zero', async () => {
    test.fixme(true, 'Blocked by Phase 2 (rpc_get_opening_reference not implemented)');
  });

  test('variance without category is rejected; with category and no note is accepted', async () => {
    test.fixme(true, 'Blocked by Phase 2 (0010 variance policy)');
  });

  test('three failed PINs lock for 60 seconds server-side', async () => {
    test.fixme(true, 'Blocked by Phase 4 (0011 server-authoritative lockout)');
  });
});
