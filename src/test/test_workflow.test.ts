import { describe, expect, it } from 'vitest';
import {
  assertLocalBaseUrl,
  assertStagingServiceRoleKey,
  assertStagingTarget,
  parseDotEnv,
} from '../../scripts/staging-runtime.mjs';

describe('remote staging workflow guards', () => {
  it('parses a local staging env file without printing or requiring secrets', () => {
    expect(parseDotEnv('# comment\nexport HOPIN_RUNTIME=staging\nHOPIN_STAGING_PROJECT_REF=abcdefghijklmnopqrst\n')).toEqual({
      HOPIN_RUNTIME: 'staging',
      HOPIN_STAGING_PROJECT_REF: 'abcdefghijklmnopqrst',
    });
  });

  it('accepts an allowlisted non-production Supabase project URL', () => {
    expect(assertStagingTarget({
      url: 'https://abcdefghijklmnopqrst.supabase.co',
      projectRef: 'abcdefghijklmnopqrst',
    }).projectRef).toBe('abcdefghijklmnopqrst');
  });

  it('rejects the protected production project and malformed targets', () => {
    expect(() => assertStagingTarget({
      url: 'https://naanarmoktmsumkxmjvj.supabase.co',
      projectRef: 'naanarmoktmsumkxmjvj',
    })).toThrow(/production/i);
    expect(() => assertStagingTarget({
      url: 'http://abcdefghijklmnopqrst.supabase.co',
      projectRef: 'abcdefghijklmnopqrst',
    })).toThrow(/https/i);
  });

  it('rejects a staging database URL from another project', () => {
    expect(() => assertStagingTarget({
      url: 'https://abcdefghijklmnopqrst.supabase.co',
      projectRef: 'abcdefghijklmnopqrst',
      databaseUrl: 'postgresql://postgres:secret@db.otherproject.supabase.co:5432/postgres',
    })).toThrow(/DB project staging/i);
  });

  it('accepts only a loopback browser origin for the local staging server', () => {
    expect(assertLocalBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(() => assertLocalBaseUrl('https://hopinops.vercel.app')).toThrow(/loopback/i);
    expect(() => assertLocalBaseUrl('http://user:pass@localhost:3000/unsafe')).toThrow(/loopback/i);
  });

  it('checks the staging ref embedded in the server key without exposing it', () => {
    const payload = Buffer.from(JSON.stringify({
      role: 'service_role',
      ref: 'abcdefghijklmnopqrst',
    })).toString('base64url');
    const key = `header.${payload}.signature`;
    expect(assertStagingServiceRoleKey(key, 'abcdefghijklmnopqrst')).toBe(true);
    expect(() => assertStagingServiceRoleKey(key, 'otherprojectref123456')).toThrow(/service-role key/i);
  });
});
