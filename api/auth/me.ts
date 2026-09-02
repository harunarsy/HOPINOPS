import { currentUser, type ApiRequest } from '../../src/server/auth';

export default async function handler(request: ApiRequest & { method?: string }, response: { status: (code: number) => { json: (body: unknown) => unknown } }) {
  if (request.method !== 'GET') return response.status(405).json({ error: 'Method not allowed' });
  try {
    return response.status(200).json({ user: await currentUser(request) });
  } catch (error) {
    console.error('Unable to load current user', error);
    return response.status(503).json({ error: 'Authentication service is not configured.' });
  }
}
