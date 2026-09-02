export type LoginOption = {
  username: string;
  display_name: string;
  job_title: string | null;
};

export type AuthUser = LoginOption & {
  id: string;
  role: string;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'include' });
  const body = await response.json().catch(() => null) as ({ error?: string } & T) | null;
  if (!response.ok) throw new Error(body?.error ?? 'Permintaan tidak dapat diproses.');
  if (!body) throw new Error('Respons server kosong.');
  return body;
}

export async function getLoginOptions() {
  const body = await request<{ options: LoginOption[] }>('/api/auth?action=options');
  return body.options;
}

export async function getCurrentUser() {
  const body = await request<{ user: AuthUser | null }>('/api/auth?action=me');
  return body.user;
}

export async function login(username: string, pin: string) {
  const body = await request<{ user: AuthUser }>('/api/auth?action=login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, pin }),
  });
  return body.user;
}

export async function logout() {
  await request<{ ok: true }>('/api/auth?action=logout', { method: 'POST' });
}
