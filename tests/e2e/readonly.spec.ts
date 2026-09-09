import { test, expect } from '@playwright/test';

test('halaman login dapat dibuka tanpa mengirim login', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
      await route.abort();
      throw new Error('Smoke test hanya boleh membaca API.');
    }
    await route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /pilih nama anda|memuat daftar nama|nama lengkap/i })).toBeVisible();
  await expect(page.locator('#pin-input-0')).toBeVisible();
  await expect(page.getByRole('button', { name: /masuk ke sistem/i })).toBeVisible();
});

test('health dan batas autentikasi API full-stack', async ({ request }) => {
  test.skip(!process.env.E2E_BASE_URL, 'Preview Vite hanya melayani UI; set E2E_BASE_URL untuk full-stack.');
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  expect(await health.text()).toBe('ok');
  const response = await request.get('/api/app?action=bootstrap');
  expect(response.status()).toBe(401);
  expect(await response.json()).toMatchObject({ ok: false, error: { code: 'AUTH_REQUIRED' } });
});
