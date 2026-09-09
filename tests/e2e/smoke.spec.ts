import { test, expect } from '@playwright/test';
import { BASE_URL, requireMutatingStaging, loadFixtureManifestIfPresent } from './fixtures';

/**
 * Smoke tests against the same BASE_URL under test (vercel dev staging).
 * Tidak ada default production dan tidak ada target API kedua.
 * UI-only assertions tidak menyentuh kredensial; negative-login memakai
 * akun disposable dari manifest dan IP unik per project.
 */

const API_BASE = BASE_URL;

function projectClientIp(projectName: string): string {
  const manifest = loadFixtureManifestIfPresent();
  if (manifest) return projectName.includes('mobile') ? manifest.clientIps.mobile : manifest.clientIps.desktop;
  if (projectName.includes('mobile')) return process.env.E2E_MOBILE_CLIENT_IP ?? '198.51.100.44';
  return process.env.E2E_DESKTOP_CLIENT_IP ?? '198.51.100.42';
}

/** IP khusus untuk negative-login; wajib berbeda dari IP project agar tidak memblokir test lain. */
function failedLoginIpForProject(projectName: string): string {
  if (projectName.includes('mobile')) return process.env.E2E_MOBILE_FAILED_LOGIN_IP ?? '198.51.100.45';
  return process.env.E2E_FAILED_LOGIN_IP ?? '198.51.100.43';
}

function disposableDisplayName(projectName: string): string | null {
  const manifest = loadFixtureManifestIfPresent();
  if (!manifest) return null;
  const project = projectName.includes('mobile') ? 'mobile' : 'desktop';
  return manifest.users[project].lifecycle.displayName;
}

async function apiGetAbs(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Origin: API_BASE } });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function apiPostAbs(path: string, payload: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: API_BASE },
    body: JSON.stringify(payload),
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

test.describe('Staging smoke (same origin)', () => {
  test('login page renders with user picker and PIN boxes', async ({ page }) => {
    await page.goto('/');
    const picker = page.getByRole('button', { name: /pilih nama anda|memuat daftar nama|nama lengkap/i });
    await expect(picker).toBeVisible({ timeout: 12_000 });
    await expect(page.locator('#pin-input-0')).toBeVisible();
    for (let i = 1; i <= 5; i++) {
      await expect(page.locator(`#pin-input-${i}`)).toBeVisible();
    }
    await expect(page.getByRole('button', { name: /masuk ke sistem/i })).toBeVisible();
  });

  test('six PIN boxes are focus-ordered and numeric-only', async ({ page }) => {
    await page.goto('/');
    const picker = page.getByRole('button', { name: /pilih nama anda|memuat daftar nama|nama lengkap/i });
    await expect(picker).toBeVisible({ timeout: 12_000 });
    await page.locator('#pin-input-0').click();
    await page.keyboard.type('12');
    await expect(page.locator('#pin-input-0')).toHaveValue('1');
    await expect(page.locator('#pin-input-1')).toHaveValue('2');
    await expect(page.locator('#pin-input-2')).toBeFocused();
  });

  test('unauthenticated business API returns 401 envelope', async () => {
    const { status, body } = await apiGetAbs('/api/app?action=bootstrap');
    expect(status).toBe(401);
    expect(body?.ok).toBe(false);
    expect(body?.error?.code).toBe('AUTH_REQUIRED');
  });

  test('unauthenticated request to unknown action returns 401 (auth precedes dispatch)', async () => {
    const { status, body } = await apiGetAbs('/api/app?action=definitely.not.an.action');
    expect(status).toBe(401);
    expect(body?.ok).toBe(false);
    expect(body?.error?.code).toBe('AUTH_REQUIRED');
  });

  test('failed login is generic and does not leak user existence', async ({ request }, testInfo) => {
    requireMutatingStaging(testInfo.project.name);
    const res = await request.post(`${API_BASE}/api/auth?action=login`, {
      data: { username: 'e2e-no-such-user', pin: '000000' },
      headers: { Origin: API_BASE, 'X-Forwarded-For': failedLoginIpForProject(testInfo.project.name) },
    });
    const status = res.status();
    let body: any = null;
    try { body = await res.json(); } catch { body = null; }
    // Wajib 401 generik; 403 berarti CSRF belum benar, 429 berarti fixture tercemar.
    expect(status, `Login negatif tercemar: ${JSON.stringify(body)}`).toBe(401);
    expect(body?.error ?? body?.error?.message).toBeDefined();
  });

  test('failed login clears all six PIN boxes on the form', async ({ page }, testInfo) => {
    requireMutatingStaging(testInfo.project.name);
    await page.setExtraHTTPHeaders({ 'X-Forwarded-For': failedLoginIpForProject(testInfo.project.name) });
    await page.goto('/');
    const picker = page.getByRole('button', { name: /pilih nama anda|memuat daftar nama|nama lengkap/i });
    await expect(picker).toBeVisible({ timeout: 12_000 });
    await picker.click();
    const targetName = disposableDisplayName(testInfo.project.name);
    const option = targetName
      ? page.getByText(new RegExp(targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
      : page.locator('.user-picker-option').first();
    await expect(option.first()).toBeVisible();
    await option.first().click();
    // Fill an intentionally wrong PIN.
    for (let i = 0; i < 6; i++) {
      await page.locator(`#pin-input-${i}`).fill('9');
    }
    // Login auto-submits immediately after the sixth PIN digit.
    const error = page.locator('.form-error, [role="alert"]');
    await expect(error.first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#pin-input-0')).toHaveValue('');
    await expect(page.locator('#pin-input-5')).toHaveValue('');
    const lockedOut = await page.getByText(/terlalu banyak percobaan salah/i).isVisible();
    if (!lockedOut) {
      await expect(page.locator('#pin-input-0')).toBeFocused();
    }
  });
});
