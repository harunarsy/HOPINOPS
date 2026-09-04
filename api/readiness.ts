import { createClient } from '@supabase/supabase-js';

const responseHeaders = {
  'Content-Type': 'application/json; charset=utf-8',
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

function jsonResponse(ok: boolean, status: number, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify({ ok }), {
    status,
    headers: { ...responseHeaders, ...extraHeaders },
  });
}

export default {
  async fetch(request: Request) {
    const readinessSecret = process.env.READINESS_SECRET ?? process.env.CRON_SECRET;
    if (!readinessSecret) {
      return jsonResponse(false, 503);
    }

    const authorization = request.headers.get('authorization') ?? '';
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    const authorized = await constantTimeEqual(match?.[1] ?? '', readinessSecret);
    if (!authorized) {
      return jsonResponse(false, 401, { 'WWW-Authenticate': 'Bearer' });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse(false, 405, { Allow: 'GET, HEAD' });
    }

    const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse(false, 503);
    }

    try {
      const db = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      });
      const { error } = await db
        .from('outlets')
        .select('id', { count: 'exact', head: true })
        .limit(1);

      return error ? jsonResponse(false, 503) : jsonResponse(true, 200);
    } catch {
      return jsonResponse(false, 503);
    }
  },
};
