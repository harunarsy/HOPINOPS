/**
 * One-run local release gate. It never deploys, commits, or touches a remote
 * database. The optional operator flow is explicitly local-only and requires
 * its own acknowledgement and credentials.
 */
import { spawnSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const withOperatorSmoke = args.has('--operator');
const withLocalSync = args.has('--sync-local');
const allowedArgs = new Set(['--operator', '--sync-local']);
for (const arg of args) {
  if (!allowedArgs.has(arg)) {
    console.error(`ops:verify: opsi tidak dikenal: ${arg}`);
    process.exitCode = 2;
    process.exit();
  }
}

function run(command, commandArgs, env = process.env) {
  console.log(`\n> ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error('ops:verify berhenti karena perintah tidak dapat dijalankan.');
    process.exitCode = 1;
    process.exit();
  }
  if ((result.status ?? 1) !== 0) {
    console.error(`ops:verify berhenti setelah ${command} (exit ${result.status ?? 1}).`);
    process.exitCode = result.status ?? 1;
    process.exit();
  }
}

if (withLocalSync) {
  if (process.env.HOPIN_FULL_CLONE_ACK !== '1') {
    console.error('Gunakan HOPIN_FULL_CLONE_ACK=1 bersama --sync-local agar refresh database lokal eksplisit.');
    process.exitCode = 2;
    process.exit();
  }
  run('pnpm', ['db:local:sync']);
}

run('pnpm', ['lint']);
run('pnpm', ['test']);
run('pnpm', ['build']);
run('pnpm', ['test:smoke']);
run('pnpm', ['db:local:verify']);
run('git', ['diff', '--check']);

if (withOperatorSmoke) {
  if (process.env.HOPIN_LOCAL_SMOKE_ACK !== '1') {
    console.error('Gunakan HOPIN_LOCAL_SMOKE_ACK=1 bersama --operator untuk smoke mutasi lokal.');
    process.exitCode = 2;
    process.exit();
  }
  run('pnpm', ['test:operator:local'], {
    ...process.env,
    E2E_BASE_URL: process.env.E2E_BASE_URL || 'http://localhost:3000',
  });
}

console.log('\nops:verify PASS. Semua gate lokal selesai; push ke main tetap langkah eksplisit berikutnya.');
