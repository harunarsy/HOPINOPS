import { currentUser, jsonResponse } from '../../src/server/auth';

export async function GET(request: Request) {
  try {
    return jsonResponse({ user: await currentUser(request) });
  } catch (error) {
    console.error('Unable to load current user', error);
    return jsonResponse({ error: 'Authentication service is not configured.' }, 503);
  }
}
