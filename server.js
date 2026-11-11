// Horarios y reservas de clases por sesiones — API + páginas.
//   /               portada
//   /e/<slug>       página pública del estudio (horario, paquetes, mis reservas)
//   /admin          panel del estudio
//   /api/s/<slug>   API pública · /api/admin  API del panel · /api/integration  API para sistemas externos (Aitana)
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');
const core = require('./core');
const { Regla } = core;

const VERSION = '0.2.0';
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '8mb' }));

// Dentro de otro sistema (CLASES_SCHEMA): el secreto se deriva del suyo y las altas de estudio solo las hace su administrador.
const EMBEBIDO = !!db.esquema;
const _derivado = EMBEBIDO && process.env.JWT_SECRET ? crypto.createHmac('sha256', process.env.JWT_SECRET).update('clases-v1').digest('hex') : null;
const SECRET = process.env.CLASES_SECRET || process.env.APP_SECRET || _derivado || crypto.randomBytes(32).toString('hex');
if (!process.env.CLASES_SECRET && !process.env.APP_SECRET && !_derivado) console.warn('⚠️  [clases] sin secreto fijo: las sesiones se cierran en cada reinicio.');
const _igual = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };

// ── tokens firmados (sin dependencias) ──
function firmar(obj, dias) {
  const body = Buffer.from(JSON.stringify(Object.assign({}, obj, { exp: Date.now() + dias * 86400000 }))).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}
function leer(tok) {
  const [body, sig] = String(tok || '').split('.');
  if (!body || !sig) return null;
  const ok = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (ok.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(ok), Buffer.from(sig))) return null;
  try { const o = JSON.parse(Buffer.from(body, 'base64url').toString()); return o.exp > Date.now() ? o : null; } catch (e) { return null; }
}
const bearer = (req) => (/^Bearer (.+)$/.exec(req.headers.authorization || '') || [])[1];

// ── límite simple de intentos (por IP y clave) ──
const _hits = new Map();
function limite(clave, max, ventanaMs) {
  const t = Date.now(); const a = (_hits.get(clave) || []).filter((x) => t - x < ventanaMs);
  a.push(t); _hits.set(clave, a);
  if (_hits.size > 5000) for (const [k, v] of _hits) if (!v.length || t - v[v.length - 1] > ventanaMs) _hits.delete(k);
  return a.length <= max;
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  if (e instanceof Regla) return res.status(e.code === 'llena' || e.code === 'duplicada' ? 409 : 400).json(Object.assign({ ok: false, code: e.code, error: e.message }, e.extra));
  console.error('[error]', req.method, req.path, e.message);
  res.status(500).json({ ok: false, error: 'Algo falló de nuestro lado. Probá de nuevo.' });
});

const publico = (s) => ({ slug: s.slug, name: s.name, color: s.color, intro: s.intro, address: s.address, whatsapp: s.whatsapp, cancel_hours: s.cancel_hours,
  days_ahead: s.days_ahead, single_price: s.single_price == null ? null : Number(s.single_price), currency: s.currency, qr_image: s.qr_image, qr_holder: s.qr_holder, tz_offset_min: s.tz_offset_min });

// ═════════════════════ API PÚBLICA ═════════════════════
const pub = express.Router({ mergeParams: true });
pub.use(wrap(async (req, res, next) => {
  const s = (await db.query('SELECT * FROM studios WHERE slug = $1', [String(req.params.slug || '').toLowerCase()])).rows[0];
  if (!s) return res.status(404).json({ ok: false, error: 'No encontramos ese estudio.' });
  req.studio = s;
  const t = leer(bearer(req));
  req.studentId = t && t.k === 'st' && t.s === s.id ? t.id : null;
  next();
}));
const conAlumno = (req, res, next) => (req.studentId ? next() : res.status(401).json({ ok: false, code: 'login', error: 'Entrá con tu WhatsApp para continuar.' }));

pub.get('/info', wrap(async (req, res) => {
  const [d, p] = await Promise.all([
    db.query('SELECT id, name, color, description FROM disciplines WHERE studio_id = $1 AND active ORDER BY sort, name', [req.studio.id]),
    db.query('SELECT id, name, sessions, price, valid_days FROM packages WHERE studio_id = $1 AND active ORDER BY sort, sessions', [req.studio.id]),
  ]);
  res.json({ ok: true, studio: publico(req.studio), today: core.fechaLocal(Date.now(), req.studio.tz_offset_min), disciplines: d.rows, packages: p.rows.map((x) => Object.assign(x, { price: Number(x.price) })) });
}));

