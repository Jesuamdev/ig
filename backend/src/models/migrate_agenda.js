require('dotenv').config();
const { pool } = require('./db');

const sql = `
CREATE TABLE IF NOT EXISTS agenda_servicios (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre           VARCHAR(100) NOT NULL,
  duracion_minutos INTEGER      NOT NULL DEFAULT 60,
  intervalo_minutos INTEGER     NOT NULL DEFAULT 30,
  color            VARCHAR(7)   DEFAULT '#7C5CFC',
  descripcion      TEXT,
  precio           DECIMAL(10,2) DEFAULT 0,
  activo           BOOLEAN      DEFAULT true,
  created_at       TIMESTAMP    DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agenda_disponibilidad (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  agente_id    UUID    REFERENCES agentes(id) ON DELETE CASCADE,
  dia_semana   INTEGER NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  hora_inicio  TIME    NOT NULL DEFAULT '08:00',
  hora_fin     TIME    NOT NULL DEFAULT '17:00',
  activo       BOOLEAN DEFAULT true,
  UNIQUE(agente_id, dia_semana)
);

CREATE TABLE IF NOT EXISTS agenda_bloqueos (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agente_id     UUID REFERENCES agentes(id) ON DELETE CASCADE,
  fecha_inicio  TIMESTAMP NOT NULL,
  fecha_fin     TIMESTAMP NOT NULL,
  motivo        VARCHAR(200),
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS citas (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_id       UUID REFERENCES clientes(id)         ON DELETE SET NULL,
  agente_id        UUID REFERENCES agentes(id)          ON DELETE SET NULL,
  servicio_id      UUID REFERENCES agenda_servicios(id) ON DELETE SET NULL,
  titulo           VARCHAR(200),
  fecha_inicio     TIMESTAMP NOT NULL,
  fecha_fin        TIMESTAMP NOT NULL,
  estado           VARCHAR(30) DEFAULT 'pendiente'
                     CHECK (estado IN ('pendiente','confirmada','cancelada','completada','no_asistio')),
  notas            TEXT,
  notas_internas   TEXT,
  color            VARCHAR(7),
  tipo             VARCHAR(30) DEFAULT 'cita'
                     CHECK (tipo IN ('cita','reunion','llamada','otro')),
  created_by       UUID REFERENCES agentes(id),
  created_at       TIMESTAMP DEFAULT NOW(),
  updated_at       TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_citas_agente        ON citas(agente_id);
CREATE INDEX IF NOT EXISTS idx_citas_cliente       ON citas(cliente_id);
CREATE INDEX IF NOT EXISTS idx_citas_fecha         ON citas(fecha_inicio);
CREATE INDEX IF NOT EXISTS idx_citas_estado        ON citas(estado);
CREATE INDEX IF NOT EXISTS idx_disp_agente         ON agenda_disponibilidad(agente_id);
CREATE INDEX IF NOT EXISTS idx_bloqueos_agente     ON agenda_bloqueos(agente_id);

-- Disponibilidad por defecto: Lun-Vie 8am-5pm ET (UTC-4 Miami)
-- Los días 1-5 = lunes a viernes
INSERT INTO agenda_disponibilidad (agente_id, dia_semana, hora_inicio, hora_fin)
SELECT a.id, d.dia, '08:00', '17:00'
FROM agentes a
CROSS JOIN (VALUES (1),(2),(3),(4),(5)) AS d(dia)
ON CONFLICT (agente_id, dia_semana) DO NOTHING;
`;

pool.query(sql)
  .then(() => { console.log('✅ Tablas agenda creadas/verificadas'); process.exit(0); })
  .catch(err => { console.error('❌ Error:', err.message); process.exit(1); });
