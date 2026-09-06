import { createClient } from '@supabase/supabase-js';

const responseHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

async function constantTimeEqual(actual: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(actual)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const actualBytes = new Uint8Array(actualHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let mismatch = 0;
  for (let index = 0; index < actualBytes.length; index += 1) {
    mismatch |= actualBytes[index] ^ expectedBytes[index];
  }
  return mismatch === 0;
}

function response(status: number, headers: HeadersInit = {}) {
  return new Response(null, { status, headers: { ...responseHeaders, ...headers } });
}

export default {
  async fetch(request: Request) {
    // Vercel Cron invokes configured paths with GET. POST remains available for
    // authenticated manual runs from the operations runbook.
    if (request.method !== 'GET' && request.method !== 'POST') {
      return response(405, { Allow: 'GET, POST' });
    }

    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) return response(503);

    const authorization = request.headers.get('authorization') ?? '';
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (!await constantTimeEqual(match?.[1] ?? '', cronSecret)) {
      return response(401, { 'WWW-Authenticate': 'Bearer' });
    }

    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) return response(503);

    try {
      const db = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      });
      const { error } = await db.rpc('rpc_cleanup_runtime_data');
      return error ? response(503) : response(204);
    } catch {
      return response(503);
    }
  },
};
