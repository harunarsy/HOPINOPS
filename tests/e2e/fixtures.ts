/**
 * Shared E2E fixtures and helpers.
 *
 * Phase 1 constraint: no test may mutate production data.
 * Mutating flows require explicit opt-in, an allowlisted staging URL, and
 * disposable credentials. Misconfiguration fails loudly, never skips.
 */

import { existsSync, readFileSync } from 'node:fs';

export type Role = 'OWNER' | 'SUPERVISOR' | 'OPERATOR' | 'INVESTOR';

export const STAGING_PROJECT_REF = 'ibzlxdmnuszcmdzuocwu';

const BLOCKED_E2E_HOSTS = [
  'hopinops.vercel.app',
  'webapp-rose-mu.vercel.app',
  'naanarmoktmsumkxmjvj.supabase.co',
];

export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4173';

export function credentialsForProject(projectName: string) {
  const mobile = projectName.includes('mobile');
  return {
    username: mobile ? process.env.E2E_MOBILE_USERNAME ?? '' : process.env.E2E_DESKTOP_USERNAME ?? '',
    pin: mobile ? process.env.E2E_MOBILE_PASSWORD ?? '' : process.env.E2E_DESKTOP_PASSWORD ?? '',
  };
}

function assertStagingRef(projectRef: string) {
  if (projectRef !== STAGING_PROJECT_REF) {
    throw new Error(`Mutating E2E hanya boleh ke staging ${STAGING_PROJECT_REF}; ditolak ref ${projectRef || '(kosong)'}.`);
  }
}

function assertSafeBaseUrl(baseUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Mutating E2E URL tidak valid: ${baseUrl}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_E2E_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) {
    throw new Error(`Mutating E2E menolak host production: ${baseUrl}`);
  }
}

function assertDistinctProjectCredentials() {
  const desktopUser = (process.env.E2E_DESKTOP_USERNAME ?? '').trim();
  const mobileUser = (process.env.E2E_MOBILE_USERNAME ?? '').trim();
  if (desktopUser && mobileUser && desktopUser.toLowerCase() === mobileUser.toLowerCase()) {
    throw new Error('Desktop dan mobile wajib memakai username disposable berbeda agar tidak berbagi cycle/onboarding.');
  }
  const manifest = loadFixtureManifestIfPresent();
  if (manifest) assertManifestIsolation(manifest);
}

export type FixtureUser = { id: string; username: string; displayName: string; role: string };
export type FixtureManifest = {
  runId: string;
  projectRef: string;
  gps: { latitude: number; longitude: number };
  clientIps: { desktop: string; mobile: string };
  outlets: { desktop: { id: string; code: string }; mobile: { id: string; code: string } };
  users: {
    desktop: { lifecycle: FixtureUser; journey: FixtureUser; onboarding: FixtureUser; investor: FixtureUser };
    mobile: { lifecycle: FixtureUser; journey: FixtureUser; onboarding: FixtureUser; investor: FixtureUser };
  };
};

function manifestPath(): string {
  return process.env.E2E_FIXTURE_MANIFEST ?? '';
}

export function loadFixtureManifestIfPresent(): FixtureManifest | null {
  const p = manifestPath();
  if (!p) return null;
  if (!existsSync(p)) throw new Error(`E2E_FIXTURE_MANIFEST tidak ditemukan: ${p}`);
  const raw = JSON.parse(readFileSync(p, 'utf8')) as FixtureManifest;
  if (raw.projectRef !== STAGING_PROJECT_REF) {
    throw new Error(`Manifest menolak ref ${raw.projectRef}; wajib ${STAGING_PROJECT_REF}.`);
  }
  if (!/^[a-z0-9]{4,12}$/.test(raw.runId ?? '')) throw new Error(`Manifest runId tidak valid: ${raw.runId}`);
  return raw;
}

