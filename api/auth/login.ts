import {
  jsonResponse,
  loginWithPin,
  sessionCookie,
} from '../_lib/auth';

export default {
  async fetch(request: Request) {
    if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
    let body: { username?: unknown; pin?: unknown } = {};
    try {
      const parsed = await request.json();
      if (parsed && typeof parsed === 'object') body = parsed as { username?: unknown; pin?: unknown };
    } catch {
      return jsonResponse({ error: 'Request body tidak valid.' }, 400);
    }

    try {
      const result = await loginWithPin(body.username, body.pin);
      if (!result) return jsonResponse({ error: 'Nama user atau PIN salah.' }, 401);
      return jsonResponse({ user: result.user }, 200, { 'Set-Cookie': sessionCookie(result.token) });
    } catch (error) {
      console.error('Unable to login', error);
      return jsonResponse({ error: 'Authentication service is not configured.' }, 503);
    }
  }
};
