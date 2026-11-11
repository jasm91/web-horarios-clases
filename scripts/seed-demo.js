// Crea un estudio de ejemplo con 5 disciplinas, horario semanal y paquetes.
//   DEMO_SLUG=centro-deportivo DEMO_EMAIL=... DEMO_PASSWORD=... node scripts/seed-demo.js
const bcrypt = require('bcryptjs');
const db = require('../db');
const core = require('../core');

async function sembrar(o = {}) {
  await db.init();
  const slug = o.slug || process.env.DEMO_SLUG || 'centro-deportivo';
  const email = (o.email || process.env.DEMO_EMAIL || '').toLowerCase();
  const pass = o.password || process.env.DEMO_PASSWORD || '';
  if (!email || pass.length < 8) throw new Error('Faltan DEMO_EMAIL y DEMO_PASSWORD (8+ caracteres)');
  const ya = (await db.query('SELECT id FROM studios WHERE slug = $1', [slug])).rows[0];
  if (ya) { console.log('Ya existe', slug); return ya.id; }
  const s = (await db.query(
    `INSERT INTO studios (slug, name, color, intro, address, cancel_hours, days_ahead, single_price, admin_email, admin_pass_hash, integration_key)
     VALUES ($1,$2,$3,$4,$5,12,14,40,$6,$7,$8) RETURNING *`,
    [slug, o.name || 'Tu Centro Deportivo', '#f97316', 'Cinco disciplinas, un solo paquete. Comprá tus sesiones y reservá la clase que quieras.', 'Dirección de ejemplo', email, await bcrypt.hash(pass, 10), core.nuevaClave()])).rows[0];
  const D = [['Funcional', '#f97316', 'Fuerza y cardio en circuito.'], ['Spinning', '#0ea5e9', 'Ciclismo indoor con música.'], ['Yoga', '#10b981', 'Flexibilidad, respiración y equilibrio.'], ['Pilates', '#a855f7', 'Core y postura.'], ['Boxeo', '#ef4444', 'Técnica y acondicionamiento con saco.']];
  const ids = {};
  for (let i = 0; i < D.length; i++) ids[D[i][0]] = (await db.query('INSERT INTO disciplines (studio_id, name, color, description, sort) VALUES ($1,$2,$3,$4,$5) RETURNING id', [s.id, D[i][0], D[i][1], D[i][2], i])).rows[0].id;
  const semana = [['06:00', 'Funcional', 'Diego'], ['07:00', 'Spinning', 'Carla'], ['08:00', 'Yoga', 'Ana'], ['09:00', 'Pilates', 'Ana'], ['17:00', 'Boxeo', 'Marco'], ['18:00', 'Funcional', 'Diego'], ['19:00', 'Spinning', 'Carla'], ['20:00', 'Yoga', 'Ana']];
  const sabado = [['07:00', 'Funcional', 'Diego'], ['08:00', 'Yoga', 'Ana'], ['09:00', 'Boxeo', 'Marco']];
  for (let dow = 1; dow <= 5; dow++) for (const [h, d, p] of semana) await db.query('INSERT INTO slots (studio_id, discipline_id, dow, start_time, duration_min, capacity, instructor, room) VALUES ($1,$2,$3,$4,60,12,$5,$6)', [s.id, ids[d], dow, h, p, 'Sala principal']);
  for (const [h, d, p] of sabado) await db.query('INSERT INTO slots (studio_id, discipline_id, dow, start_time, duration_min, capacity, instructor, room) VALUES ($1,$2,6,$3,60,12,$4,$5)', [s.id, ids[d], h, p, 'Sala principal']);
  const P = [['4 sesiones', 4, 140], ['8 sesiones', 8, 250], ['12 sesiones', 12, 330], ['20 sesiones', 20, 480]];
  for (let i = 0; i < P.length; i++) await db.query('INSERT INTO packages (studio_id, name, sessions, price, valid_days, sort) VALUES ($1,$2,$3,$4,50,$5)', [s.id, P[i][0], P[i][1], P[i][2], i]);
  console.log('Estudio de ejemplo creado:', '/e/' + slug);
  return s.id;
}
module.exports = { sembrar };
if (require.main === module) sembrar().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
