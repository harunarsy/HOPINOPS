import { test, expect } from '@playwright/test';

test('halaman login dapat dibuka tanpa mengirim login', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
      await route.abort();
      throw new Error('Smoke test hanya boleh membaca API.');
    }
    if (!process.env.E2E_BASE_URL) {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/auth' && url.searchParams.get('action') === 'me') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { user: null } }) });
        return;
      }
      if (url.pathname === '/api/auth' && url.searchParams.get('action') === 'options') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { options: [{ username: 'smoke', display_name: 'Petugas Smoke' }] } }) });
        return;
      }
    }
    await route.continue();
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: /pilih pengguna|memuat daftar pengguna/i })).toBeVisible();
  await expect(page.locator('#pin-input-0')).toBeVisible();
  await expect(page.locator('.pin-rail')).toBeVisible();
  const pinGeometry = await page.locator('.pin-rail input').evaluateAll((inputs) => {
    const rects = inputs.map((input) => input.getBoundingClientRect());
    return {
      widths: rects.map((rect) => Math.round(rect.width * 100) / 100),
      gaps: rects.slice(1).map((rect, index) => Math.round((rect.left - rects[index].right) * 100) / 100),
    };
  });
  expect(Math.max(...pinGeometry.widths) - Math.min(...pinGeometry.widths)).toBeLessThanOrEqual(0.5);
  expect(pinGeometry.gaps.every((gap) => Math.abs(gap) <= 0.5)).toBeTruthy();
  await expect(page.getByText(/server terhubung|memeriksa koneksi server|server tidak terjangkau/i)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
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
