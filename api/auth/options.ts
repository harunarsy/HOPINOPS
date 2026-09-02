import { jsonResponse, listLoginOptions } from '../_lib/auth';

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
