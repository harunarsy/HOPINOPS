import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STAGING_REF = 'ibzlxdmnuszcmdzuocwu';

function disposableManifest(runId = 'safe42') {
  const user = (project: 'desktop' | 'mobile', kind: string, number: number) => ({
    id: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    username: `e2e-${runId}-${project === 'desktop' ? 'd' : 'm'}-${kind}`,
    displayName: `E2E ${runId} ${project} ${kind}`.toUpperCase(),
    role: kind === 'investor' ? 'INVESTOR' : 'OPERATOR',
  });
  return {
    runId,
    projectRef: STAGING_REF,
    gps: { latitude: -7.27, longitude: 112.74 },
    clientIps: { desktop: '198.51.100.42', mobile: '198.51.100.44' },
    outlets: {
      desktop: { id: '00000000-0000-4000-8000-000000000101', code: `e2e-${runId}-desktop` },
      mobile: { id: '00000000-0000-4000-8000-000000000102', code: `e2e-${runId}-mobile` },
    },
    users: {
      desktop: {
        lifecycle: user('desktop', 'lifecycle', 1), journey: user('desktop', 'journey', 2), onboarding: user('desktop', 'onboarding', 3), investor: user('desktop', 'investor', 4),
      },
      mobile: {
        lifecycle: user('mobile', 'lifecycle', 5), journey: user('mobile', 'journey', 6), onboarding: user('mobile', 'onboarding', 7), investor: user('mobile', 'investor', 8),
      },
    },
  };
}

describe('E2E fixture contract (tests/e2e/fixtures.ts)', () => {
  const originalEnv = { ...process.env };
  let tempDirectory = '';

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    tempDirectory = mkdtempSync(path.join(tmpdir(), 'hopin-e2e-contract-'));
  });

  afterEach(() => {
    rmSync(tempDirectory, { recursive: true, force: true });
    process.env = originalEnv;
  });

  async function loadFixtures() {
    return await import('../../tests/e2e/fixtures');
  }

  function configureValidMutatingRun() {
    const manifestPath = path.join(tempDirectory, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(disposableManifest()));
    Object.assign(process.env, {
      E2E_MUTATIONS: '1',
      E2E_STAGING_PROJECT_REF: STAGING_REF,
      E2E_BASE_URL: 'http://127.0.0.1:4173',
      E2E_FIXTURE_MANIFEST: manifestPath,
      E2E_FIXTURE_PIN: '741258',
    });
  }

  it('rejects valid 20-char ref selain staging', async () => {
    configureValidMutatingRun();
    process.env.E2E_STAGING_PROJECT_REF = 'aaaaaaaaaaaaaaaaaaaa';
    const { requireMutatingStaging } = await loadFixtures();
    expect(() => requireMutatingStaging('desktop-chromium')).toThrow();
  });

  it('rejects remote custom origin even when caller sets an allowlist', async () => {
    configureValidMutatingRun();
    process.env.E2E_STAGING_ALLOWLIST = 'https://custom-production.example';
    process.env.E2E_BASE_URL = 'https://custom-production.example';
    const { requireMutatingStaging } = await loadFixtures();
    expect(() => requireMutatingStaging('desktop-chromium')).toThrow(/vercel dev lokal/);
  });

  it('rejects a localhost target with credentials, paths, query, or fragment', async () => {
    configureValidMutatingRun();
    process.env.E2E_BASE_URL = 'http://user:pass@localhost:4173/not-root?unsafe=1#unsafe';
    const { requireMutatingStaging } = await loadFixtures();
    expect(() => requireMutatingStaging('desktop-chromium')).toThrow(/vercel dev lokal/);
  });

  it('requires a disposable manifest and fixture pin', async () => {
    configureValidMutatingRun();
    delete process.env.E2E_FIXTURE_MANIFEST;
    const { requireMutatingStaging } = await loadFixtures();
    expect(() => requireMutatingStaging('desktop-chromium')).toThrow(/E2E_FIXTURE_MANIFEST/);

    vi.resetModules();
    configureValidMutatingRun();
    delete process.env.E2E_FIXTURE_PIN;
    const reloaded = await loadFixtures();
    expect(() => reloaded.requireMutatingStaging('desktop-chromium')).toThrow(/E2E_FIXTURE_PIN/);
  });

  it('rejects duplicate fixture identities in manifest', async () => {
    configureValidMutatingRun();
    const manifestPath = process.env.E2E_FIXTURE_MANIFEST!;
    const manifest = disposableManifest();
    manifest.users.mobile.lifecycle.id = manifest.users.desktop.lifecycle.id;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const { requireMutatingStaging } = await loadFixtures();
    expect(() => requireMutatingStaging('desktop-chromium')).toThrow(/profile ID dan username fixture wajib unik/);
  });

  it('accepts a local, pinned staging run with a manifest', async () => {
    configureValidMutatingRun();
    const { requireMutatingStaging } = await loadFixtures();
    expect(requireMutatingStaging('desktop-chromium')).toEqual({ username: 'e2e-safe42-d-lifecycle', pin: '741258' });
  });
});
