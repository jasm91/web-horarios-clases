# Horarios de clases

Horarios y reservas para estudios y centros deportivos que trabajan **por sesiones**: el alumno compra un paquete, reserva la clase que quiere y cancela dentro del plazo del estudio.

- **Página pública** (`/e/<estudio>`): horario semanal con cupos en vivo, reserva, compra de paquetes por QR con comprobante, «mis reservas».
- **Panel del estudio** (`/admin`): clases del día con su lista, asistencia, pagos por verificar, horario semanal, disciplinas, paquetes, alumnos y ajustes.
- **API de integración** (`/api/integration`): para que otro sistema (por ejemplo Aitana por WhatsApp) consulte el horario, reserve y cancele.

## Reglas

| Regla | Dónde se configura | Por defecto |
|---|---|---|
| Vigencia de las sesiones | Cada paquete | 50 días |
| Cancelación sin descuento | Ajustes | 12 horas antes |
| Cupo por clase | Cada clase del horario | 12 |
| Anticipación para reservar | Ajustes | 14 días |
| Clase suelta | Ajustes (vacío = no se vende) | — |

- Reservar descuenta una sesión del paquete que **vence antes**. Un paquete no sirve para una clase posterior a su vencimiento.
- Cancelar a tiempo devuelve la sesión; cancelar tarde la descuenta (`late_cancel`). El estudio puede devolverla igual desde el panel.
- Clase llena → lista de espera. Cuando se libera un lugar sube el primero de la lista que tenga sesiones.
- Un paquete comprado en la web queda «por verificar» y ya se puede usar; si el estudio rechaza el comprobante, se cancelan las reservas hechas con él.
- Si el estudio cancela una clase, todas las sesiones vuelven.

## Correrlo

```bash
npm install
export DATABASE_URL=postgres://usuario:clave@host:5432/base
export APP_SECRET=$(openssl rand -hex 32)   # firma de las sesiones
npm start                                   # crea las tablas solo
```

Variables: `DATABASE_URL`, `APP_SECRET`, `PORT` (3000) y, opcional, `SETUP_KEY` (si está, hace falta para crear un estudio nuevo).

Estudio de ejemplo (5 disciplinas, horario y paquetes):

```bash
DEMO_SLUG=centro-deportivo DEMO_EMAIL=dueno@ejemplo.com DEMO_PASSWORD=una-clave-larga npm run seed
```

Pruebas de las reglas (necesitan un Postgres): `npm test`

## API de integración

Cabecera `x-integration-key: <clave del estudio>` (Ajustes → Conexión con otros sistemas). El alumno se identifica por su WhatsApp.

| Método | Ruta | Para qué |
|---|---|---|
| GET | `/api/integration/studio` | Datos, disciplinas y paquetes |
| GET | `/api/integration/schedule?from=AAAA-MM-DD&days=7&phone=` | Clases con lugares libres (y la reserva del alumno, si se pasa `phone`) |
| GET | `/api/integration/student?phone=` | Saldo, vencimientos y reservas del alumno |
| POST | `/api/integration/book` `{ phone, name, session_id, waitlist }` | Reservar con el paquete |
| POST | `/api/integration/cancel` `{ phone, booking_id }` | Cancelar (aplica la regla de horas) |
| GET | `/api/integration/events?after=<id>` | Novedades para avisar: reservas, cancelaciones, lista de espera, paquetes |

Errores: `{ ok:false, code, error }` con códigos como `llena`, `sin_paquete`, `duplicada`, `pasada`.

## Pendiente

- Avisos al alumno (recordatorios, vencimientos, lista de espera): los eventos ya se registran; falta quién los envíe.
- Entrada del alumno sin PIN, con un enlace enviado por WhatsApp.
- Paquetes ilimitados o con tope semanal.
