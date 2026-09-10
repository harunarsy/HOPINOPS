import '@testing-library/dom';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

const realFetch = global.fetch;
global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
  if (url === '/api/health' || url.endsWith('/api/health')) {
    return { ok: true, status: 200, text: async () => 'ok' } as Response;
  }
  return realFetch(input, init);
}) as typeof fetch;

afterEach(() => {
  cleanup();
});
