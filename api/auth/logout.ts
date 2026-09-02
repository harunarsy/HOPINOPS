import {
  clearedSessionCookie,
  jsonResponse,
  revokeCurrentSession,
} from '../../src/server/auth';

export default {
  async fetch(request: Request) {
    if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
    try {
      await revokeCurrentSession(request);
      return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookie() });
    } catch (error) {
      console.error('Unable to logout', error);
      return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookie() });
    }
  }
};
