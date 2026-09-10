import { describe, expect, it } from 'vitest';

describe('local sandbox safety contracts', () => {
  it('accepts only the protected production Supabase database as source', async () => {
    const { assertProductionDatabaseUrl } = await import('../../scripts/local-sandbox-lib.mjs');
    const source = assertProductionDatabaseUrl('postgresql://readonly:secret@db.naanarmoktmsumkxmjvj.supabase.co:5432/postgres');
    expect(new URL(source).hostname).toBe('db.naanarmoktmsumkxmjvj.supabase.co');
    expect(new URL(source).searchParams.get('sslmode')).toBe('require');
  });

  it('rejects staging, local, and unrelated database targets', async () => {
    const { assertProductionDatabaseUrl } = await import('../../scripts/local-sandbox-lib.mjs');
    expect(() => assertProductionDatabaseUrl('postgresql://user:secret@db.ibzlxdmnuszcmdzuocwu.supabase.co:5432/postgres')).toThrow(/production Supabase/);
    expect(() => assertProductionDatabaseUrl('postgresql://user:secret@127.0.0.1:54322/postgres')).toThrow(/production Supabase/);
    expect(() => assertProductionDatabaseUrl('postgresql://user:secret@db.other-project.supabase.co:5432/postgres')).toThrow(/production Supabase/);
    expect(() => assertProductionDatabaseUrl('postgresql://user@db.naanarmoktmsumkxmjvj.supabase.co:5432/postgres')).toThrow(/password/);
  });

  it('rejects any non-loopback local database or Supabase URL', async () => {
    const { assertLocalDatabaseUrl, assertLocalSupabaseUrl, assertLocalRuntimeTarget } = await import('../../scripts/local-sandbox-lib.mjs');
    expect(assertLocalDatabaseUrl('postgresql://postgres:postgres@127.0.0.1:54322/postgres')).toContain('127.0.0.1');
    expect(assertLocalSupabaseUrl('http://localhost:54321')).toBe('http://localhost:54321');
    expect(() => assertLocalDatabaseUrl('postgresql://user:secret@db.naanarmoktmsumkxmjvj.supabase.co:5432/postgres')).toThrow(/loopback/);
    expect(() => assertLocalSupabaseUrl('https://hopinops.vercel.app')).toThrow(/loopback/);
    expect(() => assertLocalRuntimeTarget({ runtime: 'local', supabaseUrl: 'https://hopinops.vercel.app', databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' })).toThrow(/loopback/);
  });

  it('parses quoted dotenv values without requiring or printing credentials', async () => {
    const { parseDotEnv } = await import('../../scripts/local-sandbox-lib.mjs');
    expect(parseDotEnv('# comment\nexport HOPIN_RUNTIME=local\nHOPIN_LOCAL_PORT="3000"\nEMPTY=')).toEqual({
      HOPIN_RUNTIME: 'local',
      HOPIN_LOCAL_PORT: '3000',
      EMPTY: '',
    });
  });

  it('requires local runtime confirmation before a full clone', async () => {
    const { assertMigrationParity, createManifest } = await import('../../scripts/local-sandbox-lib.mjs');
    expect(() => assertMigrationParity(['0001'], ['0001', '0031'])).toThrow(/belum di production/);
    expect(() => createManifest({
      capturedAt: '2026-09-10T00:00:00.000Z',
      importedAt: '2026-09-10T00:01:00.000Z',
      schemaRevision: '0031',
      sourceTableRows: { 'public.items': { rows: 1, sha256: 'source' } },
      localTableRows: { 'public.items': { rows: 1, sha256: 'local' } },
      snapshotSha256: 'dump',
      snapshotFile: '.local-sandbox/snapshots/file.dump',
      backupFile: '.local-sandbox/backups/file.dump',
    })).toThrow(/public\.items/);
  });
});
