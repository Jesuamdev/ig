// src/models/migrate_v3.js
// Migración v3: Recuperación de contraseña, mejoras menores
require('dotenv').config();
const { pool } = require('./db');

const sql = `

-- ============================================================
-- RECUPERACIÓN DE CONTRASEÑA
-- ============================================================
CREATE TABLE IF NOT EXISTS password_resets (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      VARCHAR(200) NOT NULL UNIQUE,
  tabla      VARCHAR(20)  NOT NULL DEFAULT 'agentes',
  codigo     VARCHAR(10)  NOT NULL,
  usado      BOOLEAN      DEFAULT FALSE,
  expira_at  TIMESTAMP    NOT NULL,
  created_at TIMESTAMP    DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_resets_email ON password_resets(email);

`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄 Ejecutando migración v3 (recuperación de contraseña)...');
    await client.query(sql);
    console.log('✅ Migración v3 completada');
  } catch (err) {
    console.error('❌ Error en migración v3:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
