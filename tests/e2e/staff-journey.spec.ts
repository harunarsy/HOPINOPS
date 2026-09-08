import { test, expect } from '@playwright/test';
import { BASE_URL, requireMutatingStaging, getJourneyIdentity, getProjectGps } from './fixtures';

/**
 * E7 browser journey on staging (simulated browser GPS + real API/RPC):
 * login -> 8-step training -> save -> assignment claim -> GPS check-in -> workspace.
 *
 * Requires manifest fixture per project (E2E_FIXTURE_MANIFEST) dengan journey operator
 * dedicated yang belum onboarding dan belum punya assignment hari ini.
 * This is NOT real-device GPS: geolocation is Playwright-controlled.
 */

const FALLBACK_GPS = { latitude: -7.277997, longitude: 112.7464245 };

test.describe('E7 staff browser journey (staging)', () => {
  test('login, training, assignment, GPS check-in, workspace', async ({ page, context }, testInfo) => {
    test.setTimeout(180_000);
    const selected = requireMutatingStaging(testInfo.project.name);
    const journey = getJourneyIdentity(testInfo.project.name);
    const journeyUser = journey?.displayName ?? process.env.E2E_JOURNEY_DISPLAY_NAME ?? 'E2E OPERATOR 2';
    const journeyPin = journey?.pin || process.env.E2E_JOURNEY_PASSWORD || selected.pin;
    const journeyGreeting = (journey?.displayName ?? journey?.username ?? '').toLowerCase();
    const gps = getProjectGps() ?? FALLBACK_GPS;
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ ...gps, accuracy: 10 });

    await page.goto(`${BASE_URL}/`);

    // 1. Login: pick user, enter PIN (auto-submits on 6th digit).
    await page.getByRole('button', { name: /nama lengkap/i }).click();
    await page.getByText(new RegExp(journeyUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).click();
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

    // 3. Assignment: KITCHEN SIANG PRIMARY pada outlet terisolasi per project.
    if (journeyGreeting) {
      await expect(page.getByText(new RegExp(`halo, ${journeyGreeting.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'))).toBeVisible({ timeout: 20_000 });
    } else {
      await expect(page.getByText(/halo, e2e operator 2/i)).toBeVisible({ timeout: 20_000 });
    }
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
