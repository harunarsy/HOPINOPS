import {
  loginWithPin,
  setSessionCookie,
  type ApiRequest,
  type ApiResponse,
} from '../../src/server/auth';

export default async function handler(request: ApiRequest & { method?: string }, response: ApiResponse & { status: (code: number) => { json: (body: unknown) => unknown } }) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });
  const body = request.body && typeof request.body === 'object' ? request.body as { username?: unknown; pin?: unknown } : {};

  try {
    const result = await loginWithPin(body.username, body.pin);
    if (!result) return response.status(401).json({ error: 'Nama user atau PIN salah.' });
    setSessionCookie(response, result.token);
    return response.status(200).json({ user: result.user });
  } catch (error) {
    console.error('Unable to login', error);
    return response.status(503).json({ error: 'Authentication service is not configured.' });
  }
}
