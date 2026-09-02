import {
  clearSessionCookie,
  revokeCurrentSession,
  type ApiRequest,
  type ApiResponse,
} from '../../src/server/auth';

export default async function handler(request: ApiRequest & { method?: string }, response: ApiResponse & { status: (code: number) => { json: (body: unknown) => unknown } }) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });
  try {
    await revokeCurrentSession(request);
    clearSessionCookie(response);
    return response.status(200).json({ ok: true });
  } catch (error) {
    console.error('Unable to logout', error);
    clearSessionCookie(response);
    return response.status(200).json({ ok: true });
  }
}
