// Pruebas de las reglas contra un Postgres real (DATABASE_URL). Cada corrida usa un estudio nuevo.
const test = require('node:test');
const assert = require('node:assert');
const db = require('../db');
const core = require('../core');
const { sembrar } = require('../scripts/seed-demo');

let studio, sesiones;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const alumno = (n) => core.alumnoPorTelefono(studio, '5917' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0'), n);
const pkg = async (n) => (await db.query('SELECT * FROM packages WHERE studio_id = $1 AND sessions = $2', [studio.id, n])).rows[0];
const saldo = async (st) => (await core.resumenAlumno(studio, st.id)).credits;
const falla = async (fn, code) => { await assert.rejects(fn, (e) => { assert.strictEqual(e.code, code, e.message); return true; }); };

test.before(async () => {
  const slug = 'prueba-' + Date.now().toString(36);
  const id = await sembrar({ slug, email: slug + '@ejemplo.test', password: 'clave-de-prueba' });
  studio = (await db.query('SELECT * FROM studios WHERE id = $1', [id])).rows[0];
  const hoy = core.fechaLocal(Date.now(), studio.tz_offset_min);
  sesiones = (await core.horario(studio, hoy, 10, null)).filter((s) => !s.past);
});
test.after(async () => { await db.query('DELETE FROM studios WHERE id = $1', [studio.id]); await db.pool.end(); });

test('genera las clases de la plantilla una sola vez', async () => {
  const hoy = core.fechaLocal(Date.now(), studio.tz_offset_min);
  const a = await core.horario(studio, hoy, 7, null), b = await core.horario(studio, hoy, 7, null);
  assert.strictEqual(a.length, b.length); assert.strictEqual(a.length, 43); // 5 días × 8 + sábado 3
  assert.ok(a.every((s) => s.capacity === 12 && s.free === 12));
});

test('sin paquete no se reserva con paquete', async () => {
  const st = await alumno('Sin Paquete');
  await falla(() => core.reservar(studio, st.id, sesiones[5].id, { pay: 'package' }), 'sin_paquete');
});

test('reservar descuenta una sesión y cancelar a tiempo la devuelve', async () => {
  const st = await alumno('Ana Tiempo'); await core.comprarPaquete(studio, st.id, (await pkg(4)).id, { source: 'admin' });
  const lejos = sesiones.find((s) => new Date(s.starts_at) - Date.now() > 13 * 3600000);
  const r = await core.reservar(studio, st.id, lejos.id, { pay: 'package' });
  assert.strictEqual(r.package.remaining, 3); assert.strictEqual(await saldo(st), 3);
  await falla(() => core.reservar(studio, st.id, lejos.id, { pay: 'package' }), 'duplicada');
  const c = await core.cancelar(studio, r.booking.id, { by: 'student', studentId: st.id });
  assert.deepStrictEqual([c.status, c.refunded, c.late, c.remaining], ['cancelled', true, false, 4]);
  assert.strictEqual(await saldo(st), 4);
});

test('cancelar con menos de 12 horas descuenta la sesión', async () => {
  const st = await alumno('Luis Tarde'); await core.comprarPaquete(studio, st.id, (await pkg(4)).id, { source: 'admin' });
  // una clase puntual dentro de 3 horas
  const d = (await db.query('SELECT id FROM disciplines WHERE studio_id = $1 LIMIT 1', [studio.id])).rows[0];
  const s = (await db.query(`INSERT INTO sessions (studio_id, discipline_id, starts_at, duration_min, capacity) VALUES ($1,$2,NOW() + INTERVAL '3 hours',60,12) RETURNING id`, [studio.id, d.id])).rows[0];
  const r = await core.reservar(studio, st.id, s.id, { pay: 'package' });
  const c = await core.cancelar(studio, r.booking.id, { by: 'student', studentId: st.id });
  assert.deepStrictEqual([c.status, c.refunded, c.late], ['late_cancel', false, true]);
  assert.strictEqual(await saldo(st), 3);
  // el estudio puede devolverla igual
  const r2 = await core.reservar(studio, st.id, s.id, { pay: 'package' });
  const c2 = await core.cancelar(studio, r2.booking.id, { by: 'admin', refund: true });
  assert.strictEqual(c2.refunded, true); assert.strictEqual(await saldo(st), 3);
});

test('nadie cancela la reserva de otro', async () => {
  const a = await alumno('Dueña'), b = await alumno('Intruso'); await core.comprarPaquete(studio, a.id, (await pkg(4)).id, { source: 'admin' });
  const r = await core.reservar(studio, a.id, sesiones[8].id, { pay: 'package' });
  await falla(() => core.cancelar(studio, r.booking.id, { by: 'student', studentId: b.id }), 'reserva');
});

test('cupo: no se pasa aunque reserven a la vez; lista de espera sube sola', async () => {
  const d = (await db.query('SELECT id FROM disciplines WHERE studio_id = $1 LIMIT 1', [studio.id])).rows[0];
  const s = (await db.query(`INSERT INTO sessions (studio_id, discipline_id, starts_at, duration_min, capacity) VALUES ($1,$2,NOW() + INTERVAL '2 days',60,3) RETURNING *`, [studio.id, d.id])).rows[0];
  const p4 = (await pkg(4)).id; const gente = [];
  for (let i = 0; i < 6; i++) { const st = await alumno('Persona ' + i); await core.comprarPaquete(studio, st.id, p4, { source: 'admin' }); gente.push(st); }
  const res = await Promise.allSettled(gente.map((st) => core.reservar(studio, st.id, s.id, { pay: 'package' })));
  assert.strictEqual(res.filter((x) => x.status === 'fulfilled').length, 3);
  assert.ok(res.filter((x) => x.status === 'rejected').every((x) => x.reason.code === 'llena'));
  const dentro = gente.filter((_, i) => res[i].status === 'fulfilled'), fuera = gente.filter((_, i) => res[i].status === 'rejected');
  for (const st of fuera) assert.strictEqual(await saldo(st), 4); // al que no entró no se le descontó
  const w = await core.reservar(studio, fuera[0].id, s.id, { pay: 'package', waitlist: true });
  assert.strictEqual(w.status, 'waitlist'); assert.strictEqual(await saldo(fuera[0]), 4);
  const b0 = (await db.query(`SELECT id FROM bookings WHERE session_id = $1 AND student_id = $2`, [s.id, dentro[0].id])).rows[0];
  const c = await core.cancelar(studio, b0.id, { by: 'student', studentId: dentro[0].id });
  assert.deepStrictEqual(c.promoted, [w.booking.id]);
  assert.strictEqual(await saldo(fuera[0]), 3);
  const n = (await db.query(`SELECT COUNT(*)::int AS n FROM bookings WHERE session_id = $1 AND status = 'booked'`, [s.id])).rows[0].n;
  assert.strictEqual(n, 3);
});

test('un paquete vencido para el día de la clase no sirve', async () => {
  const st = await alumno('Vencida'); const sp = await core.comprarPaquete(studio, st.id, (await pkg(4)).id, { source: 'admin' });
  await db.query(`UPDATE student_packages SET expires_at = NOW() + INTERVAL '1 hour' WHERE id = $1`, [sp.id]);
  const lejos = sesiones.find((s) => new Date(s.starts_at) - Date.now() > 26 * 3600000);
  await falla(() => core.reservar(studio, st.id, lejos.id, { pay: 'package' }), 'sin_paquete');
  assert.strictEqual(sp.status, 'active');
  const dias = Math.round((new Date(sp.expires_at) - new Date(sp.purchased_at)) / 86400000);
  assert.strictEqual(dias, 50);
});

test('paquete comprado en la web: por verificar, se usa, y rechazarlo cancela sus reservas', async () => {
  const st = await alumno('Web Compra');
  const p8 = (await pkg(8)).id;
  await falla(() => core.comprarPaquete(studio, st.id, p8, { receipt: 'no-es-imagen' }), 'comprobante');
  const sp = await core.comprarPaquete(studio, st.id, p8, { receipt: PNG });
  assert.strictEqual(sp.status, 'pending');
  const r = await core.reservar(studio, st.id, sesiones[12].id, { pay: 'package' });
  assert.strictEqual(r.package.remaining, 7);
  const x = await core.resolverPaquete(studio, sp.id, false);
  assert.deepStrictEqual([x.status, x.cancelled_bookings], ['rejected', 1]);
  assert.strictEqual(await saldo(st), 0);
  await falla(() => core.resolverPaquete(studio, sp.id, true), 'estado');
});

test('clase suelta con comprobante: guarda el lugar y el estudio la aprueba o la rechaza', async () => {
  const st = await alumno('Suelta');
  await falla(() => core.reservar(studio, st.id, sesiones[15].id, { pay: 'single' }), 'comprobante');
  const r = await core.reservar(studio, st.id, sesiones[15].id, { pay: 'single', receipt: PNG });
  assert.strictEqual(r.booking.pay, 'single_pending');
  assert.strictEqual((await core.resolverSuelta(studio, r.booking.id, true)).status, 'single_paid');
  const r2 = await core.reservar(studio, st.id, sesiones[16].id, { pay: 'single', receipt: PNG });
  assert.strictEqual((await core.resolverSuelta(studio, r2.booking.id, false)).status, 'cancelled');
});

test('cancelar la clase entera devuelve las sesiones', async () => {
  const st = await alumno('Clase Cancelada'); await core.comprarPaquete(studio, st.id, (await pkg(4)).id, { source: 'admin' });
  const r = await core.reservar(studio, st.id, sesiones[20].id, { pay: 'package' });
  assert.strictEqual(await saldo(st), 3);
  assert.strictEqual((await core.cancelarClase(studio, sesiones[20].id)).cancelled, 1);
  assert.strictEqual(await saldo(st), 4);
  await falla(() => core.reservar(studio, st.id, sesiones[20].id, { pay: 'package' }), 'clase');
  assert.ok(r.booking.id);
});

test('usa primero el paquete que vence antes', async () => {
  const st = await alumno('Dos Paquetes');
  const a = await core.comprarPaquete(studio, st.id, (await pkg(4)).id, { source: 'admin' });
  const b = await core.comprarPaquete(studio, st.id, (await pkg(8)).id, { source: 'admin' });
  await db.query(`UPDATE student_packages SET expires_at = NOW() + INTERVAL '20 days' WHERE id = $1`, [b.id]);
  const r = await core.reservar(studio, st.id, sesiones[22].id, { pay: 'package' });
  assert.strictEqual(r.package.id, b.id); assert.notStrictEqual(r.package.id, a.id);
});
