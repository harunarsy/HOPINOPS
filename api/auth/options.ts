import { listLoginOptions } from '../../src/server/auth';

export default async function handler(request: { method?: string }, response: { status: (code: number) => { json: (body: unknown) => unknown } }) {
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' });
  try {
    return response.status(200).json({ options: await listLoginOptions() });
  } catch (error) {
    console.error('Unable to load login options', error);
    return response.status(503).json({ error: 'Authentication service is not configured.' });
  }
}
