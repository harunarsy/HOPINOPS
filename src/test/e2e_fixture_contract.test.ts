import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const STAGING_REF = 'ibzlxdmnuszcmdzuocwu';

describe('E2E fixture contract (tests/e2e/fixtures.ts)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadFixtures() {
    return await import('../../tests/e2e/fixtures');
  }

  it('rejects valid 20-char ref selain staging', async () => {
    process.env.E2E_MUTATIONS = '1';
    process.env.E2E_STAGING_PROJECT_REF = 'aaaaaaaaaaaaaaaaaaaa';
    process.env.E2E_STAGING_ALLOWLIST = 'http://127.0.0.1:4173';
    process.env.E2E_BASE_URL = 'http://127.0.0.1:4173';
    process.env.E2E_DESKTOP_USERNAME = 'e2e-desktop';
    process.env.E2E_DESKTOP_PASSWORD = '741258';
    const { requireMutatingStaging } = await loadFixtures();
    expect(() => requireMutatingStaging('desktop-chromium')).toThrow();
  });

  it('menolak origin production walau masuk allowlist', async () => {
    process.env.E2E_MUTATIONS = '1';
    process.env.E2E_STAGING_PROJECT_REF = STAGING_REF;
    process.env.E2E_STAGING_ALLOWLIST = 'https://hopinops.vercel.app';
    process.env.E2E_BASE_URL = 'https://hopinops.vercel.app';
    process.env.E2E_DESKTOP_USERNAME = 'e2e-desktop';
    process.env.E2E_DESKTOP_PASSWORD = '741258';
    const { requireMutatingStaging } = await loadFixtures();
    expect(() => requireMutatingStaging('desktop-chromium')).toThrow();
  });

  it('menolak desktop/mobile username sama', async () => {
    process.env.E2E_MUTATIONS = '1';
    process.env.E2E_STAGING_PROJECT_REF = STAGING_REF;
    process.env.E2E_STAGING_ALLOWLIST = 'http://127.0.0.1:4173';
    process.env.E2E_BASE_URL = 'http://127.0.0.1:4173';
    process.env.E2E_DESKTOP_USERNAME = 'same-user';
    process.env.E2E_DESKTOP_PASSWORD = '741258';
    process.env.E2E_MOBILE_USERNAME = 'same-user';
    process.env.E2E_MOBILE_PASSWORD = '741258';
    const { requireMutatingStaging } = await loadFixtures();
    // guard harus memastikan kedua project tidak berbagi mutable profile
    expect(() => requireMutatingStaging('desktop-chromium')).toThrow();
  });

  it('menerima konfigurasi staging disposable yang benar', async () => {
    process.env.E2E_MUTATIONS = '1';
    process.env.E2E_STAGING_PROJECT_REF = STAGING_REF;
    process.env.E2E_STAGING_ALLOWLIST = 'http://127.0.0.1:4173';
    process.env.E2E_BASE_URL = 'http://127.0.0.1:4173';
    process.env.E2E_DESKTOP_USERNAME = 'e2e-desktop-user';
    process.env.E2E_DESKTOP_PASSWORD = '741258';
    process.env.E2E_MOBILE_USERNAME = 'e2e-mobile-user';
    process.env.E2E_MOBILE_PASSWORD = '741258';
    const { requireMutatingStaging } = await loadFixtures();
    expect(() => requireMutatingStaging('desktop-chromium')).not.toThrow();
  });
});