pub.get('/schedule', wrap(async (req, res) => {
  const hoy = core.fechaLocal(Date.now(), req.studio.tz_offset_min);
  let desde = core.esFecha(req.query.from) ? req.query.from : hoy;
  const tope = core.sumarDias(hoy, req.studio.days_ahead);
  if (desde < core.sumarDias(hoy, -7)) desde = core.sumarDias(hoy, -7);
  const dias = Math.min(14, Math.max(1, parseInt(req.query.days, 10) || 7));
  const clases = (await core.horario(req.studio, desde, dias, req.studentId)).filter((c) => c.date <= tope);
  res.json({ ok: true, from: desde, days: dias, today: hoy, bookable_until: tope, sessions: clases });
}));

// Entrar o crear la cuenta: WhatsApp + PIN de 4 a 6 dígitos (el nombre solo la primera vez)
pub.post('/auth', wrap(async (req, res) => {
  if (!limite('auth:' + req.ip, 20, 600000)) return res.status(429).json({ ok: false, error: 'Demasiados intentos. Esperá unos minutos.' });
  const b = req.body || {}; const pin = String(b.pin || '');
  if (!/^\d{4,6}$/.test(pin)) throw new Regla('pin', 'El PIN son 4 a 6 números.');
  const ph = core.soloDigitos(b.phone);
  let st = (await db.query('SELECT * FROM students WHERE studio_id = $1 AND phone = $2', [req.studio.id, ph])).rows[0];
  let nuevo = false;
  if (!st) { st = await core.alumnoPorTelefono(req.studio, ph, b.name); nuevo = true; }
  if (!st.pin_hash) await db.query('UPDATE students SET pin_hash = $1 WHERE id = $2', [await bcrypt.hash(pin, 8), st.id]);
  else if (!(await bcrypt.compare(pin, st.pin_hash))) {
    if (!limite('pin:' + req.studio.id + ':' + ph, 6, 900000)) return res.status(429).json({ ok: false, error: 'Demasiados intentos con ese número. Esperá 15 minutos o pedile al estudio que te restablezca el PIN.' });
    throw new Regla('pin', 'PIN incorrecto.');
  }
  res.json({ ok: true, created: nuevo, token: firmar({ k: 'st', s: req.studio.id, id: st.id }, 90), student: { id: st.id, name: st.name, phone: st.phone } });
}));

pub.get('/me', conAlumno, wrap(async (req, res) => {
  const r = await core.resumenAlumno(req.studio, req.studentId);
  if (!r) return res.status(401).json({ ok: false, code: 'login', error: 'Entrá de nuevo.' });
  res.json(Object.assign({ ok: true }, r));
}));

pub.post('/book', conAlumno, wrap(async (req, res) => {
  const b = req.body || {};
  const r = await core.reservar(req.studio, req.studentId, parseInt(b.session_id, 10), { pay: b.pay === 'single' ? 'single' : 'package', receipt: b.receipt, waitlist: !!b.waitlist, source: 'web' });
  res.json({ ok: true, status: r.status, booking_id: r.booking.id, package: r.package });
}));

pub.post('/bookings/:id/cancel', conAlumno, wrap(async (req, res) => {
  res.json(Object.assign({ ok: true }, await core.cancelar(req.studio, parseInt(req.params.id, 10), { by: 'student', studentId: req.studentId })));
}));

pub.post('/packages/buy', conAlumno, wrap(async (req, res) => {
  const sp = await core.comprarPaquete(req.studio, req.studentId, parseInt((req.body || {}).package_id, 10), { receipt: (req.body || {}).receipt, source: 'web' });
  res.json({ ok: true, student_package_id: sp.id, status: sp.status, expires_at: sp.expires_at });
}));
app.use('/api/s/:slug', pub);

// ═════════════════════ ALTA DE ESTUDIO Y PANEL ═════════════════════
const slugOk = (s) => /^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/.test(s);
const colorOk = (c) => /^#[0-9a-fA-F]{6}$/.test(String(c || ''));

