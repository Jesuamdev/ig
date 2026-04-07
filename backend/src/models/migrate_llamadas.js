// src/models/migrate_llamadas.js — Tabla de llamadas
require('dotenv').config();
const { pool } = require('./db');

const sql = `
CREATE TABLE IF NOT EXISTS llamadas (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversacion_id  UUID REFERENCES conversaciones(id) ON DELETE SET NULL,
  contacto_id      UUID REFERENCES contactos(id)      ON DELETE SET NULL,
  agente_id        UUID REFERENCES agentes(id)         ON DELETE SET NULL,
  tipo             VARCHAR(20)  DEFAULT 'saliente'
                     CHECK (tipo IN ('entrante','saliente')),
  estado           VARCHAR(30)  DEFAULT 'iniciada'
                     CHECK (estado IN ('iniciada','marcando','respondida','no_respondida','finalizada','fallida','cancelada','ocupado')),
  duracion_segundos INTEGER     DEFAULT 0,
  numero_destino   VARCHAR(30),
  notas            TEXT,
  initiated_at     TIMESTAMP    DEFAULT NOW(),
  answered_at      TIMESTAMP,
  ended_at         TIMESTAMP,
  created_at       TIMESTAMP    DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_llamadas_conversacion ON llamadas(conversacion_id);
CREATE INDEX IF NOT EXISTS idx_llamadas_contacto     ON llamadas(contacto_id);
CREATE INDEX IF NOT EXISTS idx_llamadas_agente       ON llamadas(agente_id);
CREATE INDEX IF NOT EXISTS idx_llamadas_created      ON llamadas(created_at DESC);
`;

pool.query(sql)
  .then(() => { console.log('✅ Tabla llamadas creada/verificada'); process.exit(0); })
  .catch(err => { console.error('❌ Error:', err.message); process.exit(1); });
