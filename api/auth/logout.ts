import {
  clearedSessionCookie,
  jsonResponse,
  revokeCurrentSession,
} from '../../src/server/auth';

export async function POST(request: Request) {
  try {
    await revokeCurrentSession(request);
    return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookie() });
  } catch (error) {
    console.error('Unable to logout', error);
    return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookie() });
  }
}
