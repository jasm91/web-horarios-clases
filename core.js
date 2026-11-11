// Reglas del negocio: clases, cupos, paquetes, cancelación y lista de espera.
// Todo lo que cambia saldos o cupos corre dentro de una transacción con la clase bloqueada (FOR UPDATE).
const crypto = require('crypto');
const db = require('./db');

class Regla extends Error { constructor(code, msg, extra) { super(msg); this.code = code; this.extra = extra || {}; } }

const pad = (n) => String(n).padStart(2, '0');
/** Fecha local del estudio (YYYY-MM-DD) de un instante. */
function fechaLocal(ts, offMin) { const d = new Date(new Date(ts).getTime() + offMin * 60000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
/** Hora local HH:MM de un instante. */
function horaLocal(ts, offMin) { const d = new Date(new Date(ts).getTime() + offMin * 60000); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; }
/** Instante (Date) de una fecha y hora LOCALES del estudio. */
function instante(fecha, hhmm, offMin) { const [y, m, d] = fecha.split('-').map(Number); const [h, mi] = hhmm.split(':').map(Number); return new Date(Date.UTC(y, m - 1, d, h, mi) - offMin * 60000); }
function sumarDias(fecha, n) { const [y, m, d] = fecha.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, d + n)); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`; }
function diaSemana(fecha) { const [y, m, d] = fecha.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
const soloDigitos = (s) => String(s || '').replace(/\D/g, '');
const esFecha = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

async function tx(fn) {
  const c = await db.pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}
async function emitir(c, studioId, type, payload) { await c.query('INSERT INTO events (studio_id, type, payload) VALUES ($1, $2, $3)', [studioId, type, JSON.stringify(payload || {})]); }

/** Genera (si faltan) las clases concretas de [desde, desde+dias) a partir de la plantilla semanal. */
async function asegurarClases(studio, desde, dias) {
  const slots = (await db.query('SELECT * FROM slots WHERE studio_id = $1 AND active', [studio.id])).rows;
  if (!slots.length) return;
  const vals = []; const params = [];
  for (let i = 0; i < dias; i++) {
    const f = sumarDias(desde, i); const dow = diaSemana(f);
    for (const s of slots) {
      if (s.dow !== dow) continue;
      const n = params.length;
      params.push(studio.id, s.id, s.discipline_id, instante(f, s.start_time, studio.tz_offset_min).toISOString(), s.duration_min, s.capacity, s.instructor, s.room);
      vals.push(`($${n + 1},$${n + 2},$${n + 3},$${n + 4},$${n + 5},$${n + 6},$${n + 7},$${n + 8})`);
    }
  }
  if (!vals.length) return;
  await db.query(`INSERT INTO sessions (studio_id, slot_id, discipline_id, starts_at, duration_min, capacity, instructor, room) VALUES ${vals.join(',')} ON CONFLICT (slot_id, starts_at) DO NOTHING`, params);
}

/** Horario de [desde, desde+dias): cada clase con sus lugares ocupados y, si hay alumno, su reserva. */
async function horario(studio, desde, dias, studentId) {
  await asegurarClases(studio, desde, dias);
  const a = instante(desde, '00:00', studio.tz_offset_min), b = instante(sumarDias(desde, dias), '00:00', studio.tz_offset_min);
  const r = await db.query(
    `SELECT s.id, s.starts_at, s.duration_min, s.capacity, s.instructor, s.room, s.cancelled, s.discipline_id,
            d.name AS discipline, d.color,
            (SELECT COUNT(*)::int FROM bookings b WHERE b.session_id = s.id AND b.status IN ('booked','attended','no_show')) AS booked,
            (SELECT COUNT(*)::int FROM bookings b WHERE b.session_id = s.id AND b.status = 'waitlist') AS waiting,
            mb.id AS my_booking, mb.status AS my_status
       FROM sessions s JOIN disciplines d ON d.id = s.discipline_id
       LEFT JOIN bookings mb ON mb.session_id = s.id AND mb.student_id = $4 AND mb.status IN ('booked','waitlist','attended','no_show')
      WHERE s.studio_id = $1 AND s.starts_at >= $2 AND s.starts_at < $3 AND d.active
      ORDER BY s.starts_at, d.name`, [studio.id, a.toISOString(), b.toISOString(), studentId || 0]);
  const ahora = Date.now();
  return r.rows.map((s) => ({
    id: s.id, date: fechaLocal(s.starts_at, studio.tz_offset_min), time: horaLocal(s.starts_at, studio.tz_offset_min), starts_at: s.starts_at,
    duration_min: s.duration_min, discipline_id: s.discipline_id, discipline: s.discipline, color: s.color, instructor: s.instructor, room: s.room,
    capacity: s.capacity, booked: s.booked, free: Math.max(0, s.capacity - s.booked), waiting: s.waiting, cancelled: s.cancelled,
    past: new Date(s.starts_at).getTime() <= ahora, my_booking: s.my_booking || null, my_status: s.my_status || null,
  }));
}

/** Paquete con saldo que sirve para una clase: activo o por verificar, sin vencer para ESE día; primero el que vence antes. */
async function paqueteParaClase(c, studentId, startsAt) {
  const r = await c.query(
    `SELECT * FROM student_packages WHERE student_id = $1 AND status IN ('active','pending') AND sessions_used < sessions_total AND expires_at >= $2
      ORDER BY (status = 'active') DESC, expires_at ASC, id ASC LIMIT 1 FOR UPDATE`, [studentId, startsAt]);
  return r.rows[0] || null;
}

async function guardarComprobante(c, studioId, studentId, dataUrl) {
  const m = /^data:(image\/(?:png|jpe?g|webp)|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new Regla('comprobante', 'Subí el comprobante como imagen (JPG, PNG, WEBP) o PDF.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 5 * 1024 * 1024) throw new Regla('comprobante', 'El comprobante pesa más de 5 MB.');
  return (await c.query('INSERT INTO receipts (studio_id, student_id, mime, data) VALUES ($1,$2,$3,$4) RETURNING id', [studioId, studentId, m[1], buf])).rows[0].id;
}

/**
 * Reserva una clase. o = { pay: 'package' | 'single' | 'courtesy', receipt (data URL, solo single), waitlist (bool), source }
 * Devuelve { booking, status: 'booked' | 'waitlist', package? }.
 */
async function reservar(studio, studentId, sessionId, o = {}) {
  return tx(async (c) => {
    const s = (await c.query('SELECT * FROM sessions WHERE id = $1 AND studio_id = $2 FOR UPDATE', [sessionId, studio.id])).rows[0];
    if (!s) throw new Regla('clase', 'Esa clase no existe.');
    if (s.cancelled) throw new Regla('clase', 'Esa clase fue cancelada.');
    if (new Date(s.starts_at).getTime() <= Date.now()) throw new Regla('pasada', 'Esa clase ya empezó.');
    const ya = (await c.query(`SELECT id, status FROM bookings WHERE session_id = $1 AND student_id = $2 AND status IN ('booked','waitlist','attended','no_show')`, [s.id, studentId])).rows[0];
    if (ya) throw new Regla('duplicada', ya.status === 'waitlist' ? 'Ya estás en la lista de espera de esta clase.' : 'Ya tenés una reserva en esta clase.', { booking_id: ya.id });
    const ocupados = (await c.query(`SELECT COUNT(*)::int AS n FROM bookings WHERE session_id = $1 AND status IN ('booked','attended','no_show')`, [s.id])).rows[0].n;
    const source = ['web', 'admin', 'aitana'].includes(o.source) ? o.source : 'web';
    if (ocupados >= s.capacity) {
      if (!o.waitlist) throw new Regla('llena', 'La clase está llena.', { can_waitlist: true });
      const b = (await c.query(`INSERT INTO bookings (studio_id, session_id, student_id, status, pay, source) VALUES ($1,$2,$3,'waitlist','package',$4) RETURNING *`, [studio.id, s.id, studentId, source])).rows[0];
      return { booking: b, status: 'waitlist' };
    }
    let pay = o.pay || 'package', spId = null, recId = null, paquete = null;
    if (pay === 'package') {
      paquete = await paqueteParaClase(c, studentId, s.starts_at);
      if (!paquete) throw new Regla('sin_paquete', 'No tenés un paquete con sesiones disponibles para esa fecha.');
      await c.query('UPDATE student_packages SET sessions_used = sessions_used + 1 WHERE id = $1', [paquete.id]);
      paquete.sessions_used += 1; spId = paquete.id;
    } else if (pay === 'single') {
      if (studio.single_price == null) throw new Regla('sin_suelta', 'Este estudio no vende clases sueltas: hace falta un paquete.');
      recId = await guardarComprobante(c, studio.id, studentId, o.receipt);
      pay = 'single_pending';
    } else if (pay === 'courtesy' && source === 'admin') { pay = 'courtesy'; }
    else throw new Regla('pago', 'Forma de pago inválida.');
    const b = (await c.query(`INSERT INTO bookings (studio_id, session_id, student_id, status, pay, student_package_id, receipt_id, source) VALUES ($1,$2,$3,'booked',$4,$5,$6,$7) RETURNING *`,
      [studio.id, s.id, studentId, pay, spId, recId, source])).rows[0];
    await emitir(c, studio.id, 'booking.created', { booking_id: b.id, student_id: studentId, session_id: s.id, starts_at: s.starts_at, pay, source });
    return { booking: b, status: 'booked', package: paquete ? { id: paquete.id, remaining: paquete.sessions_total - paquete.sessions_used, expires_at: paquete.expires_at } : null };
  });
}

/** Sube al primero de la lista de espera que tenga saldo. Corre dentro de la transacción que liberó el lugar. */
async function promoverEspera(c, studio, session) {
  const libres = session.capacity - (await c.query(`SELECT COUNT(*)::int AS n FROM bookings WHERE session_id = $1 AND status IN ('booked','attended','no_show')`, [session.id])).rows[0].n;
  if (libres <= 0 || session.cancelled || new Date(session.starts_at).getTime() <= Date.now()) return [];
  const cola = (await c.query(`SELECT * FROM bookings WHERE session_id = $1 AND status = 'waitlist' ORDER BY id ASC FOR UPDATE`, [session.id])).rows;
  const subidos = [];
  for (const w of cola) {
    if (subidos.length >= libres) break;
    const p = await paqueteParaClase(c, w.student_id, session.starts_at);
    if (!p) { await emitir(c, studio.id, 'waitlist.spot_open', { booking_id: w.id, student_id: w.student_id, session_id: session.id, starts_at: session.starts_at }); continue; } // sin saldo: se le avisa, no se le reserva
    await c.query('UPDATE student_packages SET sessions_used = sessions_used + 1 WHERE id = $1', [p.id]);
    await c.query(`UPDATE bookings SET status = 'booked', pay = 'package', student_package_id = $2 WHERE id = $1`, [w.id, p.id]);
    await emitir(c, studio.id, 'waitlist.promoted', { booking_id: w.id, student_id: w.student_id, session_id: session.id, starts_at: session.starts_at });
    subidos.push(w.id);
  }
  return subidos;
}

/**
 * Cancela una reserva. Con la anticipación mínima del estudio (cancel_hours) la sesión vuelve al paquete;
 * con menos, se descuenta («late_cancel»). o = { by: 'student' | 'admin', refund: true|false (solo admin, fuerza) }
 */
async function cancelar(studio, bookingId, o = {}) {
  return tx(async (c) => {
    const b = (await c.query('SELECT * FROM bookings WHERE id = $1 AND studio_id = $2 FOR UPDATE', [bookingId, studio.id])).rows[0];
    if (!b) throw new Regla('reserva', 'Esa reserva no existe.');
    if (o.studentId && b.student_id !== o.studentId) throw new Regla('reserva', 'Esa reserva no es tuya.');
    if (!['booked', 'waitlist'].includes(b.status)) throw new Regla('estado', 'Esa reserva ya no está activa.');
    const s = (await c.query('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [b.session_id])).rows[0];
    if (b.status === 'waitlist') {
      await c.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`, [b.id]);
      return { status: 'cancelled', refunded: false, waitlist: true };
    }
    const faltanH = (new Date(s.starts_at).getTime() - Date.now()) / 3600000;
    if (o.by !== 'admin' && faltanH <= 0) throw new Regla('pasada', 'La clase ya empezó: no se puede cancelar.');
    const aTiempo = faltanH >= studio.cancel_hours;
    const devolver = o.by === 'admin' && typeof o.refund === 'boolean' ? o.refund : aTiempo;
    const estado = devolver ? 'cancelled' : 'late_cancel';
    await c.query(`UPDATE bookings SET status = $2, cancelled_at = NOW() WHERE id = $1`, [b.id, estado]);
    let saldo = null;
    if (devolver && b.student_package_id) {
      const p = (await c.query('UPDATE student_packages SET sessions_used = GREATEST(0, sessions_used - 1) WHERE id = $1 RETURNING sessions_total, sessions_used', [b.student_package_id])).rows[0];
      if (p) saldo = p.sessions_total - p.sessions_used;
    }
    await emitir(c, studio.id, 'booking.cancelled', { booking_id: b.id, student_id: b.student_id, session_id: s.id, starts_at: s.starts_at, refunded: devolver, by: o.by || 'student' });
    const subidos = await promoverEspera(c, studio, s);
    return { status: estado, refunded: devolver && !!b.student_package_id, late: !aTiempo, remaining: saldo, promoted: subidos };
  });
}

