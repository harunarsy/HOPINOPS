import { test, expect } from '@playwright/test';
import { BASE_URL } from './fixtures';

/**
 * E7 browser journey on staging (simulated browser GPS + real API/RPC):
 * login -> 8-step training -> save -> assignment claim -> GPS check-in -> workspace.
 *
 * Requires disposable staging operator (E2E_JOURNEY_USERNAME, default e2e-operator2)
 * with PIN (E2E_PASSWORD) and NO prior onboarding completion or assignment today.
 * Reset fixture state on staging before running.
 * This is NOT real-device GPS: geolocation is Playwright-controlled.
 */

const journeyUser = process.env.E2E_JOURNEY_USERNAME ?? 'e2e-operator2';
const journeyPin = process.env.E2E_PASSWORD ?? '';
const canRun = Boolean(journeyPin);

// Staging outlet geofence center (read from outlet_settings, region Singapore).
const STAGING_GPS = { latitude: -7.277997, longitude: 112.7464245 };

test.describe('E7 staff browser journey (staging)', () => {
  test.skip(!canRun, 'Requires E2E_PASSWORD for disposable staging operator');

  test('login, training, assignment, GPS check-in, workspace', async ({ page, context }) => {
    test.setTimeout(180_000);
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ ...STAGING_GPS, accuracy: 10 });

    await page.goto(`${BASE_URL}/`);

    // 1. Login: pick user, enter PIN (auto-submits on 6th digit).
    await page.getByRole('button', { name: /nama lengkap/i }).click();
    await page.getByText('E2E OPERATOR 2').click();
    const pin = journeyPin;
    for (let i = 0; i < 6; i += 1) {
      await page.locator(`#pin-input-${i}`).fill(pin[i]);
    }

    // 2. Training: 8 mandatory interactions (not bare clicks).
    await expect(page.getByRole('heading', { name: /latihan alur shift/i })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /^bar/i }).click();
    await page.getByRole('button', { name: 'Berikutnya' }).click();
    await page.getByRole('button', { name: /simulasikan dalam radius/i }).click();
    await page.getByRole('button', { name: 'Berikutnya' }).click();
    await page.getByRole('button', { name: /^primary/i }).click();
    await page.getByRole('button', { name: 'Berikutnya' }).click();
    await page.getByRole('button', { name: /sesuai/i }).click();
    await page.getByRole('button', { name: 'Berikutnya' }).click();
    await page.getByRole('button', { name: /catat keluar 5/i }).click();
    await page.getByRole('button', { name: 'Berikutnya' }).click();
    await page.getByRole('button', { name: /handover/i }).click();
    await page.getByRole('button', { name: 'Berikutnya' }).click();
    await page.getByRole('button', { name: /coba tanpa internet/i }).click();
    await page.getByRole('button', { name: /sambungkan internet/i }).click();
    await page.getByRole('button', { name: /periksa catatan yang perlu diperbaiki/i }).click();
    await page.getByRole('button', { name: 'Berikutnya' }).click();
    await page.getByRole('button', { name: /simulasikan check-out/i }).click();
    await page.getByRole('button', { name: /simpan & mulai bekerja/i }).click();

    // 3. Assignment: KITCHEN SIANG PRIMARY (BAR SIANG may be taken by e2e-operator).
    await expect(page.getByText(/halo, e2e operator 2/i)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /kitchen/i }).click();
    await page.getByRole('button', { name: /lanjut ke absensi gps/i }).click();
    await expect(page.getByRole('heading', { name: 'Konfirmasi Penugasan' })).toBeVisible();
    await page.getByRole('button', { name: /konfirmasi & masuk/i }).click();

    // 4. GPS check-in with controlled browser geolocation against real staging API.
    await expect(page.getByText('ABSENSI MASUK SHIFT')).toBeVisible({ timeout: 20_000 });
    await page.getByLabel('Geser untuk Check-In').fill('100');

    // 5. Workspace reached (checked-in + assignment active).
    await expect(page.getByRole('heading', { name: /workspace kitchen/i })).toBeVisible({ timeout: 30_000 });
  });
});
