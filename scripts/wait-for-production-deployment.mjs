const expectedSha = process.env.HOPIN_EXPECTED_SHA;
const productionUrl = process.env.HOPIN_PRODUCTION_URL ?? 'https://hopinops.vercel.app';
const attempts = Math.max(1, Number(process.env.HOPIN_DEPLOY_WAIT_ATTEMPTS) || 60);
const intervalMs = Math.max(1_000, Number(process.env.HOPIN_DEPLOY_WAIT_INTERVAL_MS) || 5_000);

if (!expectedSha) {
  throw new Error('HOPIN_EXPECTED_SHA is required.');
}

let origin;
try {
  const parsed = new URL(productionUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('production URL must be HTTPS without credentials or query parameters.');
  }
  origin = parsed.origin;
} catch (error) {
  throw new Error(`HOPIN_PRODUCTION_URL is invalid: ${error instanceof Error ? error.message : 'unknown error'}`);
}

async function read(path) {
  const response = await fetch(`${origin}${path}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  return { response, body: await response.text() };
}

function wait() {
  return new Promise((resolve) => setTimeout(resolve, intervalMs));
}

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const build = await read('/build-info.json');
    const health = await read('/api/health');
    let commit = '';
    try {
      commit = JSON.parse(build.body)?.commit ?? '';
    } catch {
      commit = '';
    }

    if (build.response.ok && commit === expectedSha && health.response.status === 200 && health.body === 'ok') {
      console.log(`Production alias siap untuk commit ${expectedSha.slice(0, 12)}.`);
      process.exit(0);
    }
  } catch {
    // Vercel may briefly return a build or network error while promotion runs.
  }

  if (attempt < attempts) await wait();
}

throw new Error(`Production alias belum memakai commit ${expectedSha.slice(0, 12)} setelah ${attempts} percobaan.`);
