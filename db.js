// Conexión y esquema. El esquema se crea solo al arrancar (idempotente).
// Dos formas de correr:
//   · suelto: base propia (DATABASE_URL), tablas en el esquema por defecto.
//   · dentro de otro sistema (Aitana CRM): CLASES_SCHEMA=clases → mismas tablas, pero en un ESQUEMA APARTE de la misma base,
//     con un pool propio. Las tablas del sistema anfitrión no se tocan aunque se llamen igual (sessions, events, packages…).
const { Pool } = require('pg');

const url = process.env.DATABASE_URL || 'postgres://postgres@localhost:5432/clases';
const ESQUEMA = /^[a-z][a-z0-9_]{1,30}$/.test(process.env.CLASES_SCHEMA || '') ? process.env.CLASES_SCHEMA : null;
const pool = new Pool(Object.assign({
  connectionString: url,
  max: ESQUEMA ? 4 : 10,
}, ESQUEMA
  ? { ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false, options: `-c search_path=${ESQUEMA}`, idleTimeoutMillis: 30000 }
  : { ssl: /railway|render|amazonaws|neon|supabase/.test(url) && !/sslmode=disable/.test(url) && !/\.internal/.test(url) ? { rejectUnauthorized: false } : undefined }));
pool.on('error', (e) => console.error('[clases] pg:', e.message));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS studios (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#f97316',
  intro TEXT,
  address TEXT,
  whatsapp TEXT,
  tz_offset_min INTEGER NOT NULL DEFAULT -240,
  cancel_hours INTEGER NOT NULL DEFAULT 12,
  days_ahead INTEGER NOT NULL DEFAULT 14,
  single_price NUMERIC(10,2),
  currency TEXT NOT NULL DEFAULT 'Bs',
  qr_image TEXT,
  qr_holder TEXT,
  admin_email TEXT NOT NULL UNIQUE,
  admin_pass_hash TEXT NOT NULL,
  integration_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS disciplines (
  id SERIAL PRIMARY KEY,
  studio_id INTEGER NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#f97316',
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort INTEGER NOT NULL DEFAULT 0
);
-- Plantilla semanal: «Yoga, lunes 08:00, 60 min, cupo 12, con Ana»
CREATE TABLE IF NOT EXISTS slots (
  id SERIAL PRIMARY KEY,
  studio_id INTEGER NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  discipline_id INTEGER NOT NULL REFERENCES disciplines(id) ON DELETE CASCADE,
  dow SMALLINT NOT NULL,              -- 0 domingo … 6 sábado
  start_time TEXT NOT NULL,           -- 'HH:MM' hora local del estudio
  duration_min INTEGER NOT NULL DEFAULT 60,
  capacity INTEGER NOT NULL DEFAULT 12,
  instructor TEXT,
  room TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE
);
-- Clase concreta de un día (se genera sola desde la plantilla)
CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  studio_id INTEGER NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  slot_id INTEGER REFERENCES slots(id) ON DELETE SET NULL,
  discipline_id INTEGER NOT NULL REFERENCES disciplines(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  duration_min INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  instructor TEXT,
  room TEXT,
  cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (slot_id, starts_at)
);
CREATE INDEX IF NOT EXISTS sessions_studio_time ON sessions (studio_id, starts_at);
CREATE TABLE IF NOT EXISTS packages (
  id SERIAL PRIMARY KEY,
  studio_id INTEGER NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  valid_days INTEGER NOT NULL DEFAULT 50,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  studio_id INTEGER NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  pin_hash TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (studio_id, phone)
);
CREATE TABLE IF NOT EXISTS receipts (
  id SERIAL PRIMARY KEY,
  studio_id INTEGER NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Paquete comprado por un alumno: saldo y vencimiento
CREATE TABLE IF NOT EXISTS student_packages (
  id SERIAL PRIMARY KEY,
  studio_id INTEGER NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  package_id INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  sessions_total INTEGER NOT NULL,
  sessions_used INTEGER NOT NULL DEFAULT 0,
  price NUMERIC(10,2),
  status TEXT NOT NULL DEFAULT 'active',   -- pending (pago por verificar) | active | rejected
  receipt_id INTEGER REFERENCES receipts(id) ON DELETE SET NULL,
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sp_student ON student_packages (student_id);
CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  studio_id INTEGER NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'booked',   -- booked | waitlist | cancelled | late_cancel | attended | no_show
  pay TEXT NOT NULL DEFAULT 'package',     -- package | single_pending | single_paid | courtesy
  student_package_id INTEGER REFERENCES student_packages(id) ON DELETE SET NULL,
  receipt_id INTEGER REFERENCES receipts(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'web',      -- web | admin | aitana
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS bookings_session ON bookings (session_id);
CREATE INDEX IF NOT EXISTS bookings_student ON bookings (student_id);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_live ON bookings (session_id, student_id) WHERE status IN ('booked','waitlist','attended','no_show');
-- Bandeja de salida de avisos: de acá los toma la integración (Aitana) para avisar por WhatsApp
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  studio_id INTEGER NOT NULL REFERENCES studios(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS events_studio ON events (studio_id, id);
`;

let ready = null;
async function _init() {
  if (ESQUEMA) {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${ESQUEMA}`);
    // Seguro: si la conexión NO quedó parada en el esquema propio, no se crea ni se toca nada.
    const c = await pool.connect();
    try {
      const r = await c.query('SELECT current_schema() AS s');
      if (r.rows[0].s !== ESQUEMA) throw new Error(`la conexión quedó en el esquema «${r.rows[0].s}» y no en «${ESQUEMA}»`);
      await c.query(SCHEMA);
    } finally { c.release(); }
    return;
  }
  await pool.query(SCHEMA);
}
function init() { if (!ready) ready = _init().catch((e) => { ready = null; throw e; }); return ready; }

module.exports = { pool, init, esquema: ESQUEMA, query: (t, p) => pool.query(t, p) };
