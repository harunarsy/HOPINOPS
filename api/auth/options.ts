import { jsonResponse, listLoginOptions } from '../auth-shared.ts';

export default {
  async fetch() {
    try {
      return jsonResponse({ options: await listLoginOptions() });
    } catch (error) {
      console.error('Unable to load login options', error);
      return jsonResponse({ error: 'Authentication service is not configured.' }, 503);
    }
  }
};
