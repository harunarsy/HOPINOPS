import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('single production database workflow', () => {
  it.each([
    'run-staging-e2e.mjs', 'run-remote-db-tests.mjs',
    'provision-staging-fixtures.mjs', 'teardown-staging-fixtures.mjs',
    'test-concurrency-onboarding.mjs',
  ])('blocks %s before database access even with old opt-in', (script) => {
    expect(() => execFileSync(process.execPath, [`scripts/${script}`], {
      env: { ...process.env, E2E_MUTATIONS: '1', DB_TEST_DISPOSABLE: '1' },
      stdio: 'pipe',
    })).toThrow(/dinonaktifkan/);
  });
  it('blocks direct shell concurrency entry point', () => {
    expect(() => execFileSync('sh', ['scripts/test-remote-db-concurrency.sh'], {
      env: { ...process.env, DB_TEST_DISPOSABLE: '1' }, stdio: 'pipe',
    })).toThrow(/dinonaktifkan/);
  });
});
