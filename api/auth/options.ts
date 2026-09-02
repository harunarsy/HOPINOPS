import { listLoginOptions } from '../../src/server/auth';
import { jsonResponse } from '../../src/server/auth';

export async function GET() {
  try {
    return jsonResponse({ options: await listLoginOptions() });
  } catch (error) {
    console.error('Unable to load login options', error);
    return jsonResponse({ error: 'Authentication service is not configured.' }, 503);
  }
}