function assertManifestIsolation(manifest: FixtureManifest) {
  if (manifest.outlets.desktop.id === manifest.outlets.mobile.id) {
    throw new Error('Manifest: desktop dan mobile wajib outlet berbeda.');
  }
  if (manifest.outlets.desktop.code === manifest.outlets.mobile.code) {
    throw new Error('Manifest: outlet code desktop/mobile wajib berbeda.');
  }
  const names: string[] = [];
  for (const project of ['desktop', 'mobile'] as const) {
    for (const kind of ['lifecycle', 'journey', 'onboarding', 'investor'] as const) {
      const u = manifest.users[project][kind];
      if (!u?.username || !u?.id) throw new Error(`Manifest: user ${project}/${kind} tidak lengkap.`);
      names.push(u.username.toLowerCase());
    }
  }
  if (new Set(names).size !== names.length) {
    throw new Error('Manifest: semua username fixture wajib unik agar tidak berbagi state.');
  }
  if (manifest.clientIps.desktop === manifest.clientIps.mobile) {
    throw new Error('Manifest: client IP desktop/mobile wajib berbeda.');
  }
}

function projectKey(projectName: string): 'desktop' | 'mobile' {
  return projectName.includes('mobile') ? 'mobile' : 'desktop';
}

export function getProjectOutletId(projectName: string): string | null {
  const manifest = loadFixtureManifestIfPresent();
  if (!manifest) return null;
  return manifest.outlets[projectKey(projectName)].id;
}

export function getProjectGps(): { latitude: number; longitude: number } | null {
  const manifest = loadFixtureManifestIfPresent();
  return manifest?.gps ?? null;
}

function manifestPinFallback(projectName: string): string {
  return (
    process.env.E2E_FIXTURE_PIN ??
    (projectKey(projectName) === 'mobile' ? process.env.E2E_MOBILE_PASSWORD : process.env.E2E_DESKTOP_PASSWORD) ??
    ''
  );
}

export function getLifecycleCredentials(projectName: string): { username: string; pin: string } | null {
  const manifest = loadFixtureManifestIfPresent();
  if (!manifest) return null;
  const user = manifest.users[projectKey(projectName)].lifecycle;
  return { username: user.username, pin: manifestPinFallback(projectName) };
}

export function getJourneyIdentity(projectName: string): { username: string; displayName: string; pin: string } | null {
  const manifest = loadFixtureManifestIfPresent();
  if (!manifest) return null;
  const user = manifest.users[projectKey(projectName)].journey;
  return { username: user.username, displayName: user.displayName, pin: manifestPinFallback(projectName) };
}

export function getOnboardingUsername(projectName: string): string | null {
  const manifest = loadFixtureManifestIfPresent();
  if (!manifest) return null;
  return manifest.users[projectKey(projectName)].onboarding.username;
}

export function getInvestorUsername(): string | null {
  const manifest = loadFixtureManifestIfPresent();
  // investor per project berbeda; default ke desktop untuk backward compat bila pemanggil tidak tahu project
  if (!manifest) return null;
  return manifest.users.desktop.investor.username;
}

export function getInvestorUsernameForProject(projectName: string): string {
  const manifest = loadFixtureManifestIfPresent();
  if (!manifest) return process.env.E2E_INVESTOR_USERNAME ?? 'e2e-investor';
  return manifest.users[projectKey(projectName)].investor.username;
}

export function requireMutatingStaging(projectName = '') {
  if (process.env.E2E_MUTATIONS !== '1') throw new Error('Mutating E2E disabled: set E2E_MUTATIONS=1 explicitly.');
  const projectRef = process.env.E2E_STAGING_PROJECT_REF ?? '';
  assertStagingRef(projectRef);
  assertSafeBaseUrl(BASE_URL);
  const allowed = (process.env.E2E_STAGING_ALLOWLIST ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  if (!allowed.some((origin) => BASE_URL === origin || BASE_URL.startsWith(`${origin}/`))) throw new Error(`Mutating E2E URL is not allowlisted: ${BASE_URL}`);
  assertDistinctProjectCredentials();
  const manifest = loadFixtureManifestIfPresent();
  if (manifest) {
    const lifecycle = getLifecycleCredentials(projectName);
    if (!lifecycle?.username || !lifecycle?.pin) throw new Error(`Missing manifest credentials for ${projectName || 'default'} project.`);
    return lifecycle;
  }
  const selected = credentialsForProject(projectName);
  if (!selected.username || !selected.pin) throw new Error(`Missing disposable credentials for ${projectName || 'default'} project.`);
  return selected;
}

export const WIB_TZ = 'Asia/Jakarta';

/** Deterministic WIB business date for assertions (YYYY-MM-DD). */
export function wibToday(): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: WIB_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export async function apiGet(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE_URL}${path}`);
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

export async function apiPost(path: string, payload: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
