/**
 * Shared E2E fixtures and helpers.
 *
 * Mutating tests are staging-only, use a disposable manifest, and are served
 * through a localhost `vercel dev` process. Remote browser targets are denied.
 */
import { existsSync, readFileSync } from 'node:fs';

export type Role = 'OWNER' | 'SUPERVISOR' | 'OPERATOR' | 'INVESTOR';
export const STAGING_PROJECT_REF = process.env.E2E_STAGING_PROJECT_REF ?? '';
export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4173';

type Project = 'desktop' | 'mobile';
type FixtureKind = 'lifecycle' | 'journey' | 'onboarding' | 'investor';

export type FixtureUser = { id: string; username: string; displayName: string; role: string };
export type FixtureManifest = {
  runId: string;
  projectRef: string;
  gps: { latitude: number; longitude: number };
  clientIps: { desktop: string; mobile: string };
  outlets: { desktop: { id: string; code: string }; mobile: { id: string; code: string } };
  users: {
    desktop: Record<FixtureKind, FixtureUser>;
    mobile: Record<FixtureKind, FixtureUser>;
  };
};

function assertStagingRef(projectRef: string) {
  if (!/^[a-z0-9]{20}$/.test(projectRef) || projectRef === 'naanarmoktmsumkxmjvj') {
    throw new Error('Mutating E2E hanya boleh ke project staging remote yang valid; target production ditolak.');
  }
}

function assertSafeBaseUrl(baseUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Mutating E2E URL tidak valid: ${baseUrl}`);
  }
  const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (
    parsed.protocol !== 'http:' ||
    !localHosts.has(parsed.hostname.toLowerCase()) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`Mutating E2E wajib melalui vercel dev lokal yang terhubung staging, bukan host remote: ${baseUrl}`);
  }
}

function projectKey(projectName: string): Project {
  return projectName.includes('mobile') ? 'mobile' : 'desktop';
}

function expectedUsername(runId: string, project: Project, kind: FixtureKind) {
  return `e2e-${runId}-${project === 'desktop' ? 'd' : 'm'}-${kind}`;
}

function assertManifestIsolation(manifest: FixtureManifest) {
  const projects: Project[] = ['desktop', 'mobile'];
  const kinds: FixtureKind[] = ['lifecycle', 'journey', 'onboarding', 'investor'];
  const outletIds = projects.map((project) => manifest.outlets?.[project]?.id);
  const outletCodes = projects.map((project) => manifest.outlets?.[project]?.code);
  if (outletIds.some((id) => !id) || new Set(outletIds).size !== 2) {
    throw new Error('Manifest: desktop dan mobile wajib memakai tepat dua outlet unik.');
  }
  for (const project of projects) {
    if (manifest.outlets[project].code !== `e2e-${manifest.runId}-${project}`) {
      throw new Error(`Manifest: outlet ${project} bukan fixture disposable run ${manifest.runId}.`);
    }
  }
  if (new Set(outletCodes).size !== 2) throw new Error('Manifest: outlet code desktop/mobile wajib berbeda.');
  const ids: string[] = [];
  const usernames: string[] = [];
  for (const project of projects) {
    for (const kind of kinds) {
      const user = manifest.users?.[project]?.[kind];
      if (!user?.id || !user.username || user.username !== expectedUsername(manifest.runId, project, kind)) {
        throw new Error(`Manifest: user ${project}/${kind} bukan fixture disposable yang valid.`);
      }
      ids.push(user.id);
      usernames.push(user.username.toLowerCase());
    }
  }
  if (new Set(ids).size !== 8 || new Set(usernames).size !== 8) {
    throw new Error('Manifest: semua profile ID dan username fixture wajib unik.');
  }
  if (!manifest.clientIps?.desktop || !manifest.clientIps?.mobile || manifest.clientIps.desktop === manifest.clientIps.mobile) {
    throw new Error('Manifest: client IP desktop/mobile wajib berbeda.');
  }
}

function manifestPath(): string {
  return process.env.E2E_FIXTURE_MANIFEST ?? '';
}

export function loadFixtureManifestIfPresent(): FixtureManifest | null {
  const filePath = manifestPath();
  if (!filePath) return null;
  if (!existsSync(filePath)) throw new Error(`E2E_FIXTURE_MANIFEST tidak ditemukan: ${filePath}`);
  const manifest = JSON.parse(readFileSync(filePath, 'utf8')) as FixtureManifest;
  if (manifest.projectRef !== STAGING_PROJECT_REF) {
    throw new Error(`Manifest menolak ref ${manifest.projectRef}; wajib ${STAGING_PROJECT_REF}.`);
  }
  if (!/^[a-z0-9]{4,12}$/.test(manifest.runId ?? '')) throw new Error(`Manifest runId tidak valid: ${manifest.runId}`);
  assertManifestIsolation(manifest);
  return manifest;
}

function fixturePin(): string {
  const pin = process.env.E2E_FIXTURE_PIN ?? '';
  if (!pin) throw new Error('Mutating E2E memerlukan E2E_FIXTURE_PIN untuk manifest disposable.');
  return pin;
}

export function getProjectOutletId(projectName: string): string | null {
  const manifest = loadFixtureManifestIfPresent();
  return manifest?.outlets[projectKey(projectName)].id ?? null;
}

export function getProjectGps(): { latitude: number; longitude: number } | null {
  return loadFixtureManifestIfPresent()?.gps ?? null;
}

export function getLifecycleCredentials(projectName: string): { username: string; pin: string } | null {
  const manifest = loadFixtureManifestIfPresent();
  if (!manifest) return null;
  return { username: manifest.users[projectKey(projectName)].lifecycle.username, pin: fixturePin() };
}

export function getJourneyIdentity(projectName: string): { username: string; displayName: string; pin: string } | null {
  const manifest = loadFixtureManifestIfPresent();
  if (!manifest) return null;
  const user = manifest.users[projectKey(projectName)].journey;
  return { username: user.username, displayName: user.displayName, pin: fixturePin() };
}

export function getOnboardingUsername(projectName: string): string | null {
  return loadFixtureManifestIfPresent()?.users[projectKey(projectName)].onboarding.username ?? null;
}

export function getInvestorUsernameForProject(projectName: string): string {
  const manifest = loadFixtureManifestIfPresent();
  if (!manifest) throw new Error('Mutating E2E memerlukan manifest untuk investor fixture.');
  return manifest.users[projectKey(projectName)].investor.username;
}

export function requireMutatingStaging(projectName = '') {
  if (process.env.E2E_MUTATIONS !== '1') throw new Error('Mutating E2E disabled: set E2E_MUTATIONS=1 explicitly.');
  assertStagingRef(process.env.E2E_STAGING_PROJECT_REF ?? '');
  assertSafeBaseUrl(BASE_URL);
  const manifest = loadFixtureManifestIfPresent();
  if (!manifest) throw new Error('Mutating E2E memerlukan E2E_FIXTURE_MANIFEST disposable per-run.');
  const lifecycle = getLifecycleCredentials(projectName);
  if (!lifecycle?.username || !lifecycle.pin) throw new Error(`Missing manifest credentials for ${projectName || 'default'} project.`);
  return lifecycle;
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
