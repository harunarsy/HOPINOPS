/**
 * Operator smoke runner. The staging adapter points the local app at remote
 * staging; this runner never targets production directly.
 *
 * Credentials are read from environment variables and are never printed.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { chromium, request as playwrightRequest } from '@playwright/test';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const DEFAULT_BASE_URL = 'http://localhost:3000';
const SAFE_ERROR_PATTERN = /API_ERROR|HTTP\s*\d{3}|request[_ -]?id|PGRST|SQLSTATE|SUPABASE/i;

function fail(message) {
  throw new Error(message);
}

function localBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value || DEFAULT_BASE_URL);
  } catch {
    fail('E2E_BASE_URL tidak valid.');
  }
  if (
    parsed.protocol !== 'http:'
    || !LOCAL_HOSTS.has(parsed.hostname.toLowerCase())
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    fail('Smoke operator hanya boleh memakai origin HTTP localhost/loopback tanpa path atau credential.');
  }
  return parsed.origin;
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) fail(`${name} wajib diisi untuk smoke lokal; nilainya tidak dicetak.`);
  return value;
}

function assertPin(value, name) {
  if (!/^\d{6}$/.test(value)) fail(`${name} harus berupa PIN 6 digit.`);
  return value;
}

function assertUsername(value, name) {
  if (!/^[a-z0-9._-]{1,100}$/i.test(value)) fail(`${name} memiliki format yang tidak valid.`);
  return value;
}

function uuid() {
  return randomUUID();
}

function runDate() {
  // A high-year date gives each local run a practically unique work cycle and
  // never collides with today's operator attendance rules.
  const year = 2050 + (randomBytes(2).readUInt16BE(0) % 7900);
  const month = 1 + (randomBytes(1)[0] % 12);
  const day = 1 + (randomBytes(1)[0] % 28);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function wibToday() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function safeBodyError(body) {
  if (!body || typeof body !== 'object') return '';
  const code = typeof body.error?.code === 'string' ? body.error.code : '';
  return SAFE_ERROR_PATTERN.test(code) ? '' : code;
}

function bodyData(result) {
  return result.body?.data ?? result.body ?? {};
}

function assertStatus(result, expected, label) {
  if (result.status !== expected) {
    const detail = safeBodyError(result.body);
    fail(`${label} gagal (HTTP ${result.status}${detail ? `, ${detail}` : ''}).`);
  }
  return bodyData(result);
}

function assertOk(result, label) {
  if (result.status < 200 || result.status >= 300 || result.body?.ok === false) {
    const detail = safeBodyError(result.body);
    fail(`${label} gagal (HTTP ${result.status}${detail ? `, ${detail}` : ''}).`);
  }
  return bodyData(result);
}

async function createApi(baseUrl, clientIp) {
  const context = await playwrightRequest.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: {
      Origin: baseUrl,
      ...(clientIp ? { 'X-Forwarded-For': clientIp } : {}),
    },
  });

  async function call(method, path, payload) {
    const response = method === 'GET'
      ? await context.get(path)
      : await context.post(path, { data: payload ?? {} });
    // Health is intentionally a tiny text response (`ok`); keep JSON parsing
    // for API endpoints but preserve plain-text bodies for health/readiness.
    const rawBody = await response.text();
    let body = rawBody;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      // Leave non-JSON responses as text so health checks remain deterministic.
    }
    return { status: response.status(), body };
  }

  return {
    context,
    get: (path) => call('GET', path),
    post: (path, payload) => call('POST', path, payload),
  };
}

async function login(api, username, pin) {
  const result = await api.post('/api/auth?action=login', { username, pin });
  return assertStatus(result, 200, 'Login operator');
}

function activeItems(items, area) {
  return (items || [])
    .filter((item) => item?.active !== false && (!area || item.area_code === area))
    .map((item) => ({
      id: item.id,
      decimalScale: Number.isInteger(Number(item.decimal_scale)) ? Number(item.decimal_scale) : 0,
    }))
    .filter((item) => typeof item.id === 'string' && item.id.length > 0);
}

function countedForScale(value, scale) {
  return Number(value.toFixed(Math.max(0, Math.min(scale, 4))));
}

async function claim(api, workDate, shift, area) {
  const result = await api.post('/api/app?action=assignment.claim', {
    work_date: workDate,
    shift_code: shift,
    area_code: area,
    duty_role: 'PRIMARY',
  });
  return assertStatus(result, 200, `${shift} ${area} assignment`);
}

async function cycleState(api, cycleId) {
  return assertStatus(
    await api.get(`/api/app?action=cycle.get&cycle_id=${encodeURIComponent(cycleId)}`),
    200,
    'Muat cycle',
  );
}

async function ensureOpening(api, cycleId, items, label) {
  let reference = assertStatus(
    await api.get(`/api/app?action=opening.reference&cycle_id=${encodeURIComponent(cycleId)}`),
    200,
    `${label} referensi opening`,
  );

  if (reference.state === 'INITIALIZATION_REQUIRED') {
    const missing = new Set(reference.missing_item_ids || []);
    const baselineLines = activeItems(items, null)
      .filter((item) => missing.has(item.id))
      .map((item) => ({ item_id: item.id, counted_qty: countedForScale(1, item.decimalScale) }));
    if (baselineLines.length !== missing.size || baselineLines.length === 0) {
      fail(`${label} baseline tidak lengkap.`);
    }
    const currentCycle = await cycleState(api, cycleId);
    assertStatus(
      await api.post('/api/app?action=cycle.baseline.record', {
        cycle_id: cycleId,
        expected_version: currentCycle.cycle?.version,
        lines: baselineLines,
        reason: 'Pencatatan stok awal sebelum operasional.',
        idempotency_key: uuid(),
      }),
      200,
      `${label} baseline fisik`,
    );
    reference = assertStatus(
      await api.get(`/api/app?action=opening.reference&cycle_id=${encodeURIComponent(cycleId)}`),
      200,
      `${label} referensi opening setelah baseline`,
    );
  }

  if (reference.state !== 'AVAILABLE' || !Array.isArray(reference.lines) || reference.lines.length === 0) {
    fail(`${label} belum memiliki referensi opening yang lengkap.`);
  }

  // Autosave is exercised with a partial draft, then the immutable snapshot is
  // confirmed with the complete set of lines.
  const firstLine = reference.lines[0];
  const draft = assertStatus(
    await api.post('/api/app?action=opening.saveDraft', {
      cycle_id: cycleId,
      expected_version: null,
      idempotency_key: uuid(),
      lines: [{ item_id: firstLine.item_id, counted_qty: Number(firstLine.reference_qty) || 0 }],
    }),
    200,
    `${label} autosave opening`,
  );
  if (!Number.isInteger(draft.version)) fail(`${label} autosave opening tidak mengembalikan versi.`);

  const lines = reference.lines.map((line) => ({
    item_id: line.item_id,
    counted_qty: Number(line.reference_qty) || 0,
    reason_code: null,
    notes: null,
  }));
  assertStatus(
    await api.post('/api/app?action=opening.confirm', { cycle_id: cycleId, lines }),
    200,
    `${label} konfirmasi opening`,
  );
  return lines;
}

async function addMovement(api, cycleId, items, expectedVersion, label, area) {
  const item = activeItems(items, area)[0];
  if (!item) fail(`${label} tidak memiliki item aktif.`);
  const idempotencyKey = uuid();
  const payload = {
    cycle_id: cycleId,
    expected_version: expectedVersion,
    idempotency_key: idempotencyKey,
    client_occurred_at: new Date().toISOString(),
    item_id: item.id,
    direction: 'IN',
    category: 'PURCHASE',
    quantity: countedForScale(1, item.decimalScale),
  };
  const created = assertStatus(
    await api.post('/api/app?action=movement.create', payload),
    200,
    `${label} barang masuk`,
  );
  const movement = created.movement;
  if (!movement?.id || !Number.isInteger(movement.cycle_version)) fail(`${label} movement tidak lengkap.`);

  const replay = assertStatus(
    await api.post('/api/app?action=movement.create', payload),
    200,
    `${label} replay autosave movement`,
  );
  if (replay.movement?.id !== movement.id || replay.movement?.idempotent_replay !== true) {
    fail(`${label} replay movement tidak idempoten.`);
  }
  return { item, movement, version: movement.cycle_version };
}

async function runStockCycle(api, items, { workDate, shift, area }) {
  const label = `${shift} ${area}`;
  const assignmentData = await claim(api, workDate, shift, area);
  const assignment = assignmentData.assignment;
  const cycleId = assignment?.cycle_id;
  if (!cycleId) fail(`${label} tidak mengembalikan cycle.`);

  await ensureOpening(api, cycleId, items, label);
  let cycle = await cycleState(api, cycleId);
  if (cycle.cycle?.status !== 'OPEN') fail(`${label} tidak berada pada status OPEN setelah opening.`);

  const movement = await addMovement(api, cycleId, items, cycle.cycle.version, label, area);
  cycle = await cycleState(api, cycleId);
  if (cycle.cycle?.version !== movement.version) fail(`${label} versi cycle tidak bergerak sesuai movement.`);

  if (shift === 'SIANG') {
    const handover = assertStatus(
      await api.post('/api/app?action=handover.complete', { cycle_id: cycleId }),
      200,
      `${label} handover`,
    );
    if (!handover.handover?.handover_id) fail(`${label} handover tidak lengkap.`);
    return { assignment, cycleId, cycle, movement, closing: null };
  }

  const openingLines = cycle.opening?.stock_opening_lines || [];
  const movementRows = cycle.movements || [];
  const closingLines = activeItems(items, area).map((item) => {
    const opening = openingLines.find((line) => line.item_id === item.id);
    const incoming = movementRows
      .filter((row) => row.item_id === item.id && row.direction === 'IN')
      .reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    const outgoing = movementRows
      .filter((row) => row.item_id === item.id && row.direction === 'OUT')
      .reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    return {
      item_id: item.id,
      counted_qty: countedForScale(Number(opening?.counted_qty || 0) + incoming - outgoing, item.decimalScale),
      reason_code: null,
      notes: null,
    };
  });
  if (closingLines.length === 0) fail(`${label} closing tidak memiliki item.`);
  const closing = assertStatus(
    await api.post('/api/app?action=closing.confirm', { cycle_id: cycleId, lines: closingLines }),
    200,
    `${label} konfirmasi closing`,
  );
  if (!closing.closing?.closing_id) fail(`${label} closing tidak lengkap.`);
  return { assignment, cycleId, cycle: await cycleState(api, cycleId), movement, closing };
}

async function tryAttendance(api, assignment, label) {
  if (!assignment?.id) return 'SKIP: assignment hari ini tidak tersedia';
  const today = wibToday();
  const existing = assertStatus(
    await api.get(`/api/app?action=attendance.mine&from=${encodeURIComponent(today)}`),
    200,
    `${label} baca attendance`,
  );
  const record = (existing.attendance || []).find((row) => row.work_date === today);
  if (record?.check_in_event_id) return 'SKIP: attendance hari ini sudah memiliki check-in';

  const challenge = assertStatus(
    await api.post('/api/app?action=attendance.challenge', { action: 'CHECK_IN' }),
    200,
    `${label} challenge check-in`,
  );
  if (!challenge.challengeId || !challenge.nonce) fail(`${label} challenge check-in tidak lengkap.`);
  const checkedIn = assertStatus(
    await api.post('/api/app?action=attendance.checkIn', {
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      assignmentId: assignment.id,
      idempotencyKey: uuid(),
      samples: [],
      location_failure: 'UNAVAILABLE',
      note: 'Lokasi tidak tersedia saat smoke lokal.',
    }),
    200,
    `${label} check-in`,
  );
  if (!checkedIn.attendance?.id || !checkedIn.event?.server_occurred_at) fail(`${label} check-in tidak bertimestamp.`);

  const checkoutChallenge = assertStatus(
    await api.post('/api/app?action=attendance.challenge', { action: 'CHECK_OUT' }),
    200,
    `${label} challenge check-out`,
  );
  const checkedOut = assertStatus(
    await api.post('/api/app?action=attendance.checkOut', {
      challengeId: checkoutChallenge.challengeId,
      nonce: checkoutChallenge.nonce,
      idempotencyKey: uuid(),
      samples: [],
      location_failure: 'UNAVAILABLE',
      note: 'Lokasi tidak tersedia saat smoke lokal.',
    }),
    200,
    `${label} check-out`,
  );
  if (!checkedOut.attendance?.check_out_event_id || !checkedOut.event?.server_occurred_at) {
    fail(`${label} check-out tidak bertimestamp.`);
  }
  return 'PASS';
}

async function runUiSmoke(baseUrl, displayName) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
    await page.route(/\/api\/auth\?action=login(?:&|$)/, async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: { code: 'AUTH_INVALID', message: 'API_ERROR · HTTP 401 · request_id private' },
        }),
      });
    });
    await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /pilih pengguna|memuat daftar pengguna/i }).waitFor();
    await page.getByRole('button', { name: /pilih pengguna|memuat daftar pengguna/i }).click();
    if (displayName) {
      await page.getByText(displayName, { exact: true }).click();
    } else {
      await page.locator('.user-picker-option').first().click();
    }
    const pin = page.locator('#pin-input-0');
    await pin.fill('9');
    await page.locator('#pin-input-1').fill('9');
    await page.locator('#pin-input-2').fill('9');
    await page.locator('#pin-input-3').fill('9');
    await page.locator('#pin-input-4').fill('9');
    await page.locator('#pin-input-5').fill('9');
    const error = page.locator('.login-error-slot.is-visible');
    await error.waitFor();
    const errorText = (await error.innerText()).trim();
    if (errorText !== 'Nama pengguna atau PIN salah.' || SAFE_ERROR_PATTERN.test(errorText)) {
      fail('UI error login masih membocorkan detail internal.');
    }
    const rail = page.locator('.pin-rail');
    const box = await rail.boundingBox();
    if (!box || box.width <= 0) fail('PIN rail tidak terlihat pada viewport mobile.');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (overflow) fail('Halaman login memiliki overflow horizontal pada viewport mobile.');
  } finally {
    await browser.close();
  }
}

async function main() {
  if (process.env.HOPIN_LOCAL_SMOKE_ACK !== '1') {
    fail('Set HOPIN_LOCAL_SMOKE_ACK=1 untuk mengizinkan smoke operator lokal.');
  }
  const baseUrl = localBaseUrl(process.env.E2E_BASE_URL);
  const username = assertUsername(requiredEnv('HOPIN_LOCAL_SMOKE_USERNAME'), 'HOPIN_LOCAL_SMOKE_USERNAME');
  const pin = assertPin(requiredEnv('HOPIN_LOCAL_SMOKE_PIN'), 'HOPIN_LOCAL_SMOKE_PIN');
  const clientIp = process.env.HOPIN_LOCAL_SMOKE_CLIENT_IP || '127.0.0.1';
  const secondUsername = process.env.HOPIN_LOCAL_SMOKE_SECOND_USERNAME
    ? assertUsername(process.env.HOPIN_LOCAL_SMOKE_SECOND_USERNAME, 'HOPIN_LOCAL_SMOKE_SECOND_USERNAME')
    : null;
  const secondPin = secondUsername
    ? assertPin(requiredEnv('HOPIN_LOCAL_SMOKE_SECOND_PIN'), 'HOPIN_LOCAL_SMOKE_SECOND_PIN')
    : null;
  const api = await createApi(baseUrl, clientIp);
  const secondApi = secondUsername ? await createApi(baseUrl, '127.0.0.2') : null;

  try {
    const health = await api.get('/api/health');
    if (health.status !== 200 || health.body !== 'ok') fail('Health lokal tidak mengembalikan ok.');

    const options = assertStatus(await api.get('/api/auth?action=options'), 200, 'Daftar pengguna');
    const selected = (options.options || []).find((option) => option.username === username);
    if (!selected) fail('Akun smoke lokal tidak ada di daftar pengguna snapshot.');
    await runUiSmoke(baseUrl, selected.display_name);

    const loginUser = await login(api, username, pin);
    if (loginUser.user?.role !== 'OPERATOR') fail('Akun smoke harus ber-role OPERATOR.');
    if (loginUser.user?.force_pin_change) fail('Akun smoke masih wajib mengganti PIN; smoke mutation dihentikan.');
    const boot = assertStatus(await api.get('/api/app?action=bootstrap'), 200, 'Bootstrap operator');
    if (boot.user?.role !== 'OPERATOR' || !boot.outlet?.id || !Array.isArray(boot.items)) {
      fail('Bootstrap operator tidak memiliki outlet, role, atau katalog lengkap.');
    }
    // Outlet settings are intentionally management-only. Verify the operator
    // receives a safe authorization response instead of treating that as a
    // broken operator journey.
    assertStatus(await api.get('/api/app?action=settings.get'), 403, 'Pembatasan pengaturan outlet');
    assertStatus(await api.get('/api/app?action=items.list'), 200, 'Katalog aktif');
    assertStatus(await api.get('/api/app?action=units.list'), 200, 'Daftar satuan');
    assertStatus(await api.get('/api/app?action=checklist.layout&area_code=BAR'), 200, 'Kelompok checklist Bar');
    assertStatus(await api.get('/api/app?action=checklist.layout&area_code=KITCHEN'), 200, 'Kelompok checklist Kitchen');
    assertStatus(await api.get('/api/app?action=sessions.list'), 200, 'Daftar sesi');

    const items = boot.items;
    const siang = await runStockCycle(api, items, { workDate: runDate(), shift: 'SIANG', area: 'BAR' });
    const malam = await runStockCycle(api, items, { workDate: runDate(), shift: 'MALAM', area: 'KITCHEN' });
    // Claim a disposable assignment for today's WIB date so the attendance
    // branch is exercised on every fresh fixture instead of being skipped when
    // the randomized stock cycles fall on another date.
    const attendanceAssignmentData = await claim(api, wibToday(), 'SIANG', 'BAR');
    const attendanceResult = await tryAttendance(api, attendanceAssignmentData.assignment, 'Attendance operator');
    // A fixture operator is not assigned to today's real outlet calendar, so
    // the report endpoint may correctly return forbidden/not-found. Verify
    // that it never becomes an unexpected server error instead of forcing a
    // report mutation into the operator-only path.
    const reportProbe = await api.get(`/api/app?action=report.get&date=${encodeURIComponent(wibToday())}`);
    if (![403, 404].includes(reportProbe.status)) {
      const detail = safeBodyError(reportProbe.body);
      fail(`Probe ringkasan laporan gagal (HTTP ${reportProbe.status}${detail ? `, ${detail}` : ''}).`);
    }

    let reportResult = 'SKIP: second actor belum dikonfigurasi';
    if (secondApi) {
      const secondLoginUser = await login(secondApi, secondUsername, secondPin);
      if (secondLoginUser.user?.role !== 'OPERATOR' || secondLoginUser.user?.force_pin_change) {
        fail('Akun smoke kedua harus operator aktif tanpa force PIN change.');
      }
      const reportDate = runDate();
      const bar = await runStockCycle(api, items, { workDate: reportDate, shift: 'FULL', area: 'BAR' });
      await runStockCycle(secondApi, items, { workDate: reportDate, shift: 'FULL', area: 'KITCHEN' });
      const finance = { cash_real: 0, cash_app: 0, qris_mandiri: 0, debit_mandiri: 0 };
      const savedFinance = assertStatus(
        await api.post('/api/app?action=report.finance.save', {
          work_date: reportDate,
          expected_version: null,
          idempotency_key: uuid(),
          finance,
        }),
        200,
        'Autosave finance',
      );
      if (!Number.isInteger(savedFinance.version)) fail('Autosave finance tidak mengembalikan versi.');
      const submitted = assertStatus(
        await api.post('/api/app?action=report.submit', { work_date: reportDate, finance }),
        200,
        'Submit laporan operator',
      );
      if (submitted.status !== 'SUBMITTED' || !submitted.revision_id) fail('Submit laporan tidak lengkap.');
      reportResult = `PASS (${bar.assignment?.id ? 'dua area' : 'sebagian'})`;
    }

    assertStatus(await api.post('/api/auth?action=logout'), 200, 'Logout operator');
    const afterLogout = await api.get('/api/app?action=bootstrap');
    if (afterLogout.status !== 401) fail('Logout tidak mencabut session operator.');

    console.log('Operator smoke lokal PASS');
    console.log(`- UI login mobile/error: PASS`);
    console.log(`- Bootstrap, katalog, satuan, kelompok, sesi: PASS`);
    console.log(`- Opening + autosave + movement + replay + handover: PASS (${siang.assignment?.id ? 'Bar' : 'n/a'})`);
    console.log(`- Opening + movement + closing: PASS (${malam.assignment?.id ? 'Kitchen' : 'n/a'})`);
    console.log(`- Attendance: ${attendanceResult}`);
    console.log(`- Finance/report dua area: ${reportResult}`);
    console.log('- Logout dan proteksi session: PASS');
  } finally {
    await api.context.dispose();
    await secondApi?.context.dispose();
  }
}

try {
  await main();
} catch (error) {
  console.error(`Operator smoke lokal dihentikan: ${error?.message || 'error tidak terduga.'}`);
  process.exitCode = 1;
}
