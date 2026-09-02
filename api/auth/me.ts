import { currentUser, jsonResponse } from '../../src/server/auth';

export default {
  async fetch(request: Request) {
    if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);
    try {
      return jsonResponse({ user: await currentUser(request) });
    } catch (error) {
      console.error('Unable to load current user', error);
      return jsonResponse({ error: 'Authentication service is not configured.' }, 503);
    }
  }
};
