const deploymentUrl = process.env.HOPIN_DEPLOYMENT_URL;
const productionUrl = process.env.HOPIN_PRODUCTION_URL ?? 'https://hopinops.vercel.app';
const expectedSha = process.env.HOPIN_EXPECTED_SHA;

if (!deploymentUrl || !expectedSha) {
  throw new Error('HOPIN_DEPLOYMENT_URL and HOPIN_EXPECTED_SHA are required.');
}

function normalizeBaseUrl(value, name) {
  let parsed;
  try {
    parsed = new URL(value.startsWith('http') ? value : `https://${value}`);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must be an HTTPS URL without credentials or query parameters.`);
  }
  return parsed.origin;
}

const deploymentOrigin = normalizeBaseUrl(deploymentUrl, 'HOPIN_DEPLOYMENT_URL');
const productionOrigin = normalizeBaseUrl(productionUrl, 'HOPIN_PRODUCTION_URL');

async function fetchText(origin, path) {
  const response = await fetch(`${origin}${path}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  return { response, body };
}

async function verifyBuildInfo(origin, label) {
  const { response, body } = await fetchText(origin, '/build-info.json');
  if (!response.ok) {
    throw new Error(`${label} build info returned HTTP ${response.status}.`);
  }

  let info;
  try {
    info = JSON.parse(body);
  } catch {
    throw new Error(`${label} build info is not valid JSON.`);
  }
  if (info?.commit !== expectedSha) {
    throw new Error(`${label} build commit does not match the workflow commit.`);
  }
}

async function verifyHealth(origin, label) {
  const { response, body } = await fetchText(origin, '/api/health');
  if (response.status !== 200 || body !== 'ok') {
    throw new Error(`${label} health check failed with HTTP ${response.status}.`);
  }
}

await verifyBuildInfo(deploymentOrigin, 'Deployment');
await verifyBuildInfo(productionOrigin, 'Production alias');
await verifyHealth(productionOrigin, 'Production alias');
console.log(`Verified production alias for commit ${expectedSha.slice(0, 12)}.`);
