/**
 * Shared E2E fixtures and helpers.
 *
 * Phase 1 constraint: no test may mutate production data.
 * Mutating flows require E2E_USERNAME + E2E_PASSWORD (a disposable account
 * on a staging/disposable database). Without them, mutating tests skip.
 */

export type Role = 'OWNER' | 'SUPERVISOR' | 'OPERATOR' | 'INVESTOR';

export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4173';

export const credentials = {
  username: process.env.E2E_USERNAME ?? '',
  pin: process.env.E2E_PASSWORD ?? '',
};

export const canRunMutating = Boolean(credentials.username && credentials.pin);

export function skipIfNoMutating(test: any) {
  test.skip(!canRunMutating, 'E2E_USERNAME/E2E_PASSWORD not set; skipping mutating test');
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
