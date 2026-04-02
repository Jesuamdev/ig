// src/models/migrate_v2.js
// Migración v2: Chatbots, Campañas, Números múltiples, Secuencias, Webhooks salientes, Integraciones, Widget
require('dotenv').config();
const { pool } = require('./db');

const sql = `

-- ============================================================
-- MÚLTIPLES NÚMEROS DE WHATSAPP
-- ============================================================
CREATE TABLE IF NOT EXISTS numeros_whatsapp (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre       VARCHAR(100) NOT NULL,
  phone_id     VARCHAR(50)  UNIQUE NOT NULL,
  token        TEXT         NOT NULL,
  business_id  VARCHAR(50),
  verify_token VARCHAR(100),
  estado       VARCHAR(20)  DEFAULT 'activo' CHECK (estado IN ('activo','inactivo')),
  created_at   TIMESTAMP    DEFAULT NOW(),
  updated_at   TIMESTAMP    DEFAULT NOW()
);

ALTER TABLE conversaciones ADD COLUMN IF NOT EXISTS numero_id UUID REFERENCES numeros_whatsapp(id) ON DELETE SET NULL;
ALTER TABLE conversaciones ADD COLUMN IF NOT EXISTS etiquetas TEXT[] DEFAULT '{}';

-- ============================================================
-- REGLAS DE ENRUTAMIENTO INTELIGENTE
-- ============================================================
CREATE TABLE IF NOT EXISTS reglas_enrutamiento (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre        VARCHAR(100) NOT NULL,
  condiciones   JSONB        NOT NULL DEFAULT '[]',
  accion        VARCHAR(50)  NOT NULL CHECK (accion IN ('asignar_agente','asignar_equipo','etiqueta','chatbot','respuesta_automatica')),
  configuracion JSONB        NOT NULL DEFAULT '{}',
  prioridad     INTEGER      DEFAULT 0,
  activa        BOOLEAN      DEFAULT TRUE,
  created_at    TIMESTAMP    DEFAULT NOW(),
  updated_at    TIMESTAMP    DEFAULT NOW()
);

-- ============================================================
-- ETIQUETAS GESTIONABLES
-- ============================================================
CREATE TABLE IF NOT EXISTS etiquetas (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      VARCHAR(50) UNIQUE NOT NULL,
  color       VARCHAR(20) DEFAULT '#6B7280',
  descripcion TEXT,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- CHATBOTS VISUALES
-- ============================================================
CREATE TABLE IF NOT EXISTS chatbots (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre           VARCHAR(100) NOT NULL,
  descripcion      TEXT,
  activo           BOOLEAN     DEFAULT FALSE,
  trigger_tipo     VARCHAR(30) DEFAULT 'palabras' CHECK (trigger_tipo IN ('palabras','todos','nuevo_contacto','siempre')),
  trigger_palabras TEXT[],
  nodo_inicio_id   UUID,
  numero_id        UUID REFERENCES numeros_whatsapp(id) ON DELETE SET NULL,
  created_at       TIMESTAMP DEFAULT NOW(),
  updated_at       TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chatbot_nodos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chatbot_id     UUID NOT NULL REFERENCES chatbots(id) ON DELETE CASCADE,
  tipo           VARCHAR(30) NOT NULL CHECK (tipo IN ('mensaje','pregunta','condicion','accion','esperar','fin')),
  nombre         VARCHAR(100),
  configuracion  JSONB NOT NULL DEFAULT '{}',
  posicion_x     INTEGER DEFAULT 0,
  posicion_y     INTEGER DEFAULT 0,
  created_at     TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chatbot_conexiones (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chatbot_id       UUID NOT NULL REFERENCES chatbots(id) ON DELETE CASCADE,
  nodo_origen_id   UUID NOT NULL REFERENCES chatbot_nodos(id) ON DELETE CASCADE,
  nodo_destino_id  UUID NOT NULL REFERENCES chatbot_nodos(id) ON DELETE CASCADE,
  condicion        VARCHAR(200),
  created_at       TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chatbot_sesiones (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chatbot_id       UUID NOT NULL REFERENCES chatbots(id),
  contacto_id      UUID NOT NULL REFERENCES contactos(id),
  conversacion_id  UUID REFERENCES conversaciones(id),
  nodo_actual_id   UUID REFERENCES chatbot_nodos(id),
  datos            JSONB DEFAULT '{}',
  estado           VARCHAR(20) DEFAULT 'activo' CHECK (estado IN ('activo','completado','abandonado','transferido')),
  mensajes_enviados INTEGER DEFAULT 0,
  created_at       TIMESTAMP DEFAULT NOW(),
  updated_at       TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- BASE DE CONOCIMIENTO (para IA)
-- ============================================================
CREATE TABLE IF NOT EXISTS base_conocimiento (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  titulo      VARCHAR(200) NOT NULL,
  contenido   TEXT NOT NULL,
  categoria   VARCHAR(100),
  etiquetas   TEXT[],
  activo      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- SECUENCIAS DE SEGUIMIENTO AUTOMÁTICO
-- ============================================================
CREATE TABLE IF NOT EXISTS secuencias (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      VARCHAR(100) NOT NULL,
  descripcion TEXT,
  activa      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS secuencia_pasos (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  secuencia_id   UUID NOT NULL REFERENCES secuencias(id) ON DELETE CASCADE,
  orden          INTEGER NOT NULL,
  tipo           VARCHAR(30) NOT NULL CHECK (tipo IN ('whatsapp','email','esperar')),
  configuracion  JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS secuencia_suscripciones (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  secuencia_id    UUID NOT NULL REFERENCES secuencias(id),
  contacto_id     UUID NOT NULL REFERENCES contactos(id),
  paso_actual     INTEGER DEFAULT 0,
  estado          VARCHAR(20) DEFAULT 'activo' CHECK (estado IN ('activo','completado','cancelado','error')),
  siguiente_envio TIMESTAMP,
  datos           JSONB DEFAULT '{}',
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- CAMPAÑAS DE DIFUSIÓN
-- ============================================================
CREATE TABLE IF NOT EXISTS campanas (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre                VARCHAR(200) NOT NULL,
  tipo                  VARCHAR(30)  NOT NULL CHECK (tipo IN ('whatsapp','sms')),
  estado                VARCHAR(30)  DEFAULT 'borrador' CHECK (estado IN ('borrador','programada','enviando','completada','pausada','cancelada')),
  mensaje               TEXT,
  plantilla_nombre      VARCHAR(100),
  plantilla_idioma      VARCHAR(10)  DEFAULT 'es',
  plantilla_componentes JSONB,
  programada_para       TIMESTAMP,
  iniciada_at           TIMESTAMP,
  completada_at         TIMESTAMP,
  numero_id             UUID REFERENCES numeros_whatsapp(id) ON DELETE SET NULL,
  agente_id             UUID REFERENCES agentes(id) ON DELETE SET NULL,
  total_destinatarios   INTEGER DEFAULT 0,
  total_enviados        INTEGER DEFAULT 0,
  total_entregados      INTEGER DEFAULT 0,
  total_leidos          INTEGER DEFAULT 0,
  total_fallidos        INTEGER DEFAULT 0,
  created_at            TIMESTAMP DEFAULT NOW(),
  updated_at            TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campana_destinatarios (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campana_id          UUID NOT NULL REFERENCES campanas(id) ON DELETE CASCADE,
  contacto_id         UUID REFERENCES contactos(id),
  telefono            VARCHAR(30) NOT NULL,
  nombre              VARCHAR(150),
  estado              VARCHAR(30) DEFAULT 'pendiente' CHECK (estado IN ('pendiente','enviado','entregado','leido','fallido')),
  whatsapp_message_id VARCHAR(100),
  error_mensaje       TEXT,
  enviado_at          TIMESTAMP,
  entregado_at        TIMESTAMP,
  leido_at            TIMESTAMP,
  created_at          TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- PLANTILLAS DE MENSAJES
-- ============================================================
CREATE TABLE IF NOT EXISTS plantillas_mensajes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre      VARCHAR(100) NOT NULL,
  categoria   VARCHAR(50)  NOT NULL CHECK (categoria IN ('marketing','utility','authentication','general')),
  idioma      VARCHAR(10)  DEFAULT 'es',
  cuerpo      TEXT NOT NULL,
  componentes JSONB,
  estado      VARCHAR(30)  DEFAULT 'activo' CHECK (estado IN ('borrador','pendiente_aprobacion','activo','rechazado')),
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- WEBHOOKS SALIENTES (outbound)
-- ============================================================
CREATE TABLE IF NOT EXISTS webhooks_salientes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre       VARCHAR(100) NOT NULL,
  url          TEXT NOT NULL,
  secret_key   VARCHAR(100),
  eventos      TEXT[] NOT NULL DEFAULT '{}',
  activo       BOOLEAN DEFAULT TRUE,
  ultimo_envio TIMESTAMP,
  ultimo_estado INTEGER,
  created_at   TIMESTAMP DEFAULT NOW(),
  updated_at   TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id  UUID NOT NULL REFERENCES webhooks_salientes(id) ON DELETE CASCADE,
  evento      VARCHAR(100) NOT NULL,
  payload     JSONB NOT NULL,
  estado      INTEGER,
  respuesta   TEXT,
  duracion_ms INTEGER,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- INTEGRACIONES
-- ============================================================
CREATE TABLE IF NOT EXISTS integraciones (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo          VARCHAR(50)  NOT NULL CHECK (tipo IN ('google_sheets','shopify','woocommerce','zapier','make','n8n','stripe','openai')),
  nombre        VARCHAR(100) NOT NULL,
  configuracion JSONB        NOT NULL DEFAULT '{}',
  activa        BOOLEAN      DEFAULT FALSE,
  ultimo_sync   TIMESTAMP,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- WIDGET WEB (chat button para sitio web)
-- ============================================================
CREATE TABLE IF NOT EXISTS widgets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre              VARCHAR(100) NOT NULL,
  telefono            VARCHAR(30)  NOT NULL,
  mensaje_bienvenida  TEXT         DEFAULT '¡Hola! ¿En qué podemos ayudarte?',
  color_primario      VARCHAR(20)  DEFAULT '#25D366',
  posicion            VARCHAR(20)  DEFAULT 'derecha' CHECK (posicion IN ('izquierda','derecha')),
  activo              BOOLEAN      DEFAULT TRUE,
  dominio             TEXT,
  visitas             INTEGER      DEFAULT 0,
  clics               INTEGER      DEFAULT 0,
  created_at          TIMESTAMP    DEFAULT NOW(),
  updated_at          TIMESTAMP    DEFAULT NOW()
);

-- ============================================================
-- TRADUCCIONES / DETECCIÓN DE INTENCIÓN IA
-- ============================================================
CREATE TABLE IF NOT EXISTS ia_configuracion (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo         VARCHAR(50) NOT NULL CHECK (tipo IN ('openai','anthropic','custom')),
  api_key      TEXT,
  modelo       VARCHAR(100) DEFAULT 'gpt-4o-mini',
  temperatura  NUMERIC(3,2) DEFAULT 0.7,
  activo       BOOLEAN DEFAULT FALSE,
  funciones    JSONB DEFAULT '{"traduccion": false, "deteccion_intencion": false, "respuesta_automatica": false}',
  created_at   TIMESTAMP DEFAULT NOW(),
  updated_at   TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- ÍNDICES ADICIONALES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_chatbot_sesiones_contacto ON chatbot_sesiones(contacto_id);
CREATE INDEX IF NOT EXISTS idx_chatbot_sesiones_estado   ON chatbot_sesiones(estado);
CREATE INDEX IF NOT EXISTS idx_campana_dest_campana      ON campana_destinatarios(campana_id);
CREATE INDEX IF NOT EXISTS idx_campana_dest_estado       ON campana_destinatarios(estado);
CREATE INDEX IF NOT EXISTS idx_secuencia_subs_siguiente  ON secuencia_suscripciones(siguiente_envio) WHERE estado='activo';
CREATE INDEX IF NOT EXISTS idx_webhook_logs_webhook      ON webhook_logs(webhook_id);
CREATE INDEX IF NOT EXISTS idx_conversaciones_numero     ON conversaciones(numero_id);

-- ============================================================
-- TRIGGER updated_at para nuevas tablas
-- ============================================================
DO $$ BEGIN
  CREATE TRIGGER trg_numeros_upd BEFORE UPDATE ON numeros_whatsapp FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_chatbots_upd BEFORE UPDATE ON chatbots FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_chatbot_sesiones_upd BEFORE UPDATE ON chatbot_sesiones FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_campanas_upd BEFORE UPDATE ON campanas FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_secuencias_upd BEFORE UPDATE ON secuencias FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_secuencia_subs_upd BEFORE UPDATE ON secuencia_suscripciones FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_webhooks_salientes_upd BEFORE UPDATE ON webhooks_salientes FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_integraciones_upd BEFORE UPDATE ON integraciones FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_widgets_upd BEFORE UPDATE ON widgets FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_base_conocimiento_upd BEFORE UPDATE ON base_conocimiento FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_plantillas_upd BEFORE UPDATE ON plantillas_mensajes FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_ia_config_upd BEFORE UPDATE ON ia_configuracion FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TRIGGER trg_reglas_enr_upd BEFORE UPDATE ON reglas_enrutamiento FOR EACH ROW EXECUTE FUNCTION fn_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔄 Ejecutando migración v2 (funcionalidades avanzadas)...');
    await client.query(sql);
    console.log('✅ Migración v2 completada');
  } catch (err) {
    console.error('❌ Error en migración v2:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