/** Compra de un paquete desde la web: queda «por verificar» hasta que el estudio aprueba el comprobante; ya se puede reservar con él. */
async function comprarPaquete(studio, studentId, packageId, o = {}) {
  return tx(async (c) => {
    const p = (await c.query('SELECT * FROM packages WHERE id = $1 AND studio_id = $2 AND active', [packageId, studio.id])).rows[0];
    if (!p) throw new Regla('paquete', 'Ese paquete no existe.');
    const admin = o.source === 'admin';
    const recId = admin && !o.receipt ? null : await guardarComprobante(c, studio.id, studentId, o.receipt);
    const sp = (await c.query(
      `INSERT INTO student_packages (studio_id, student_id, package_id, name, sessions_total, price, status, receipt_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, NOW() + ($9 || ' days')::interval) RETURNING *`,
      [studio.id, studentId, p.id, p.name, p.sessions, p.price, admin ? 'active' : 'pending', recId, String(p.valid_days)])).rows[0];
    await emitir(c, studio.id, admin ? 'package.activated' : 'package.pending', { student_package_id: sp.id, student_id: studentId, name: p.name, sessions: p.sessions, expires_at: sp.expires_at });
    return sp;
  });
}

/** El estudio aprueba o rechaza un paquete por verificar. Rechazar cancela las reservas hechas con él. */
async function resolverPaquete(studio, spId, aprobar) {
  return tx(async (c) => {
    const sp = (await c.query('SELECT * FROM student_packages WHERE id = $1 AND studio_id = $2 FOR UPDATE', [spId, studio.id])).rows[0];
    if (!sp) throw new Regla('paquete', 'Ese paquete no existe.');
    if (sp.status !== 'pending') throw new Regla('estado', 'Ese paquete ya fue revisado.');
    if (aprobar) {
      await c.query(`UPDATE student_packages SET status = 'active' WHERE id = $1`, [sp.id]);
      await emitir(c, studio.id, 'package.activated', { student_package_id: sp.id, student_id: sp.student_id, name: sp.name, sessions: sp.sessions_total, expires_at: sp.expires_at });
      return { status: 'active', cancelled_bookings: 0 };
    }
    await c.query(`UPDATE student_packages SET status = 'rejected' WHERE id = $1`, [sp.id]);
    const bs = (await c.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = NOW() WHERE student_package_id = $1 AND status = 'booked' RETURNING id, session_id`, [sp.id])).rows;
    for (const b of bs) { const s = (await c.query('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [b.session_id])).rows[0]; await promoverEspera(c, studio, s); }
    await emitir(c, studio.id, 'package.rejected', { student_package_id: sp.id, student_id: sp.student_id, cancelled_bookings: bs.length });
    return { status: 'rejected', cancelled_bookings: bs.length };
  });
}

/** El estudio aprueba o rechaza el pago de una clase suelta. */
async function resolverSuelta(studio, bookingId, aprobar) {
  return tx(async (c) => {
    const b = (await c.query('SELECT * FROM bookings WHERE id = $1 AND studio_id = $2 FOR UPDATE', [bookingId, studio.id])).rows[0];
    if (!b || b.pay !== 'single_pending') throw new Regla('estado', 'Esa reserva no tiene un pago por verificar.');
    if (aprobar) { await c.query(`UPDATE bookings SET pay = 'single_paid' WHERE id = $1`, [b.id]); await emitir(c, studio.id, 'booking.paid', { booking_id: b.id, student_id: b.student_id }); return { status: 'single_paid' }; }
    await c.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`, [b.id]);
    await emitir(c, studio.id, 'booking.rejected', { booking_id: b.id, student_id: b.student_id });
    if (b.status === 'booked') { const s = (await c.query('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [b.session_id])).rows[0]; await promoverEspera(c, studio, s); }
    return { status: 'cancelled' };
  });
}

/** El estudio cancela una clase entera: se devuelven todas las sesiones. */
async function cancelarClase(studio, sessionId) {
  return tx(async (c) => {
    const s = (await c.query('SELECT * FROM sessions WHERE id = $1 AND studio_id = $2 FOR UPDATE', [sessionId, studio.id])).rows[0];
    if (!s) throw new Regla('clase', 'Esa clase no existe.');
    await c.query('UPDATE sessions SET cancelled = TRUE WHERE id = $1', [s.id]);
    const bs = (await c.query(`UPDATE bookings SET status = 'cancelled', cancelled_at = NOW() WHERE session_id = $1 AND status IN ('booked','waitlist') RETURNING id, student_id, student_package_id`, [s.id])).rows;
    for (const b of bs) if (b.student_package_id) await c.query('UPDATE student_packages SET sessions_used = GREATEST(0, sessions_used - 1) WHERE id = $1', [b.student_package_id]);
    await emitir(c, studio.id, 'session.cancelled', { session_id: s.id, starts_at: s.starts_at, students: bs.map((b) => b.student_id) });
    return { cancelled: bs.length };
  });
}

/** Lo que el alumno ve en «mi cuenta»: paquetes con saldo y vencimiento, y sus reservas. */
async function resumenAlumno(studio, studentId) {
  const st = (await db.query('SELECT id, name, phone, email FROM students WHERE id = $1 AND studio_id = $2', [studentId, studio.id])).rows[0];
  if (!st) return null;
  const pk = (await db.query(
    `SELECT id, name, sessions_total, sessions_used, status, purchased_at, expires_at FROM student_packages
      WHERE student_id = $1 AND status IN ('active','pending') ORDER BY (expires_at < NOW()), expires_at ASC`, [studentId])).rows
    .map((p) => ({ id: p.id, name: p.name, total: p.sessions_total, used: p.sessions_used, remaining: Math.max(0, p.sessions_total - p.sessions_used), status: p.status,
      purchased_at: p.purchased_at, expires_at: p.expires_at, expired: new Date(p.expires_at).getTime() < Date.now(), days_left: Math.max(0, Math.ceil((new Date(p.expires_at).getTime() - Date.now()) / 86400000)) }));
  const bk = (await db.query(
    `SELECT b.id, b.status, b.pay, b.created_at, s.id AS session_id, s.starts_at, s.duration_min, s.instructor, s.room, s.cancelled, d.name AS discipline, d.color
       FROM bookings b JOIN sessions s ON s.id = b.session_id JOIN disciplines d ON d.id = s.discipline_id
      WHERE b.student_id = $1 AND s.starts_at > NOW() - INTERVAL '30 days' ORDER BY s.starts_at ASC`, [studentId])).rows
    .map((b) => ({ id: b.id, status: b.status, pay: b.pay, session_id: b.session_id, starts_at: b.starts_at, date: fechaLocal(b.starts_at, studio.tz_offset_min), time: horaLocal(b.starts_at, studio.tz_offset_min),
      duration_min: b.duration_min, discipline: b.discipline, color: b.color, instructor: b.instructor, room: b.room,
      upcoming: new Date(b.starts_at).getTime() > Date.now(), free_cancel: (new Date(b.starts_at).getTime() - Date.now()) / 3600000 >= studio.cancel_hours }));
  const activos = pk.filter((p) => !p.expired);
  return { student: st, packages: pk, credits: activos.reduce((a, p) => a + p.remaining, 0), upcoming: bk.filter((b) => b.upcoming && ['booked', 'waitlist'].includes(b.status)), history: bk.filter((b) => !b.upcoming || !['booked', 'waitlist'].includes(b.status)).reverse().slice(0, 30) };
}

/** Alta o búsqueda de un alumno por su WhatsApp. */
async function alumnoPorTelefono(studio, phone, name) {
  const ph = soloDigitos(phone);
  if (ph.length < 7 || ph.length > 15) throw new Regla('telefono', 'Escribí tu número de WhatsApp con código de país, solo números.');
  let st = (await db.query('SELECT * FROM students WHERE studio_id = $1 AND phone = $2', [studio.id, ph])).rows[0];
  if (!st) {
    const nm = String(name || '').trim().slice(0, 80);
    if (nm.length < 2) throw new Regla('nombre', 'Decinos tu nombre para crear tu cuenta.', { need_name: true });
    st = (await db.query('INSERT INTO students (studio_id, phone, name) VALUES ($1,$2,$3) ON CONFLICT (studio_id, phone) DO UPDATE SET name = students.name RETURNING *', [studio.id, ph, nm])).rows[0];
  }
  return st;
}

const nuevaClave = () => 'hc_' + crypto.randomBytes(24).toString('base64url');

module.exports = { Regla, tx, fechaLocal, horaLocal, instante, sumarDias, diaSemana, soloDigitos, esFecha, asegurarClases, horario, reservar, cancelar, comprarPaquete,
  resolverPaquete, resolverSuelta, cancelarClase, resumenAlumno, alumnoPorTelefono, nuevaClave, emitir };
