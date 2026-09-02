import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import ExcelJS from 'exceljs';
import { currentUser, validateOrigin, type ApiRequest, type AuthProfile } from './auth';

function getAdminClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error('Server Supabase environment is not configured.');
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

function errorResponse(code: string, message: string, status = 400, details?: any) {
  return jsonResponse({
    ok: false,
    request_id: crypto.randomUUID(),
    error: { code, message, details },
  }, status);
}

function successResponse(data: any, version?: number) {
  return jsonResponse({
    ok: true,
    request_id: crypto.randomUUID(),
    data,
    ...(version !== undefined ? { version } : {}),
  });
}

// Haversine formula in meters
function haversineDistanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

export function getWibDate(date = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Convert date to WIB minutes from midnight (0..1439)
export function getWibMinutesOfDay(date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jakarta',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(date);

  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

// Sanitize string to prevent Excel Formula Injection
function sanitizeExcelCell(val: any): any {
  if (typeof val === 'string' && /^[=+\-@]/.test(val)) {
    return `'${val}`;
  }
  return val;
}

async function sha256Buffer(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

async function logAudit(db: SupabaseClient, {
  actor_user_id,
  action,
  entity_type,
  entity_id,
  outlet_id,
  subject_user_id,
  reason,
  metadata_json,
}: {
  actor_user_id?: string;
  action: string;
  entity_type: string;
  entity_id: string;
  outlet_id?: string;
  subject_user_id?: string;
  reason?: string;
  metadata_json?: any;
}) {
  try {
    await db.from('audit_events').insert({
      actor_user_id: actor_user_id || null,
      action,
      entity_type,
      entity_id,
      outlet_id: outlet_id || null,
      subject_user_id: subject_user_id || null,
      reason: reason || null,
      metadata_json: metadata_json || null,
      server_occurred_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Failed to write audit event', err);
  }
}

export default {
  async fetch(request: Request) {
    // CSRF / Origin Validation
    if (!validateOrigin(request)) {
      return errorResponse('ORIGIN_REJECTED', 'Origin request tidak diizinkan (CSRF Protection)', 403);
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (!action) return errorResponse('NOT_FOUND', 'Action tidak ditemukan', 404);

    const user = await currentUser(request);
    if (!user) {
      return errorResponse('AUTH_REQUIRED', 'Sesi tidak valid atau telah berakhir.', 401);
    }

    if (user.force_pin_change && action !== 'changePin' && action !== 'bootstrap') {
      return errorResponse('PIN_CHANGE_REQUIRED', 'Wajib mengganti PIN sebelum melanjutkan.', 403);
    }

    const db = getAdminClient();

    try {
      // 1. BOOTSTRAP
      if (action === 'bootstrap' && request.method === 'GET') {
        const { data: outlet } = await db.from('outlets').select('*').eq('active', true).limit(1).single();
        const { data: settings } = await db.from('outlet_settings').select('*').eq('outlet_id', outlet?.id).single();
        const { data: items } = await db.from('items').select('*').eq('active', true).order('name');
        const { data: shifts } = await db.from('shift_templates').select('*').eq('outlet_id', outlet?.id).eq('active', true);
        const { data: onboarding } = await db.from('onboarding_progress').select('*').eq('profile_id', user.id).maybeSingle();

        const workDate = getWibDate();
        const { data: activeAssignment } = await db
          .from('work_assignments')
          .select('*, work_cycles(*)')
          .eq('profile_id', user.id)
          .eq('work_date', workDate)
          .eq('status', 'ACTIVE')
          .maybeSingle();

        const { data: activeAttendance } = await db
          .from('attendance_records')
          .select('*')
          .eq('profile_id', user.id)
          .eq('work_date', workDate)
          .maybeSingle();

        return successResponse({
          user,
          outlet,
          settings: {
            ...settings,
            latitude: user.role === 'OWNER' || user.role === 'SUPERVISOR' ? settings?.latitude : undefined,
            longitude: user.role === 'OWNER' || user.role === 'SUPERVISOR' ? settings?.longitude : undefined,
          },
          items: items ?? [],
          shifts: shifts ?? [],
          onboarding,
          activeAssignment,
          activeAttendance,
          workDate,
        });
      }

      // 2. DASHBOARD (OWNER / SUPERVISOR)
      if (action === 'dashboard.get' && request.method === 'GET') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Owner & Supervisor yang dapat mengakses dashboard manajemen.', 403);
        }
        const workDate = url.searchParams.get('date') || getWibDate();
        const { data: cycles } = await db.from('work_cycles').select('*, work_assignments(*, profiles(display_name))').eq('work_date', workDate);
        const { data: attendance } = await db.from('attendance_records').select('*, profiles(display_name), attendance_events(*)').eq('work_date', workDate);
        const { data: reports } = await db.from('daily_reports').select('*, daily_report_revisions(*)').eq('work_date', workDate);
        const { data: exceptions } = await db.from('attendance_records').select('*, profiles(display_name)').eq('work_date', workDate).or('lateness_status.eq.LATE,status.eq.REVIEW_REQUIRED,status.eq.MISSING_CHECKOUT');

        return successResponse({
          cycles: cycles ?? [],
          attendance: attendance ?? [],
          reports: reports ?? [],
          exceptions: exceptions ?? [],
        });
      }

      // 3. INVESTOR REPORTS (READ-ONLY)
      if (action === 'investor.reports' && request.method === 'GET') {
        if (user.role !== 'INVESTOR' && user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Investor & Manajemen yang berhak melihat laporan.', 403);
        }
        const { data: reports } = await db
          .from('daily_reports')
          .select('id, work_date, status, current_revision, daily_report_revisions(*, daily_report_finance(*), daily_report_stock_lines(*))')
          .in('status', ['SUBMITTED', 'APPROVED', 'NEEDS_CLARIFICATION'])
          .order('work_date', { ascending: false })
          .limit(30);

        return successResponse({ reports: reports ?? [] });
      }

      // 4. ITEMS LIST & MANAGEMENT
      if (action === 'items.list' && request.method === 'GET') {
        const { data } = await db.from('items').select('*').eq('active', true).order('name');
        return successResponse({ items: data ?? [] });
      }

      if (action === 'items.create' && request.method === 'POST') {
        if (user.role !== 'OWNER') return errorResponse('FORBIDDEN', 'Hanya Owner yang boleh menambah item.', 403);
        const body = (await request.json()) as any;
        const { data, error } = await db.from('items').insert({
          id: body.id,
          area_code: body.area_code,
          name: body.name,
          unit_code: body.unit_code,
          decimal_scale: body.decimal_scale ?? 2,
          low_threshold: body.low_threshold ?? 0,
        }).select().single();
        if (error) return errorResponse('DB_ERROR', error.message, 400);

        await logAudit(db, {
          actor_user_id: user.id,
          action: 'CREATE_ITEM',
          entity_type: 'items',
          entity_id: data.id,
          metadata_json: data,
        });

        return successResponse(data);
      }

      if (action === 'items.update' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh mengubah item.', 403);
        const body = (await request.json()) as any;
        const { data, error } = await db.from('items').update({
          name: body.name,
          unit_code: body.unit_code,
          decimal_scale: body.decimal_scale,
          low_threshold: body.low_threshold,
        }).eq('id', body.id).select().single();
        if (error) return errorResponse('DB_ERROR', error.message, 400);

        await logAudit(db, {
          actor_user_id: user.id,
          action: 'UPDATE_ITEM',
          entity_type: 'items',
          entity_id: body.id,
          metadata_json: data,
        });

        return successResponse(data);
      }

      // 5. ROSTER & SWAP
      if (action === 'roster.list' && request.method === 'GET') {
        const month = url.searchParams.get('month') || getWibDate().slice(0, 7);
        const { data } = await db
          .from('roster_entries')
          .select('*, profiles(username, display_name)')
          .gte('work_date', `${month}-01`)
          .lte('work_date', `${month}-31`)
          .order('work_date', { ascending: true });
        return successResponse({ roster: data ?? [] });
      }

      if (action === 'roster.save' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh mengatur roster.', 403);
        const body = (await request.json()) as any;
        const { data: outlet } = await db.from('outlets').select('id').limit(1).single();

        const { data, error } = await db.from('roster_entries').upsert({
          id: body.id || undefined,
          outlet_id: outlet?.id,
          work_date: body.work_date,
          shift_code: body.shift_code,
          profile_id: body.profile_id,
          expected_area: body.expected_area || null,
          pay_treatment: body.pay_treatment || 'BASE',
          override_reason: body.override_reason || null,
          created_by: user.id,
        }).select().single();
        if (error) return errorResponse('DB_ERROR', error.message, 400);

        await logAudit(db, {
          actor_user_id: user.id,
          action: 'SAVE_ROSTER',
          entity_type: 'roster_entries',
          entity_id: data.id,
          outlet_id: outlet?.id,
          subject_user_id: body.profile_id,
          metadata_json: data,
        });

        return successResponse(data);
      }

      if (action === 'swap.request' && request.method === 'POST') {
        const body = (await request.json()) as any;
        const { data, error } = await db.from('shift_swap_requests').insert({
          roster_entry_id: body.roster_entry_id,
          requested_by: user.id,
          offered_to: body.offered_to,
          status: 'PENDING',
          expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        }).select().single();
        if (error) return errorResponse('DB_ERROR', error.message, 400);

        await logAudit(db, {
          actor_user_id: user.id,
          action: 'REQUEST_SWAP',
          entity_type: 'shift_swap_requests',
          entity_id: data.id,
          subject_user_id: body.offered_to,
        });

        return successResponse(data);
      }

      if (action === 'swap.respond' && request.method === 'POST') {
        const body = (await request.json()) as any;
        const { data: swap } = await db.from('shift_swap_requests').select('*, roster_entries(*)').eq('id', body.swap_id).single();
        if (!swap || swap.offered_to !== user.id || swap.status !== 'PENDING') {
          return errorResponse('FORBIDDEN', 'Swap request tidak valid atau sudah kadaluarsa.', 400);
        }

        if (body.accept) {
          await db.from('shift_swap_requests').update({ status: 'ACCEPTED', responded_at: new Date().toISOString() }).eq('id', swap.id);
          await db.from('roster_entries').update({ profile_id: user.id, status: 'SCHEDULED' }).eq('id', swap.roster_entry_id);
          await logAudit(db, {
            actor_user_id: user.id,
            action: 'ACCEPT_SWAP',
            entity_type: 'shift_swap_requests',
            entity_id: swap.id,
            subject_user_id: swap.requested_by,
          });
        } else {
          await db.from('shift_swap_requests').update({ status: 'DECLINED', responded_at: new Date().toISOString() }).eq('id', swap.id);
          await logAudit(db, {
            actor_user_id: user.id,
            action: 'DECLINE_SWAP',
            entity_type: 'shift_swap_requests',
            entity_id: swap.id,
            subject_user_id: swap.requested_by,
          });
        }
        return successResponse({ ok: true });
      }

      // 6. ASSIGNMENT CLAIM (RPC / TRANSACTIONAL LOCK)
      if (action === 'assignment.claim' && request.method === 'POST') {
        const body = (await request.json()) as any;
        const workDate = body.work_date || getWibDate();
        const { data: outlet } = await db.from('outlets').select('id').limit(1).single();

        // 1. Try invoking PostgreSQL RPC with row-level lock if available
        const { data: rpcRes, error: rpcErr } = await db.rpc('rpc_claim_assignment', {
          p_outlet_id: outlet?.id,
          p_work_date: workDate,
          p_shift_code: body.shift_code,
          p_area_code: body.area_code,
          p_profile_id: user.id,
          p_duty_role: body.duty_role,
        });

        if (rpcErr) {
          if (rpcErr.message && rpcErr.message.includes('PRIMARY_TAKEN')) {
            return errorResponse('PRIMARY_TAKEN', 'Penanggung jawab utama area ini sudah terisi. Anda dapat bergabung sebagai Bantuan.', 409, { can_join_as_helper: true });
          }
        }

        if (rpcRes) {
          const { data: assignment } = await db.from('work_assignments').select('*').eq('id', rpcRes.assignment_id).single();
          const { data: cycle } = await db.from('work_cycles').select('*').eq('id', rpcRes.cycle_id).single();
          return successResponse({ assignment, cycle });
        }

        // Fallback transactional application-level lock check
        let { data: cycle } = await db.from('work_cycles').select('*')
          .eq('outlet_id', outlet?.id)
          .eq('work_date', workDate)
          .eq('shift_code', body.shift_code)
          .eq('area_code', body.area_code)
          .maybeSingle();

        if (!cycle) {
          const { data: newCycle, error: cErr } = await db.from('work_cycles').insert({
            outlet_id: outlet?.id,
            work_date: workDate,
            shift_code: body.shift_code,
            area_code: body.area_code,
            status: 'ACTIVE',
          }).select().single();
          if (cErr) return errorResponse('DB_ERROR', cErr.message, 400);
          cycle = newCycle;
        }

        if (body.duty_role === 'PRIMARY') {
          const { data: existingPrimary } = await db.from('work_assignments')
            .select('id, profile_id')
            .eq('cycle_id', cycle.id)
            .eq('duty_role', 'PRIMARY')
            .eq('status', 'ACTIVE')
            .maybeSingle();

          if (existingPrimary && existingPrimary.profile_id !== user.id) {
            return errorResponse('PRIMARY_TAKEN', 'Penanggung jawab utama area ini sudah terisi. Anda dapat bergabung sebagai Bantuan.', 409, { can_join_as_helper: true });
          }
        }

        const { data: roster } = await db.from('roster_entries')
          .select('*')
          .eq('profile_id', user.id)
          .eq('work_date', workDate)
          .eq('status', 'SCHEDULED')
          .maybeSingle();

        const scheduleDeviation = !roster || roster.shift_code !== body.shift_code;

        const { data: assignment, error: aErr } = await db.from('work_assignments').upsert({
          cycle_id: cycle.id,
          work_date: workDate,
          profile_id: user.id,
          duty_role: body.duty_role,
          status: 'ACTIVE',
          schedule_deviation: scheduleDeviation,
          assigned_at: new Date().toISOString(),
        }, { onConflict: 'cycle_id,profile_id' }).select().single();

        if (aErr) {
          if (aErr.code === '23505') {
            return errorResponse('PRIMARY_TAKEN', 'Penanggung jawab utama area ini sudah terisi. Anda dapat bergabung sebagai Bantuan.', 409, { can_join_as_helper: true });
          }
          return errorResponse('DB_ERROR', aErr.message, 400);
        }

        await logAudit(db, {
          actor_user_id: user.id,
          action: 'CLAIM_ASSIGNMENT',
          entity_type: 'work_assignments',
          entity_id: assignment.id,
          outlet_id: outlet?.id,
          metadata_json: { shift_code: body.shift_code, area_code: body.area_code, duty_role: body.duty_role },
        });

        return successResponse({ assignment, cycle });
      }

      if (action === 'assignment.reset' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh me-reset penugasan.', 403);
        }
        const body = (await request.json()) as any;
        const { data: targetAssignment } = await db.from('work_assignments').select('*, profiles(role)').eq('id', body.assignment_id).single();
        if (!targetAssignment) return errorResponse('NOT_FOUND', 'Penugasan tidak ditemukan.', 404);

        if (user.role === 'SUPERVISOR' && targetAssignment.profiles?.role !== 'OPERATOR') {
          return errorResponse('FORBIDDEN', 'Supervisor hanya boleh me-reset penugasan Operator.', 403);
        }

        await db.from('work_assignments').update({
          status: 'RESET',
          reset_at: new Date().toISOString(),
          reset_by: user.id,
          reset_reason: body.reason || 'Reset oleh manajemen',
        }).eq('id', body.assignment_id);

        await logAudit(db, {
          actor_user_id: user.id,
          subject_user_id: targetAssignment.profile_id,
          action: 'RESET_ASSIGNMENT',
          entity_type: 'work_assignments',
          entity_id: body.assignment_id,
          reason: body.reason,
        });

        return successResponse({ ok: true });
      }

      // 7. ATTENDANCE (WITH ACCURATE TIMEZONE & SHIFT-BASED SCHEDULE)
      if (action === 'attendance.challenge' && request.method === 'POST') {
        const body = (await request.json()) as any;
        const { data: outlet } = await db.from('outlets').select('id').limit(1).single();

        const nonce = crypto.randomUUID() + '-' + Date.now();
        const nonceHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce)).then(buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join(''));

        const { data: challenge, error } = await db.from('attendance_challenges').insert({
          outlet_id: outlet?.id,
          profile_id: user.id,
          action: body.action || 'CHECK_IN',
          nonce_hash: nonceHash,
          expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
        }).select('id, expires_at').single();

        if (error) return errorResponse('DB_ERROR', error.message, 400);
        return successResponse({ challengeId: challenge.id, nonce });
      }

      if (action === 'attendance.checkIn' && request.method === 'POST') {
        const body = (await request.json()) as any;
        const workDate = getWibDate();
        const { data: outlet } = await db.from('outlets').select('id').limit(1).single();
        const { data: settings } = await db.from('outlet_settings').select('*').eq('outlet_id', outlet?.id).single();

        // 1. Validate challenge
        const { data: challenge } = await db.from('attendance_challenges').select('*').eq('id', body.challengeId).eq('profile_id', user.id).maybeSingle();
        if (!challenge || challenge.used_at || new Date(challenge.expires_at).getTime() < Date.now()) {
          return errorResponse('GPS_CHALLENGE_INVALID', 'Challenge absensi tidak valid atau telah kadaluarsa.', 400);
        }

        // 2. Fetch assignment shift to calculate correct shift start time
        let shiftCode = 'SIANG';
        if (body.assignmentId) {
          const { data: asgn } = await db.from('work_assignments').select('work_cycles(shift_code)').eq('id', body.assignmentId).maybeSingle();
          const wc = (asgn as any)?.work_cycles;
          const sc = Array.isArray(wc) ? wc[0]?.shift_code : wc?.shift_code;
          if (sc) shiftCode = sc;
        }

        let scheduledStartMinutes = 11 * 60; // default 11:00
        if (shiftCode === 'MALAM') scheduledStartMinutes = 17 * 60;

        const { data: shiftTpl } = await db.from('shift_templates').select('start_local').eq('code', shiftCode).maybeSingle();
        if (shiftTpl?.start_local) {
          const [h, m] = shiftTpl.start_local.split(':').map(Number);
          scheduledStartMinutes = h * 60 + m;
        }

        // 3. Compute best sample & distance
        let bestSample: any = null;
        let selectedDistance = 999999;
        let selectedAccuracy = 9999;
        let locationStatus = 'UNVERIFIED';
        const riskReasons: string[] = [];
        let riskScore = 0;

        if (settings?.latitude && settings?.longitude && Array.isArray(body.samples) && body.samples.length > 0) {
          for (const s of body.samples) {
            const dist = haversineDistanceM(s.latitude, s.longitude, settings.latitude, settings.longitude);
            if (!bestSample || s.accuracy < bestSample.accuracy || (s.accuracy === bestSample.accuracy && dist < selectedDistance)) {
              bestSample = s;
              selectedDistance = dist;
              selectedAccuracy = s.accuracy;
            }
          }

          if (selectedDistance <= (settings.geofence_radius_m || 100) && selectedAccuracy <= (settings.max_accuracy_m || 50)) {
            locationStatus = 'VERIFIED';
          } else {
            if (selectedDistance > settings.geofence_radius_m) {
              locationStatus = 'OUTSIDE';
              riskReasons.push(`Di luar radius (${selectedDistance}m > ${settings.geofence_radius_m}m)`);
              riskScore += 40;
            }
            if (selectedAccuracy > settings.max_accuracy_m) {
              locationStatus = 'POOR_ACCURACY';
              riskReasons.push(`Akurasi GPS rendah (±${selectedAccuracy}m)`);
              riskScore += 20;
            }
          }
        } else {
          locationStatus = body.locationStatus || 'UNAVAILABLE';
          riskReasons.push('Lokasi tidak tersedia atau tidak diizinkan');
          riskScore += 50;
        }

        if (locationStatus !== 'VERIFIED' && !body.note) {
          return errorResponse('VALIDATION_FAILED', 'Catatan alasan wajib diisi jika lokasi GPS tidak terverifikasi.', 400);
        }

        await db.from('attendance_challenges').update({ used_at: new Date().toISOString() }).eq('id', challenge.id);

        // Calculate accurate WIB lateness
        const currentWibMinutes = getWibMinutesOfDay();
        const lateGrace = settings?.late_grace_minutes ?? 15;
        const latenessStatus = currentWibMinutes > (scheduledStartMinutes + lateGrace) ? 'LATE' : 'ON_TIME';

        const { data: attendance, error: attErr } = await db.from('attendance_records').upsert({
          outlet_id: outlet?.id,
          work_date: workDate,
          profile_id: user.id,
          work_assignment_id: body.assignmentId || null,
          status: locationStatus === 'VERIFIED' ? 'CHECKED_IN' : 'REVIEW_REQUIRED',
          lateness_status: latenessStatus,
          scheduled_start_at: new Date().toISOString(),
        }, { onConflict: 'profile_id,work_date' }).select().single();

        if (attErr) return errorResponse('DB_ERROR', attErr.message, 400);

        const { data: event, error: evErr } = await db.from('attendance_events').insert({
          attendance_id: attendance.id,
          event_type: 'CHECK_IN',
          challenge_id: challenge.id,
          location_status: locationStatus,
          selected_distance_m: selectedDistance < 999999 ? selectedDistance : null,
          selected_accuracy_m: selectedAccuracy < 9999 ? selectedAccuracy : null,
          risk_score: riskScore,
          risk_reasons: riskReasons,
          note: body.note || null,
          idempotency_key: body.idempotencyKey || crypto.randomUUID(),
        }).select().single();

        if (evErr) return errorResponse('DB_ERROR', evErr.message, 400);

        await db.from('attendance_records').update({ check_in_event_id: event.id }).eq('id', attendance.id);

        if (Array.isArray(body.samples)) {
          for (let i = 0; i < body.samples.length; i++) {
            const s = body.samples[i];
            await db.from('attendance_location_samples').insert({
              event_id: event.id,
              latitude: s.latitude,
              longitude: s.longitude,
              accuracy_m: s.accuracy,
              sample_order: i + 1,
            });
          }
        }

        await logAudit(db, {
          actor_user_id: user.id,
          action: 'CHECK_IN',
          entity_type: 'attendance_records',
          entity_id: attendance.id,
          outlet_id: outlet?.id,
          metadata_json: { location_status: locationStatus, lateness_status: latenessStatus, risk_score: riskScore },
        });

        return successResponse({ attendance, event });
      }

      if (action === 'attendance.checkOut' && request.method === 'POST') {
        const body = (await request.json()) as any;
        const workDate = getWibDate();
        const { data: attendance } = await db.from('attendance_records').select('*').eq('profile_id', user.id).eq('work_date', workDate).maybeSingle();
        if (!attendance) return errorResponse('NOT_FOUND', 'Data check-in hari ini belum ditemukan.', 404);

        const { data: outlet } = await db.from('outlets').select('id').limit(1).single();
        const { data: settings } = await db.from('outlet_settings').select('*').eq('outlet_id', outlet?.id).single();

        let selectedDistance = 999999;
        let selectedAccuracy = 9999;
        let locationStatus = 'UNVERIFIED';
        if (settings?.latitude && settings?.longitude && Array.isArray(body.samples) && body.samples.length > 0) {
          const s = body.samples[0];
          selectedDistance = haversineDistanceM(s.latitude, s.longitude, settings.latitude, settings.longitude);
          selectedAccuracy = s.accuracy;
          if (selectedDistance <= (settings.geofence_radius_m || 100) && selectedAccuracy <= (settings.max_accuracy_m || 50)) {
            locationStatus = 'VERIFIED';
          }
        }

        const { data: event } = await db.from('attendance_events').insert({
          attendance_id: attendance.id,
          event_type: 'CHECK_OUT',
          location_status: locationStatus,
          selected_distance_m: selectedDistance < 999999 ? selectedDistance : null,
          selected_accuracy_m: selectedAccuracy < 9999 ? selectedAccuracy : null,
          note: body.note || null,
          idempotency_key: body.idempotencyKey || crypto.randomUUID(),
        }).select().single();

        await db.from('attendance_records').update({
          status: 'CHECKED_OUT',
          check_out_event_id: event?.id,
          scheduled_end_at: new Date().toISOString(),
        }).eq('id', attendance.id);

        await logAudit(db, {
          actor_user_id: user.id,
          action: 'CHECK_OUT',
          entity_type: 'attendance_records',
          entity_id: attendance.id,
          outlet_id: outlet?.id,
          metadata_json: { location_status: locationStatus },
        });

        return successResponse({ ok: true });
      }

      // 8. STOCK CYCLES, OPENING, MOVEMENTS, HANDOVER, CLOSING
      if (action === 'cycle.get' && request.method === 'GET') {
        const cycleId = url.searchParams.get('cycle_id');
        if (!cycleId) return errorResponse('VALIDATION_FAILED', 'cycle_id diperlukan.', 400);

        const { data: cycle } = await db.from('work_cycles').select('*').eq('id', cycleId).single();
        const { data: opening } = await db.from('stock_openings').select('*, stock_opening_lines(*)').eq('cycle_id', cycleId).maybeSingle();
        const { data: movements } = await db.from('stock_movements').select('*').eq('cycle_id', cycleId).order('server_occurred_at', { ascending: false });
        const { data: handover } = await db.from('stock_handovers').select('*, stock_handover_lines(*)').eq('cycle_id', cycleId).maybeSingle();
        const { data: closing } = await db.from('stock_closings').select('*, stock_closing_lines(*)').eq('cycle_id', cycleId).maybeSingle();
        const { data: items } = await db.from('items').select('*').eq('area_code', cycle.area_code).eq('active', true);

        return successResponse({ cycle, opening, movements: movements ?? [], handover, closing, items: items ?? [] });
      }

      if (action === 'opening.confirm' && request.method === 'POST') {
        const body = (await request.json()) as any;
        const { data: assignment } = await db.from('work_assignments')
          .select('duty_role')
          .eq('cycle_id', body.cycle_id)
          .eq('profile_id', user.id)
          .eq('status', 'ACTIVE')
          .maybeSingle();

        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR' && assignment?.duty_role !== 'PRIMARY') {
          return errorResponse('FORBIDDEN', 'Hanya Penanggung Jawab Utama atau Supervisor yang boleh mengonfirmasi stok awal.', 403);
        }

        const { data: opening, error: opErr } = await db.from('stock_openings').upsert({
          cycle_id: body.cycle_id,
          status: 'CONFIRMED',
          confirmed_at: new Date().toISOString(),
          confirmed_by: user.id,
        }, { onConflict: 'cycle_id' }).select().single();

        if (opErr) return errorResponse('DB_ERROR', opErr.message, 400);

        if (Array.isArray(body.lines)) {
          for (const line of body.lines) {
            await db.from('stock_opening_lines').upsert({
              opening_id: opening.id,
              item_id: line.item_id,
              reference_qty: line.reference_qty,
              counted_qty: line.counted_qty,
              variance_qty: line.counted_qty != null ? line.counted_qty - line.reference_qty : 0,
              reason_code: line.reason_code || null,
              notes: line.notes || null,
              updated_by: user.id,
            }, { onConflict: 'opening_id,item_id' });
          }
        }

        await db.from('work_cycles').update({ status: 'OPEN' }).eq('id', body.cycle_id);

        await logAudit(db, {
          actor_user_id: user.id,
          action: 'CONFIRM_OPENING',
          entity_type: 'stock_openings',
          entity_id: opening.id,
          metadata_json: { cycle_id: body.cycle_id, line_count: body.lines?.length },
        });

        return successResponse({ opening });
      }

      if (action === 'movement.create' && request.method === 'POST') {
        const body = (await request.json()) as any;
        const { data: cycle } = await db.from('work_cycles').select('status, movement_cutoff_at').eq('id', body.cycle_id).maybeSingle();
        if (!cycle) return errorResponse('NOT_FOUND', 'Cycle tidak ditemukan.', 404);
        if (cycle.status === 'COMPLETED' || (cycle.movement_cutoff_at && new Date(cycle.movement_cutoff_at).getTime() <= Date.now())) {
          return errorResponse('STATE_CONFLICT', 'Movement ditolak karena cycle shift sudah ditutup/cutoff.', 409);
        }

        const { data: item } = await db.from('items').select('unit_code').eq('id', body.item_id).single();

        const { data: movement, error } = await db.from('stock_movements').insert({
          cycle_id: body.cycle_id,
          item_id: body.item_id,
          direction: body.direction,
          category: body.category,
          quantity: body.quantity,
          unit_code_snapshot: item?.unit_code || 'pcs',
          client_occurred_at: body.client_occurred_at || new Date().toISOString(),
          created_by: user.id,
          idempotency_key: body.idempotency_key || crypto.randomUUID(),
        }).select().single();

        if (error) return errorResponse('DB_ERROR', error.message, 400);

        await logAudit(db, {
          actor_user_id: user.id,
          action: 'CREATE_MOVEMENT',
          entity_type: 'stock_movements',
          entity_id: movement.id,
          metadata_json: { cycle_id: body.cycle_id, item_id: body.item_id, direction: body.direction, quantity: body.quantity },
        });

        return successResponse({ movement });
      }

      if (action === 'closing.confirm' && request.method === 'POST') {
        const body = (await request.json()) as any;
        const { data: assignment } = await db.from('work_assignments')
          .select('duty_role')
          .eq('cycle_id', body.cycle_id)
          .eq('profile_id', user.id)
          .eq('status', 'ACTIVE')
          .maybeSingle();

        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR' && assignment?.duty_role !== 'PRIMARY') {
          return errorResponse('FORBIDDEN', 'Hanya Penanggung Jawab Utama atau Supervisor yang boleh mengonfirmasi closing.', 403);
        }

        const cutoffAt = new Date().toISOString();
        const { data: closing, error: clErr } = await db.from('stock_closings').upsert({
          cycle_id: body.cycle_id,
          status: 'CONFIRMED',
          movement_cutoff_at: cutoffAt,
          confirmed_at: cutoffAt,
          confirmed_by: user.id,
        }, { onConflict: 'cycle_id' }).select().single();

        if (clErr) return errorResponse('DB_ERROR', clErr.message, 400);

        if (Array.isArray(body.lines)) {
          for (const line of body.lines) {
            await db.from('stock_closing_lines').upsert({
              closing_id: closing.id,
              item_id: line.item_id,
              opening_qty: line.opening_qty,
              incoming_qty: line.incoming_qty,
              outgoing_qty: line.outgoing_qty,
              system_qty: line.system_qty,
              counted_qty: line.counted_qty,
              variance_qty: line.counted_qty - line.system_qty,
              reason_code: line.reason_code || null,
              notes: line.notes || null,
            }, { onConflict: 'closing_id,item_id' });
          }
        }

        await db.from('work_cycles').update({ status: 'CLOSING_READY', movement_cutoff_at: cutoffAt }).eq('id', body.cycle_id);

        await logAudit(db, {
          actor_user_id: user.id,
          action: 'CONFIRM_CLOSING',
          entity_type: 'stock_closings',
          entity_id: closing.id,
          metadata_json: { cycle_id: body.cycle_id, line_count: body.lines?.length },
        });

        return successResponse({ closing });
      }

      // 9. DAILY REPORTS & FINANCE (VALIDATING BOTH BAR & KITCHEN READY)
      if (action === 'report.submit' && request.method === 'POST') {
        const body = (await request.json()) as any;
        const workDate = body.work_date || getWibDate();
        const { data: outlet } = await db.from('outlets').select('id').limit(1).single();

        // 1. Verify that user is PRIMARY BAR MALAM/FULL or Supervisor/Owner
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          const { data: asgn } = await db.from('work_assignments')
            .select('duty_role, work_cycles(shift_code, area_code)')
            .eq('profile_id', user.id)
            .eq('work_date', workDate)
            .eq('status', 'ACTIVE')
            .maybeSingle();

          const wc = (asgn as any)?.work_cycles;
          const shiftCode = Array.isArray(wc) ? wc[0]?.shift_code : wc?.shift_code;
          const areaCode = Array.isArray(wc) ? wc[0]?.area_code : wc?.area_code;

          const isBarFinalizer = asgn?.duty_role === 'PRIMARY' &&
            areaCode === 'BAR' &&
            (shiftCode === 'MALAM' || shiftCode === 'FULL');

          if (!isBarFinalizer) {
            return errorResponse('FORBIDDEN', 'Laporan akhir outlet hanya boleh disubmit oleh Penanggung Jawab Utama Bar (Malam/Full) atau Manajemen.', 403);
          }
        }

        // 2. Verify both BAR and KITCHEN cycles exist and have completed closings
        const { data: barClosing } = await db.from('stock_closings').select('id, cycle_id, work_cycles!inner(work_date, area_code)').eq('work_cycles.work_date', workDate).eq('work_cycles.area_code', 'BAR').maybeSingle();
        const { data: kitchenClosing } = await db.from('stock_closings').select('id, cycle_id, work_cycles!inner(work_date, area_code)').eq('work_cycles.work_date', workDate).eq('work_cycles.area_code', 'KITCHEN').maybeSingle();

        // 3. Upsert report
        let { data: report } = await db.from('daily_reports').select('*').eq('outlet_id', outlet?.id).eq('work_date', workDate).maybeSingle();
        if (!report) {
          const { data: newRep } = await db.from('daily_reports').insert({
            outlet_id: outlet?.id,
            work_date: workDate,
            status: 'SUBMITTED',
            current_revision: 1,
          }).select().single();
          report = newRep;
        } else {
          await db.from('daily_reports').update({
            status: 'SUBMITTED',
            current_revision: (report.current_revision ?? 0) + 1,
          }).eq('id', report.id);
        }

        const revisionNum = (report.current_revision ?? 0) + 1;
        const publicId = `HOP-${workDate.replace(/-/g, '')}-R${revisionNum.toString().padStart(2, '0')}`;

        const fin = body.finance;
        const recordedTotal = Number(fin.cash_app) + Number(fin.qris_mandiri) + Number(fin.debit_mandiri);
        const receivedTotal = Number(fin.cash_real) + Number(fin.qris_mandiri) + Number(fin.debit_mandiri);
        const cashDifference = Number(fin.cash_real) - Number(fin.cash_app);

        const { data: rev, error: revErr } = await db.from('daily_report_revisions').insert({
          report_id: report.id,
          revision: revisionNum,
          public_id: publicId,
          status: 'SUBMITTED',
          bar_closing_id: barClosing?.id || null,
          kitchen_closing_id: kitchenClosing?.id || null,
          movement_cutoff_at: new Date().toISOString(),
          submitted_by: user.id,
          payload_checksum: crypto.randomUUID(),
        }).select().single();

        if (revErr) return errorResponse('DB_ERROR', revErr.message, 400);

        await db.from('daily_report_finance').insert({
          revision_id: rev.id,
          cash_real: fin.cash_real,
          cash_app: fin.cash_app,
          qris_mandiri: fin.qris_mandiri,
          debit_mandiri: fin.debit_mandiri,
          recorded_total: recordedTotal,
          received_total: receivedTotal,
          cash_difference: cashDifference,
        });

        // Populate stock snapshot lines
        const { data: allItems } = await db.from('items').select('*').eq('active', true);
        if (allItems) {
          for (const it of allItems) {
            await db.from('daily_report_stock_lines').insert({
              revision_id: rev.id,
              item_id: it.id,
              area_code: it.area_code,
              closing_qty: 0,
              low_threshold_snapshot: it.low_threshold,
              stock_status: 'AMAN',
            });
          }
        }

        await logAudit(db, {
          actor_user_id: user.id,
          action: 'SUBMIT_DAILY_REPORT',
          entity_type: 'daily_report_revisions',
          entity_id: rev.id,
          outlet_id: outlet?.id,
          metadata_json: { public_id: publicId, recorded_total: recordedTotal, cash_difference: cashDifference },
        });

        return successResponse({ report, revision: rev });
      }

      if (action === 'report.review' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang berhak mereview laporan harian.', 403);
        }
        const body = (await request.json()) as any;
        const { data: rev } = await db.from('daily_report_revisions').select('*').eq('id', body.revision_id).single();
        if (!rev) return errorResponse('NOT_FOUND', 'Revisi laporan tidak ditemukan.', 404);

        if (rev.submitted_by === user.id) {
          return errorResponse('SELF_APPROVAL_FORBIDDEN', 'Tidak boleh menyetujui laporan yang dibuat oleh diri sendiri.', 403);
        }

        await db.from('daily_report_revisions').update({
          status: body.status,
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString(),
          review_note: body.note || null,
        }).eq('id', body.revision_id);

        await db.from('daily_reports').update({
          status: body.status,
        }).eq('id', rev.report_id);

        await logAudit(db, {
          actor_user_id: user.id,
          action: `REVIEW_REPORT_${body.status}`,
          entity_type: 'daily_report_revisions',
          entity_id: body.revision_id,
          reason: body.note,
        });

        return successResponse({ ok: true });
      }

      // 10. BONUS OMZET (EQUAL SPLIT)
      if (action === 'bonus.finalize' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh memfinalisasi bonus.', 403);
        }
        const body = (await request.json()) as any;
        const { data: fin } = await db.from('daily_report_finance').select('*, daily_report_revisions(report_id, daily_reports(work_date))').eq('revision_id', body.report_revision_id).single();
        if (!fin) return errorResponse('NOT_FOUND', 'Data finance laporan tidak ditemukan.', 404);

        const recTotal = Number(fin.recorded_total);
        let tierPercent = 0;
        if (recTotal >= 1200000) tierPercent = 7;
        else if (recTotal >= 1000000) tierPercent = 6;
        else if (recTotal >= 600000) tierPercent = 5;

        const poolAmount = Math.round((recTotal * tierPercent) / 100);
        const workDate = (fin as any).daily_report_revisions?.daily_reports?.work_date;

        const { data: attList } = await db.from('attendance_records')
          .select('profile_id, id')
          .eq('work_date', workDate)
          .in('status', ['CHECKED_OUT', 'APPROVED']);

        const uniqueProfiles = Array.from(new Set((attList ?? []).map(a => a.profile_id))).sort();
        const participantCount = uniqueProfiles.length;

        const { data: pool } = await db.from('daily_bonus_pools').upsert({
          report_revision_id: body.report_revision_id,
          recorded_total: recTotal,
          tier_percent: tierPercent,
          pool_amount: poolAmount,
          status: 'FINAL',
        }, { onConflict: 'report_revision_id' }).select().single();

        if (participantCount > 0 && poolAmount > 0) {
          const baseShare = Math.floor(poolAmount / participantCount);
          const remainder = poolAmount - baseShare * participantCount;

          for (let i = 0; i < participantCount; i++) {
            const pId = uniqueProfiles[i];
            const hasRemainder = i < remainder;
            const amount = baseShare + (hasRemainder ? 1 : 0);
            await db.from('daily_bonus_allocations').upsert({
              pool_id: pool.id,
              profile_id: pId,
              amount,
              remainder_awarded: hasRemainder,
            }, { onConflict: 'pool_id,profile_id' });
          }
        }

        await logAudit(db, {
          actor_user_id: user.id,
          action: 'FINALIZE_BONUS',
          entity_type: 'daily_bonus_pools',
          entity_id: pool.id,
          metadata_json: { pool_amount: poolAmount, tier_percent: tierPercent, participant_count: participantCount },
        });

        return successResponse({ pool });
      }

      // 11. PAYROLL PREVIEW & 7-SHEET XLSX EXPORT (REAL COMPENSATION POLICIES & SHA-256 CHECKSUM)
      if (action === 'payroll.export.xlsx' && request.method === 'POST') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh mengekspor payroll.', 403);
        }
        const body = (await request.json()) as any;
        const period = body.period_month || getWibDate().slice(0, 7);

        const { data: outlet } = await db.from('outlets').select('id').limit(1).single();

        // 1. Fetch real compensation policy and employee compensations
        const { data: policy } = await db.from('compensation_policies').select('*').eq('status', 'ACTIVE').limit(1).maybeSingle();
        const { data: employeeCompList } = await db.from('employee_compensations').select('*');

        const { data: profiles } = await db.from('profiles').select('*').eq('active', true);
        const { data: attendance } = await db.from('attendance_records').select('*, profiles(display_name)').gte('work_date', `${period}-01`).lte('work_date', `${period}-31`);
        const { data: leaves } = await db.from('leave_requests').select('*, profiles(display_name)').gte('start_date', `${period}-01`).lte('start_date', `${period}-31`);
        const { data: overtimes } = await db.from('overtime_claims').select('*, attendance_records(work_date, profiles(display_name))').gte('created_at', `${period}-01`);
        const { data: bonuses } = await db.from('daily_bonus_allocations').select('*, profiles(display_name), daily_bonus_pools(*)');
        const { data: adjustments } = await db.from('payroll_adjustments').select('*, payroll_entries(profiles(display_name))');
        const { data: auditEvents } = await db.from('audit_events').select('*, profiles(display_name)').order('server_occurred_at', { ascending: false }).limit(100);

        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'HOPIN Operations Engine';
        workbook.created = new Date();

        // 1. Sheet Summary
        const sSummary = workbook.addWorksheet('Summary');
        sSummary.columns = [
          { header: 'Employee ID', key: 'id', width: 36 },
          { header: 'Nama Lengkap', key: 'name', width: 24 },
          { header: 'Periode', key: 'period', width: 12 },
          { header: 'Gaji Pokok', key: 'base', width: 16 },
          { header: 'Hari Hadir', key: 'days', width: 14 },
          { header: 'Total Bonus', key: 'bonus', width: 16 },
          { header: 'Total Gaji Bersih', key: 'gross', width: 18 },
        ];

        (profiles ?? []).forEach(p => {
          const empComp = employeeCompList?.find(c => c.profile_id === p.id);
          const base = empComp?.monthly_base ? Number(empComp.monthly_base) : (policy?.monthly_base ? Number(policy.monthly_base) : 0);
          const userAtt = (attendance ?? []).filter(a => a.profile_id === p.id && (a.status === 'CHECKED_OUT' || a.status === 'APPROVED'));
          const userBonus = (bonuses ?? []).filter(b => b.profile_id === p.id).reduce((acc, curr) => acc + Number(curr.amount), 0);

          sSummary.addRow({
            id: sanitizeExcelCell(p.id),
            name: sanitizeExcelCell(p.display_name),
            period: sanitizeExcelCell(period),
            base,
            days: userAtt.length,
            bonus: userBonus,
            gross: base + userBonus,
          });
        });

        // 2. Sheet Attendance
        const sAtt = workbook.addWorksheet('Attendance');
        sAtt.columns = [
          { header: 'Tanggal', key: 'date', width: 14 },
          { header: 'Nama', key: 'name', width: 24 },
          { header: 'Status Kehadiran', key: 'status', width: 18 },
          { header: 'Keterlambatan', key: 'late', width: 16 },
        ];
        (attendance ?? []).forEach(a => {
          sAtt.addRow({
            date: sanitizeExcelCell(a.work_date),
            name: sanitizeExcelCell(a.profiles?.display_name),
            status: sanitizeExcelCell(a.status),
            late: sanitizeExcelCell(a.lateness_status),
          });
        });

        // 3. Sheet Exceptions (Leave & Lateness)
        const sExc = workbook.addWorksheet('Exceptions');
        sExc.columns = [
          { header: 'Tanggal', key: 'date', width: 14 },
          { header: 'Nama', key: 'name', width: 24 },
          { header: 'Jenis Izin / Alasan', key: 'type', width: 24 },
          { header: 'Status Review', key: 'status', width: 18 },
        ];
        (leaves ?? []).forEach(l => {
          sExc.addRow({
            date: sanitizeExcelCell(l.start_date),
            name: sanitizeExcelCell(l.profiles?.display_name),
            type: sanitizeExcelCell(`${l.leave_type}: ${l.reason}`),
            status: sanitizeExcelCell(l.status),
          });
        });

        // 4. Sheet Overtime
        const sOt = workbook.addWorksheet('Overtime');
        sOt.columns = [
          { header: 'Tanggal', key: 'date', width: 14 },
          { header: 'Nama', key: 'name', width: 24 },
          { header: 'Menit Aktual', key: 'raw', width: 14 },
          { header: 'Jam Diakui', key: 'credited', width: 14 },
          { header: 'Status', key: 'status', width: 16 },
        ];
        (overtimes ?? []).forEach(o => {
          sOt.addRow({
            date: sanitizeExcelCell((o.attendance_records as any)?.work_date || period),
            name: sanitizeExcelCell((o.attendance_records as any)?.profiles?.display_name),
            raw: o.raw_extra_minutes,
            credited: o.credited_hours,
            status: sanitizeExcelCell(o.status),
          });
        });

        // 5. Sheet Bonus
        const sBon = workbook.addWorksheet('Bonus');
        sBon.columns = [
          { header: 'Nama Operator', key: 'name', width: 24 },
          { header: 'Jumlah Bonus', key: 'amount', width: 18 },
          { header: 'Bonus Tambahan Sisa', key: 'rem', width: 22 },
        ];
        (bonuses ?? []).forEach(b => {
          sBon.addRow({
            name: sanitizeExcelCell(b.profiles?.display_name),
            amount: Number(b.amount),
            rem: b.remainder_awarded ? 'Ya (+1 Rp)' : 'Tidak',
          });
        });

        // 6. Sheet Adjustments
        const sAdj = workbook.addWorksheet('Adjustments');
        sAdj.columns = [
          { header: 'Nama Operator', key: 'name', width: 24 },
          { header: 'Tipe Penyesuaian', key: 'type', width: 20 },
          { header: 'Alasan', key: 'reason', width: 28 },
          { header: 'Jumlah (Rp)', key: 'amount', width: 18 },
        ];
        (adjustments ?? []).forEach(adj => {
          sAdj.addRow({
            name: sanitizeExcelCell((adj.payroll_entries as any)?.profiles?.display_name),
            type: sanitizeExcelCell(adj.adjustment_type),
            reason: sanitizeExcelCell(adj.reason),
            amount: Number(adj.amount),
          });
        });

        // 7. Sheet Audit
        const sAud = workbook.addWorksheet('Audit');
        sAud.columns = [
          { header: 'Waktu Server', key: 'time', width: 24 },
          { header: 'Aktor', key: 'actor', width: 24 },
          { header: 'Aksi', key: 'action', width: 24 },
          { header: 'Keterangan', key: 'reason', width: 32 },
        ];
        (auditEvents ?? []).forEach(ev => {
          sAud.addRow({
            time: sanitizeExcelCell(ev.server_occurred_at),
            actor: sanitizeExcelCell(ev.profiles?.display_name || 'System'),
            action: sanitizeExcelCell(ev.action),
            reason: sanitizeExcelCell(ev.reason || ''),
          });
        });

        const buffer = await workbook.xlsx.writeBuffer();
        const checksum = await sha256Buffer(buffer);
        const base64 = Buffer.from(buffer).toString('base64');
        const filename = `HOPIN-PAYROLL-${period}.xlsx`;

        // Record in payroll_runs and payroll_exports
        const { data: run } = await db.from('payroll_runs').upsert({
          outlet_id: outlet?.id,
          period_month: period,
          status: 'REVIEWED',
          payload_checksum: checksum,
          reviewed_by: user.id,
        }, { onConflict: 'outlet_id,period_month' }).select().single();

        if (run) {
          await db.from('payroll_exports').insert({
            run_id: run.id,
            format: 'XLSX',
            file_path: `payroll/${period}/${filename}`,
            checksum_sha256: checksum,
            generated_by: user.id,
            row_counts: {
              summary: profiles?.length || 0,
              attendance: attendance?.length || 0,
              exceptions: leaves?.length || 0,
              overtime: overtimes?.length || 0,
              bonus: bonuses?.length || 0,
              adjustments: adjustments?.length || 0,
              audit: auditEvents?.length || 0,
            },
          });
        }

        await logAudit(db, {
          actor_user_id: user.id,
          action: 'EXPORT_PAYROLL_XLSX',
          entity_type: 'payroll_exports',
          entity_id: filename,
          outlet_id: outlet?.id,
          metadata_json: { checksum, period },
        });

        return successResponse({
          filename,
          file_base64: base64,
          checksum,
        });
      }

      // 12. ONBOARDING
      if (action === 'onboarding.complete' && request.method === 'POST') {
        const body = (await request.json()) as any;
        const v = body.version || 1;
        await db.from('onboarding_progress').upsert({
          profile_id: user.id,
          onboarding_version: v,
          completed_at: new Date().toISOString(),
        }, { onConflict: 'profile_id,onboarding_version' });

        await logAudit(db, {
          actor_user_id: user.id,
          action: 'COMPLETE_ONBOARDING',
          entity_type: 'onboarding_progress',
          entity_id: user.id,
        });

        return successResponse({ ok: true });
      }

      // 13. USER MANAGEMENT (OWNER)
      if (action === 'users.list' && request.method === 'GET') {
        if (user.role !== 'OWNER' && user.role !== 'SUPERVISOR') {
          return errorResponse('FORBIDDEN', 'Hanya Manajemen yang boleh melihat daftar user.', 403);
        }
        const { data } = await db.from('profiles').select('id, username, display_name, role, active, force_pin_change, deactivated_at').order('display_name');
        return successResponse({ users: data ?? [] });
      }

      if (action === 'users.create' && request.method === 'POST') {
        if (user.role !== 'OWNER') return errorResponse('FORBIDDEN', 'Hanya Owner yang boleh membuat user baru.', 403);
        const body = (await request.json()) as any;
        if (!body.username || !body.display_name || !body.role) {
          return errorResponse('VALIDATION_FAILED', 'Username, nama tampilan, dan role wajib diisi.', 400);
        }

        const tempPin = body.initial_pin || Math.floor(100000 + Math.random() * 900000).toString();
        const { salt, hash } = await import('./auth').then(m => m.hashPin(tempPin));

        const { data: newProfile, error: pErr } = await db.from('profiles').insert({
          username: body.username.toLowerCase().trim(),
          display_name: body.display_name.trim(),
          role: body.role,
          force_pin_change: true,
        }).select().single();

        if (pErr) return errorResponse('DB_ERROR', pErr.message, 400);

        await db.from('operator_credentials').insert({
          profile_id: newProfile.id,
          pin_salt: salt,
          pin_hash: hash,
        });

        await logAudit(db, {
          actor_user_id: user.id,
          subject_user_id: newProfile.id,
          action: 'CREATE_USER',
          entity_type: 'profiles',
          entity_id: newProfile.id,
          metadata_json: { username: newProfile.username, role: newProfile.role },
        });

        return successResponse({ user: newProfile, initial_pin: tempPin });
      }

      return errorResponse('NOT_FOUND', `Action ${action} tidak ditemukan.`, 404);
    } catch (err: any) {
      console.error('API Error:', err);
      return errorResponse('INTERNAL_ERROR', err.message || 'Terjadi kesalahan pada server.', 500);
    }
  },
};