app.post('/api/studios', wrap(async (req, res) => {
  if (!limite('alta:' + req.ip, 5, 3600000)) return res.status(429).json({ ok: false, error: 'Demasiadas altas desde esta conexión.' });
  const b = req.body || {};
  if (EMBEBIDO) { // el alta de estudios la hace solo el administrador de la plataforma
    if (!_igual(req.headers['x-admin-token'], process.env.ADMIN_TOKEN) && !_igual(b.setup_key, process.env.CLASES_SETUP_KEY)) return res.status(403).json({ ok: false, error: 'El alta de estudios la hace el equipo de la plataforma.' });
  } else if (process.env.SETUP_KEY && b.setup_key !== process.env.SETUP_KEY) return res.status(403).json({ ok: false, error: 'Clave de alta incorrecta.' });
  const slug = String(b.slug || '').toLowerCase().trim(), name = String(b.name || '').trim().slice(0, 80), email = String(b.email || '').toLowerCase().trim();
  if (!slugOk(slug)) throw new Regla('slug', 'La dirección va en minúsculas, con letras, números y guiones (3 a 40).');
  if (name.length < 2) throw new Regla('nombre', 'Falta el nombre del estudio.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Regla('email', 'Correo inválido.');
  if (String(b.password || '').length < 8) throw new Regla('clave', 'La contraseña necesita al menos 8 caracteres.');
  const ya = (await db.query('SELECT 1 FROM studios WHERE slug = $1 OR admin_email = $2', [slug, email])).rows[0];
  if (ya) throw new Regla('existe', 'Ya hay un estudio con esa dirección o ese correo.');
  const s = (await db.query(`INSERT INTO studios (slug, name, color, admin_email, admin_pass_hash, integration_key) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [slug, name, colorOk(b.color) ? b.color : '#f97316', email, await bcrypt.hash(String(b.password), 10), core.nuevaClave()])).rows[0];
  res.json({ ok: true, slug: s.slug, token: firmar({ k: 'ad', s: s.id }, 30) });
}));

const adm = express.Router();
adm.post('/login', wrap(async (req, res) => {
  if (!limite('adlogin:' + req.ip, 10, 600000)) return res.status(429).json({ ok: false, error: 'Demasiados intentos. Esperá unos minutos.' });
  const s = (await db.query('SELECT * FROM studios WHERE admin_email = $1', [String((req.body || {}).email || '').toLowerCase().trim()])).rows[0];
  if (!s || !(await bcrypt.compare(String((req.body || {}).password || ''), s.admin_pass_hash))) return res.status(401).json({ ok: false, error: 'Correo o contraseña incorrectos.' });
  res.json({ ok: true, token: firmar({ k: 'ad', s: s.id }, 30), slug: s.slug });
}));
adm.use(wrap(async (req, res, next) => {
  const t = leer(bearer(req));
  const s = t && t.k === 'ad' ? (await db.query('SELECT * FROM studios WHERE id = $1', [t.s])).rows[0] : null;
  if (!s) return res.status(401).json({ ok: false, code: 'login', error: 'Iniciá sesión.' });
  req.studio = s; next();
}));

adm.get('/studio', wrap(async (req, res) => res.json({ ok: true, studio: Object.assign(publico(req.studio), { admin_email: req.studio.admin_email, integration_key: req.studio.integration_key }) })));
adm.put('/studio', wrap(async (req, res) => {
  const b = req.body || {}; const sets = [], v = [];
  const put = (col, val) => { v.push(val); sets.push(`${col} = $${v.length}`); };
  if (b.name !== undefined) { const n = String(b.name).trim().slice(0, 80); if (n.length < 2) throw new Regla('nombre', 'Falta el nombre.'); put('name', n); }
  if (b.color !== undefined) { if (!colorOk(b.color)) throw new Regla('color', 'Color inválido.'); put('color', b.color); }
  for (const k of ['intro', 'address', 'whatsapp', 'qr_holder']) if (b[k] !== undefined) put(k, String(b[k] || '').trim().slice(0, k === 'intro' ? 400 : 160) || null);
  if (b.cancel_hours !== undefined) put('cancel_hours', Math.min(168, Math.max(0, parseInt(b.cancel_hours, 10) || 0)));
  if (b.days_ahead !== undefined) put('days_ahead', Math.min(60, Math.max(1, parseInt(b.days_ahead, 10) || 14)));
  if (b.single_price !== undefined) put('single_price', b.single_price === null || b.single_price === '' ? null : Math.max(0, Number(b.single_price) || 0));
  if (b.currency !== undefined) put('currency', String(b.currency || 'Bs').slice(0, 6));
  if (b.qr_image !== undefined) {
    if (b.qr_image && (!/^data:image\/(png|jpe?g|webp);base64,/.test(b.qr_image) || b.qr_image.length > 1500000)) throw new Regla('qr', 'El QR tiene que ser una imagen de hasta 1 MB.');
    put('qr_image', b.qr_image || null);
  }
  if (b.new_password !== undefined) { if (String(b.new_password).length < 8) throw new Regla('clave', 'La contraseña necesita al menos 8 caracteres.'); put('admin_pass_hash', await bcrypt.hash(String(b.new_password), 10)); }
  if (b.rotate_integration_key) put('integration_key', core.nuevaClave());
  if (!sets.length) return res.json({ ok: true });
  v.push(req.studio.id);
  await db.query(`UPDATE studios SET ${sets.join(', ')} WHERE id = $${v.length}`, v);
  res.json({ ok: true });
}));

// catálogos simples: disciplinas, plantilla semanal, paquetes
const horaOk = (h) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(h || ''));
async function limpiarFuturas(studioId, where, params) { // clases futuras SIN reservas vivas: se regeneran desde la plantilla
  await db.query(`DELETE FROM sessions s WHERE s.studio_id = $1 AND s.starts_at > NOW() AND ${where}
     AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.session_id = s.id AND b.status IN ('booked','waitlist'))`, [studioId].concat(params));
}
adm.get('/catalog', wrap(async (req, res) => {
  const id = req.studio.id;
  const [d, s, p] = await Promise.all([
    db.query('SELECT * FROM disciplines WHERE studio_id = $1 ORDER BY active DESC, sort, name', [id]),
    db.query('SELECT * FROM slots WHERE studio_id = $1 AND active ORDER BY dow, start_time', [id]),
    db.query('SELECT * FROM packages WHERE studio_id = $1 ORDER BY active DESC, sort, sessions', [id]),
  ]);
  res.json({ ok: true, disciplines: d.rows, slots: s.rows, packages: p.rows.map((x) => Object.assign(x, { price: Number(x.price) })) });
}));
adm.post('/disciplines', wrap(async (req, res) => {
  const b = req.body || {}; const n = String(b.name || '').trim().slice(0, 60); if (n.length < 2) throw new Regla('nombre', 'Falta el nombre.');
  const r = await db.query('INSERT INTO disciplines (studio_id, name, color, description, sort) VALUES ($1,$2,$3,$4,$5) RETURNING *', [req.studio.id, n, colorOk(b.color) ? b.color : req.studio.color, String(b.description || '').slice(0, 300) || null, parseInt(b.sort, 10) || 0]);
  res.json({ ok: true, discipline: r.rows[0] });
}));
adm.put('/disciplines/:id', wrap(async (req, res) => {
  const b = req.body || {}; const cur = (await db.query('SELECT * FROM disciplines WHERE id = $1 AND studio_id = $2', [req.params.id, req.studio.id])).rows[0];
  if (!cur) throw new Regla('no', 'No existe.');
  await db.query('UPDATE disciplines SET name = $1, color = $2, description = $3, active = $4, sort = $5 WHERE id = $6',
    [String(b.name ?? cur.name).trim().slice(0, 60) || cur.name, colorOk(b.color) ? b.color : cur.color, b.description !== undefined ? (String(b.description || '').slice(0, 300) || null) : cur.description, b.active !== undefined ? !!b.active : cur.active, b.sort !== undefined ? parseInt(b.sort, 10) || 0 : cur.sort, cur.id]);
  res.json({ ok: true });
}));
adm.post('/slots', wrap(async (req, res) => {
  const b = req.body || {}; const dow = parseInt(b.dow, 10);
  const d = (await db.query('SELECT id FROM disciplines WHERE id = $1 AND studio_id = $2', [b.discipline_id, req.studio.id])).rows[0];
  if (!d) throw new Regla('disciplina', 'Elegí una disciplina.');
  if (!(dow >= 0 && dow <= 6)) throw new Regla('dia', 'Día inválido.');
  if (!horaOk(b.start_time)) throw new Regla('hora', 'Hora inválida (HH:MM).');
  const r = await db.query('INSERT INTO slots (studio_id, discipline_id, dow, start_time, duration_min, capacity, instructor, room) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [req.studio.id, d.id, dow, b.start_time, Math.min(480, Math.max(10, parseInt(b.duration_min, 10) || 60)), Math.min(500, Math.max(1, parseInt(b.capacity, 10) || 12)), String(b.instructor || '').trim().slice(0, 60) || null, String(b.room || '').trim().slice(0, 60) || null]);
  res.json({ ok: true, slot: r.rows[0] });
}));
adm.put('/slots/:id', wrap(async (req, res) => {
  const b = req.body || {}; const cur = (await db.query('SELECT * FROM slots WHERE id = $1 AND studio_id = $2', [req.params.id, req.studio.id])).rows[0];
  if (!cur) throw new Regla('no', 'No existe.');
  if (b.start_time !== undefined && !horaOk(b.start_time)) throw new Regla('hora', 'Hora inválida (HH:MM).');
  if (b.discipline_id !== undefined && !(await db.query('SELECT 1 FROM disciplines WHERE id = $1 AND studio_id = $2', [b.discipline_id, req.studio.id])).rows[0]) throw new Regla('disciplina', 'Disciplina inválida.');
  await db.query('UPDATE slots SET discipline_id = $1, dow = $2, start_time = $3, duration_min = $4, capacity = $5, instructor = $6, room = $7 WHERE id = $8',
    [b.discipline_id ?? cur.discipline_id, b.dow !== undefined ? Math.min(6, Math.max(0, parseInt(b.dow, 10) || 0)) : cur.dow, b.start_time ?? cur.start_time, b.duration_min !== undefined ? Math.min(480, Math.max(10, parseInt(b.duration_min, 10) || 60)) : cur.duration_min,
     b.capacity !== undefined ? Math.min(500, Math.max(1, parseInt(b.capacity, 10) || 12)) : cur.capacity, b.instructor !== undefined ? (String(b.instructor || '').trim().slice(0, 60) || null) : cur.instructor, b.room !== undefined ? (String(b.room || '').trim().slice(0, 60) || null) : cur.room, cur.id]);
  await limpiarFuturas(req.studio.id, 's.slot_id = $2', [cur.id]);
  // las que ya tienen reservas conservan su hora, pero toman cupo, profe y sala nuevos
  await db.query(`UPDATE sessions s SET capacity = sl.capacity, instructor = sl.instructor, room = sl.room FROM slots sl WHERE sl.id = s.slot_id AND s.slot_id = $1 AND s.starts_at > NOW()`, [cur.id]);
  res.json({ ok: true });
}));
adm.delete('/slots/:id', wrap(async (req, res) => {
  const r = await db.query('UPDATE slots SET active = FALSE WHERE id = $1 AND studio_id = $2 RETURNING id', [req.params.id, req.studio.id]);
  if (r.rows[0]) await limpiarFuturas(req.studio.id, 's.slot_id = $2', [r.rows[0].id]);
  res.json({ ok: true });
}));
adm.post('/packages', wrap(async (req, res) => {
  const b = req.body || {}; const n = String(b.name || '').trim().slice(0, 60); if (n.length < 2) throw new Regla('nombre', 'Falta el nombre.');
  const r = await db.query('INSERT INTO packages (studio_id, name, sessions, price, valid_days, sort) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [req.studio.id, n, Math.min(1000, Math.max(1, parseInt(b.sessions, 10) || 1)), Math.max(0, Number(b.price) || 0), Math.min(730, Math.max(1, parseInt(b.valid_days, 10) || 50)), parseInt(b.sort, 10) || 0]);
  res.json({ ok: true, package: r.rows[0] });
}));
adm.put('/packages/:id', wrap(async (req, res) => {
  const b = req.body || {}; const cur = (await db.query('SELECT * FROM packages WHERE id = $1 AND studio_id = $2', [req.params.id, req.studio.id])).rows[0];
  if (!cur) throw new Regla('no', 'No existe.');
  await db.query('UPDATE packages SET name = $1, sessions = $2, price = $3, valid_days = $4, active = $5, sort = $6 WHERE id = $7',
    [String(b.name ?? cur.name).trim().slice(0, 60) || cur.name, b.sessions !== undefined ? Math.min(1000, Math.max(1, parseInt(b.sessions, 10) || 1)) : cur.sessions, b.price !== undefined ? Math.max(0, Number(b.price) || 0) : cur.price,
     b.valid_days !== undefined ? Math.min(730, Math.max(1, parseInt(b.valid_days, 10) || 50)) : cur.valid_days, b.active !== undefined ? !!b.active : cur.active, b.sort !== undefined ? parseInt(b.sort, 10) || 0 : cur.sort, cur.id]);
  res.json({ ok: true });
}));

// día a día: clases con su lista
adm.get('/day', wrap(async (req, res) => {
  const hoy = core.fechaLocal(Date.now(), req.studio.tz_offset_min); const f = core.esFecha(req.query.date) ? req.query.date : hoy;
  const clases = await core.horario(req.studio, f, 1, null);
  const ids = clases.map((c) => c.id);
  const rs = ids.length ? (await db.query(
    `SELECT b.id, b.session_id, b.status, b.pay, b.source, b.receipt_id, st.id AS student_id, st.name, st.phone
       FROM bookings b JOIN students st ON st.id = b.student_id WHERE b.session_id = ANY($1) AND b.status IN ('booked','waitlist','attended','no_show','late_cancel') ORDER BY (b.status = 'waitlist'), b.id`, [ids])).rows : [];
  res.json({ ok: true, date: f, today: hoy, sessions: clases.map((c) => Object.assign(c, { roster: rs.filter((r) => r.session_id === c.id) })) });
}));
adm.post('/sessions/:id/cancel', wrap(async (req, res) => res.json(Object.assign({ ok: true }, await core.cancelarClase(req.studio, parseInt(req.params.id, 10))))));

// reservas desde el panel
adm.post('/bookings', wrap(async (req, res) => {
  const b = req.body || {};
  const st = b.student_id ? (await db.query('SELECT * FROM students WHERE id = $1 AND studio_id = $2', [b.student_id, req.studio.id])).rows[0] : await core.alumnoPorTelefono(req.studio, b.phone, b.name);
  if (!st) throw new Regla('alumno', 'Alumno no encontrado.');
  const r = await core.reservar(req.studio, st.id, parseInt(b.session_id, 10), { pay: b.pay === 'courtesy' ? 'courtesy' : 'package', waitlist: !!b.waitlist, source: 'admin' });
  res.json({ ok: true, status: r.status, booking_id: r.booking.id, package: r.package });
}));
adm.patch('/bookings/:id', wrap(async (req, res) => {
  const b = req.body || {}; const id = parseInt(req.params.id, 10);
  if (b.action === 'cancel') return res.json(Object.assign({ ok: true }, await core.cancelar(req.studio, id, { by: 'admin', refund: typeof b.refund === 'boolean' ? b.refund : undefined })));
  if (b.action === 'approve' || b.action === 'reject') return res.json(Object.assign({ ok: true }, await core.resolverSuelta(req.studio, id, b.action === 'approve')));
  if (['attended', 'no_show', 'booked'].includes(b.status)) {
    const r = await db.query(`UPDATE bookings SET status = $1 WHERE id = $2 AND studio_id = $3 AND status IN ('booked','attended','no_show') RETURNING id`, [b.status, id, req.studio.id]);
    if (!r.rows[0]) throw new Regla('estado', 'Esa reserva no está activa.');
    return res.json({ ok: true, status: b.status });
  }
  throw new Regla('accion', 'Acción inválida.');
}));

// alumnos
adm.get('/students', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim(); const dig = core.soloDigitos(q);
  const r = await db.query(
    `SELECT st.id, st.name, st.phone, st.created_at,
            COALESCE((SELECT SUM(sessions_total - sessions_used) FROM student_packages sp WHERE sp.student_id = st.id AND sp.status = 'active' AND sp.expires_at >= NOW()), 0)::int AS credits,
            (SELECT MIN(expires_at) FROM student_packages sp WHERE sp.student_id = st.id AND sp.status = 'active' AND sp.expires_at >= NOW() AND sp.sessions_used < sp.sessions_total) AS next_expiry,
            (SELECT COUNT(*)::int FROM bookings b JOIN sessions s ON s.id = b.session_id WHERE b.student_id = st.id AND b.status = 'booked' AND s.starts_at > NOW()) AS upcoming
       FROM students st WHERE st.studio_id = $1 AND ($2 = '' OR st.name ILIKE '%' || $2 || '%' OR ($3 <> '' AND st.phone LIKE '%' || $3 || '%'))
      ORDER BY st.name LIMIT 200`, [req.studio.id, q, dig]);
  res.json({ ok: true, students: r.rows });
}));
adm.post('/students', wrap(async (req, res) => { const st = await core.alumnoPorTelefono(req.studio, (req.body || {}).phone, (req.body || {}).name); res.json({ ok: true, student: { id: st.id, name: st.name, phone: st.phone } }); }));
adm.get('/students/:id', wrap(async (req, res) => { const r = await core.resumenAlumno(req.studio, parseInt(req.params.id, 10)); if (!r) throw new Regla('no', 'No existe.'); res.json(Object.assign({ ok: true }, r)); }));
adm.put('/students/:id', wrap(async (req, res) => {
  const b = req.body || {}; const cur = (await db.query('SELECT * FROM students WHERE id = $1 AND studio_id = $2', [req.params.id, req.studio.id])).rows[0];
  if (!cur) throw new Regla('no', 'No existe.');
  await db.query('UPDATE students SET name = $1, notes = $2, pin_hash = $3 WHERE id = $4', [String(b.name ?? cur.name).trim().slice(0, 80) || cur.name, b.notes !== undefined ? (String(b.notes || '').slice(0, 500) || null) : cur.notes, b.reset_pin ? null : cur.pin_hash, cur.id]);
  res.json({ ok: true });
}));
adm.post('/students/:id/packages', wrap(async (req, res) => { // venta en mostrador: queda activo
  const st = (await db.query('SELECT id FROM students WHERE id = $1 AND studio_id = $2', [req.params.id, req.studio.id])).rows[0]; if (!st) throw new Regla('no', 'No existe.');
  const sp = await core.comprarPaquete(req.studio, st.id, parseInt((req.body || {}).package_id, 10), { source: 'admin' });
  res.json({ ok: true, student_package_id: sp.id, expires_at: sp.expires_at });
}));
adm.patch('/student-packages/:id', wrap(async (req, res) => {
  const b = req.body || {}; const id = parseInt(req.params.id, 10);
  if (b.action === 'approve' || b.action === 'reject') return res.json(Object.assign({ ok: true }, await core.resolverPaquete(req.studio, id, b.action === 'approve')));
  const cur = (await db.query('SELECT * FROM student_packages WHERE id = $1 AND studio_id = $2', [id, req.studio.id])).rows[0]; if (!cur) throw new Regla('no', 'No existe.');
  const total = b.sessions_total !== undefined ? Math.max(cur.sessions_used, parseInt(b.sessions_total, 10) || cur.sessions_total) : cur.sessions_total;
  const exp = b.expires_at && !isNaN(Date.parse(b.expires_at)) ? new Date(b.expires_at) : cur.expires_at;
  await db.query('UPDATE student_packages SET sessions_total = $1, expires_at = $2 WHERE id = $3', [total, exp, id]);
  res.json({ ok: true });
}));

// pagos por verificar
adm.get('/pending', wrap(async (req, res) => {
  const [p, b] = await Promise.all([
    db.query(`SELECT sp.id, sp.name, sp.sessions_total, sp.price, sp.receipt_id, sp.purchased_at, st.name AS student, st.phone FROM student_packages sp JOIN students st ON st.id = sp.student_id WHERE sp.studio_id = $1 AND sp.status = 'pending' ORDER BY sp.id`, [req.studio.id]),
    db.query(`SELECT b.id, b.receipt_id, b.created_at, st.name AS student, st.phone, s.starts_at, d.name AS discipline FROM bookings b JOIN students st ON st.id = b.student_id JOIN sessions s ON s.id = b.session_id JOIN disciplines d ON d.id = s.discipline_id
               WHERE b.studio_id = $1 AND b.pay = 'single_pending' AND b.status = 'booked' ORDER BY b.id`, [req.studio.id]),
  ]);
  res.json({ ok: true, packages: p.rows.map((x) => Object.assign(x, { price: x.price == null ? null : Number(x.price) })), singles: b.rows.map((x) => Object.assign(x, { date: core.fechaLocal(x.starts_at, req.studio.tz_offset_min), time: core.horaLocal(x.starts_at, req.studio.tz_offset_min) })) });
}));
adm.get('/receipts/:id', wrap(async (req, res) => {
  const r = (await db.query('SELECT mime, data FROM receipts WHERE id = $1 AND studio_id = $2', [req.params.id, req.studio.id])).rows[0];
  if (!r) return res.status(404).end();
  res.set('Content-Type', r.mime).set('Cache-Control', 'private, max-age=3600').set('X-Content-Type-Options', 'nosniff').send(r.data);
}));
app.use('/api/admin', adm);

// ═════════════════════ API DE INTEGRACIÓN (Aitana u otro sistema) ═════════════════════
// Cabecera: x-integration-key: <clave del estudio>. Todo se identifica por el WhatsApp del alumno.
const itg = express.Router();
itg.use(wrap(async (req, res, next) => {
  const k = String(req.headers['x-integration-key'] || '');
  const s = k ? (await db.query('SELECT * FROM studios WHERE integration_key = $1', [k])).rows[0] : null;
  if (!s) return res.status(401).json({ ok: false, error: 'Clave de integración inválida.' });
  req.studio = s; next();
}));
itg.get('/studio', wrap(async (req, res) => {
  const [d, p] = await Promise.all([db.query('SELECT id, name, description FROM disciplines WHERE studio_id = $1 AND active ORDER BY sort, name', [req.studio.id]), db.query('SELECT id, name, sessions, price, valid_days FROM packages WHERE studio_id = $1 AND active ORDER BY sort, sessions', [req.studio.id])]);
  const s = publico(req.studio); delete s.qr_image;
  res.json({ ok: true, studio: s, disciplines: d.rows, packages: p.rows.map((x) => Object.assign(x, { price: Number(x.price) })) });
}));
itg.get('/schedule', wrap(async (req, res) => {
  const hoy = core.fechaLocal(Date.now(), req.studio.tz_offset_min); const desde = core.esFecha(req.query.from) ? req.query.from : hoy;
  const st = req.query.phone ? (await db.query('SELECT id FROM students WHERE studio_id = $1 AND phone = $2', [req.studio.id, core.soloDigitos(req.query.phone)])).rows[0] : null;
  const clases = await core.horario(req.studio, desde, Math.min(14, Math.max(1, parseInt(req.query.days, 10) || 7)), st && st.id);
  res.json({ ok: true, today: hoy, sessions: clases.filter((c) => !c.cancelled && !c.past) });
}));
itg.get('/student', wrap(async (req, res) => {
  const st = (await db.query('SELECT id FROM students WHERE studio_id = $1 AND phone = $2', [req.studio.id, core.soloDigitos(req.query.phone)])).rows[0];
  if (!st) return res.json({ ok: true, found: false });
  res.json(Object.assign({ ok: true, found: true }, await core.resumenAlumno(req.studio, st.id)));
}));
itg.post('/book', wrap(async (req, res) => {
  const b = req.body || {}; const st = await core.alumnoPorTelefono(req.studio, b.phone, b.name);
  const r = await core.reservar(req.studio, st.id, parseInt(b.session_id, 10), { pay: 'package', waitlist: !!b.waitlist, source: 'aitana' });
  res.json({ ok: true, status: r.status, booking_id: r.booking.id, package: r.package });
}));
itg.post('/cancel', wrap(async (req, res) => {
  const b = req.body || {}; const st = (await db.query('SELECT id FROM students WHERE studio_id = $1 AND phone = $2', [req.studio.id, core.soloDigitos(b.phone)])).rows[0];
  if (!st) throw new Regla('alumno', 'No hay un alumno con ese número.');
  res.json(Object.assign({ ok: true }, await core.cancelar(req.studio, parseInt(b.booking_id, 10), { by: 'student', studentId: st.id })));
}));
itg.get('/events', wrap(async (req, res) => {
  const r = await db.query('SELECT id, type, payload, created_at FROM events WHERE studio_id = $1 AND id > $2 ORDER BY id LIMIT 200', [req.studio.id, parseInt(req.query.after, 10) || 0]);
  res.json({ ok: true, events: r.rows });
}));
app.use('/api/integration', itg);

// ═════════════════════ PÁGINAS ═════════════════════
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'horarios-clases', version: VERSION, embebido: EMBEBIDO }));
const pagina = (f) => (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, 'public', f));
app.get('/e/:slug', pagina('estudio.html'));
app.get('/admin', pagina('admin.html'));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', index: 'index.html' }));
app.use((req, res) => res.status(404).json({ ok: false, error: 'No encontrado' }));

if (require.main === module) {
  const port = process.env.PORT || 3000;
  db.init().then(() => app.listen(port, () => console.log(`🗓️  Horarios de clases en el puerto ${port}`))).catch((e) => { console.error('No se pudo iniciar la base:', e.message); process.exit(1); });
}
module.exports = app;
module.exports.app = app;
module.exports.init = () => db.init();
