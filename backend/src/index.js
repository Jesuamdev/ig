// src/index.js — CorpEase Sistema Unificado
require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');
const http      = require('http');
const { Server } = require('socket.io');
const path      = require('path');
const fs        = require('fs');

const logger    = require('./utils/logger');
const routes    = require('./routes/index');
const { iniciarCron } = require('./services/cronService');
const { pool }  = require('./models/db');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || '*', credentials: true },
});

const PORT = process.env.PORT || 3000;

// ── Asegurar directorios ───────────────────────────────────────────────────────
['logs', 'uploads'].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── Trust proxy (Railway / Render / Heroku están detrás de reverse proxy) ────
app.set('trust proxy', 1);

// ── Seguridad ─────────────────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: '*',
  credentials: false,
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, message: { error: 'Too many requests' } }));

// ── Body parsers ──────────────────────────────────────────────────────────────
// El webhook de WhatsApp necesita el body raw
app.use('/api/whatsapp/webhook', express.json());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Logging ───────────────────────────────────────────────────────────────────
app.use(morgan('combined', { stream: { write: m => logger.info(m.trim()) } }));

// ── Archivos estáticos (almacenamiento local) ─────────────────────────────────
app.use('/uploads', express.static(path.resolve(process.env.UPLOADS_PATH || './uploads')));

// ── Widget de WhatsApp (público) ──────────────────────────────────────────────
app.use('/widget', express.static(path.resolve(__dirname, '../../frontend/widget')));

// ── Panel de agentes y portal de clientes ─────────────────────────────────────
app.use(express.static(path.resolve(__dirname, '../../frontend')));
app.get('/panel', (req, res) => res.redirect('/panel/index.html'));
app.get('/portal', (req, res) => res.redirect('/portal/index.html'));

// ── Inyectar io en las rutas ──────────────────────────────────────────────────
app.set('io', io);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.0.0', timestamp: new Date().toISOString() }));

// ── Rutas API ─────────────────────────────────────────────────────────────────
app.use('/api', routes);

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `Ruta no encontrada: ${req.originalUrl}` }));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  logger.error(err.message);
  res.status(err.status || 500).json({ message: err.message || 'Error interno del servidor' });
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Token requerido'));
  try {
    const jwt  = require('jsonwebtoken');
    const data = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = data.id;
    socket.tipo   = data.tipo;
    next();
  } catch { next(new Error('Token inválido')); }
});

io.on('connection', (socket) => {
  if (socket.tipo === 'agente') {
    socket.join(`agent_${socket.userId}`);
    logger.info(`Agente conectado: ${socket.userId}`);
  } else {
    socket.join(`client_${socket.userId}`);
    logger.info(`Cliente conectado al portal: ${socket.userId}`);
  }

  socket.on('join_conversacion', (convId) => socket.join(`conv_${convId}`));

  // ── SEÑALIZACIÓN WebRTC PARA LLAMADAS ───────────────────────────────────────
  // Oferta de llamada → reenviar al agente destino o habitación de conversación
  socket.on('call_offer', ({ to, offer, llamada_id, caller_name, conversacion_id }) => {
    const target = to ? `agent_${to}` : (conversacion_id ? `conv_${conversacion_id}` : null);
    if (target) {
      io.to(target).emit('call_incoming', {
        from:           socket.userId,
        caller_name,
        offer,
        llamada_id,
        conversacion_id,
      });
    }
  });

  // Respuesta a llamada
  socket.on('call_answer', ({ to, answer, llamada_id }) => {
    if (to) io.to(`agent_${to}`).emit('call_answered', { from: socket.userId, answer, llamada_id });
  });

  // Candidato ICE
  socket.on('ice_candidate', ({ to, candidate }) => {
    if (to) io.to(`agent_${to}`).emit('ice_candidate', { from: socket.userId, candidate });
  });

  // Fin de llamada
  socket.on('call_end', ({ to, llamada_id }) => {
    if (to) io.to(`agent_${to}`).emit('call_ended', { from: socket.userId, llamada_id });
  });

  // Rechazar llamada
  socket.on('call_reject', ({ to, llamada_id }) => {
    if (to) io.to(`agent_${to}`).emit('call_rejected', { from: socket.userId, llamada_id });
  });

  socket.on('disconnect', () => logger.info(`Socket desconectado: ${socket.userId}`));
});

// ── Migraciones automáticas ───────────────────────────────────────────────────
async function runMigrations() {
  try {
    // ── Base: extensiones + tablas core (migrate.js) ──────────────────────────
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      CREATE OR REPLACE FUNCTION fn_updated_at()
      RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

      CREATE TABLE IF NOT EXISTS agentes (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nombre     VARCHAR(100) NOT NULL,
        email      VARCHAR(150) UNIQUE NOT NULL,
        password   VARCHAR(255) NOT NULL,
        rol        VARCHAR(20)  DEFAULT 'agente' CHECK (rol IN ('admin','agente','supervisor')),
        estado     VARCHAR(20)  DEFAULT 'activo' CHECK (estado IN ('activo','inactivo')),
        avatar_url TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS clientes (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nombre          VARCHAR(150) NOT NULL,
        apellido        VARCHAR(150),
        email           VARCHAR(150) UNIQUE NOT NULL,
        telefono        VARCHAR(30),
        pais            VARCHAR(80),
        empresa         VARCHAR(150),
        password        VARCHAR(255),
        estado          VARCHAR(20) DEFAULT 'activo' CHECK (estado IN ('activo','inactivo','archivado')),
        origen          VARCHAR(30) DEFAULT 'manual' CHECK (origen IN ('manual','wordpress','whatsapp','referido','otro')),
        agente_id       UUID REFERENCES agentes(id) ON DELETE SET NULL,
        stripe_id       TEXT,
        notas_internas  TEXT,
        portal_activo   BOOLEAN DEFAULT FALSE,
        primer_login    TIMESTAMP,
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS servicios (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cliente_id           UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        tipo                 VARCHAR(50) NOT NULL CHECK (tipo IN ('llc_formation','tax_filing','registered_agent','ein_application','bookkeeping','payroll','annual_report','otro')),
        nombre               VARCHAR(200) NOT NULL,
        descripcion          TEXT,
        estado               VARCHAR(30) DEFAULT 'pendiente' CHECK (estado IN ('pendiente','en_proceso','esperando_cliente','completado','recurrente','vencido','cancelado')),
        precio               NUMERIC(10,2),
        fecha_vencimiento    DATE,
        fecha_completado     TIMESTAMP,
        es_recurrente        BOOLEAN DEFAULT FALSE,
        intervalo_recurrente VARCHAR(20) CHECK (intervalo_recurrente IN ('mensual','trimestral','anual')),
        proxima_renovacion   DATE,
        notas                TEXT,
        created_at           TIMESTAMP DEFAULT NOW(),
        updated_at           TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS pagos (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cliente_id       UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        servicio_id      UUID REFERENCES servicios(id) ON DELETE SET NULL,
        stripe_id        TEXT,
        monto            NUMERIC(10,2) NOT NULL,
        moneda           VARCHAR(5) DEFAULT 'USD',
        estado           VARCHAR(20) DEFAULT 'pendiente' CHECK (estado IN ('pendiente','enviado','pagado','vencido','cancelado','devuelto')),
        descripcion      TEXT,
        fecha_vencimiento DATE,
        fecha_pago       TIMESTAMP,
        link_pago        TEXT,
        url_factura      TEXT,
        recordatorio_enviado BOOLEAN DEFAULT FALSE,
        created_at       TIMESTAMP DEFAULT NOW(),
        updated_at       TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS contactos (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        telefono        VARCHAR(30) UNIQUE NOT NULL,
        nombre          VARCHAR(150),
        email           VARCHAR(150),
        empresa         VARCHAR(150),
        notas           TEXT,
        etiquetas       TEXT[],
        cliente_id      UUID REFERENCES clientes(id) ON DELETE SET NULL,
        primer_contacto TIMESTAMP DEFAULT NOW(),
        ultimo_mensaje  TIMESTAMP DEFAULT NOW(),
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS conversaciones (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        contacto_id       UUID NOT NULL REFERENCES contactos(id) ON DELETE CASCADE,
        agente_id         UUID REFERENCES agentes(id) ON DELETE SET NULL,
        estado            VARCHAR(20) DEFAULT 'abierto' CHECK (estado IN ('abierto','en_proceso','resuelto','cerrado')),
        numero_caso       SERIAL,
        titulo            VARCHAR(200),
        mensajes_sin_leer INTEGER DEFAULT 0,
        ultimo_mensaje    TEXT,
        ultima_actividad  TIMESTAMP DEFAULT NOW(),
        created_at        TIMESTAMP DEFAULT NOW(),
        updated_at        TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS mensajes (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversacion_id     UUID NOT NULL REFERENCES conversaciones(id) ON DELETE CASCADE,
        contacto_id         UUID REFERENCES contactos(id),
        agente_id           UUID REFERENCES agentes(id),
        direccion           VARCHAR(10) NOT NULL CHECK (direccion IN ('entrante','saliente')),
        tipo                VARCHAR(20) DEFAULT 'texto' CHECK (tipo IN ('texto','text','image','document','audio','video','ubicacion')),
        contenido           TEXT,
        whatsapp_message_id VARCHAR(100) UNIQUE,
        estado              VARCHAR(20) DEFAULT 'enviado',
        created_at          TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS archivos (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        mensaje_id          UUID REFERENCES mensajes(id) ON DELETE SET NULL,
        conversacion_id     UUID REFERENCES conversaciones(id) ON DELETE CASCADE,
        contacto_id         UUID REFERENCES contactos(id) ON DELETE CASCADE,
        cliente_id          UUID REFERENCES clientes(id) ON DELETE SET NULL,
        servicio_id         UUID REFERENCES servicios(id) ON DELETE SET NULL,
        agente_asignado_id  UUID REFERENCES agentes(id) ON DELETE SET NULL,
        nombre_original     VARCHAR(255) NOT NULL,
        nombre_almacenado   VARCHAR(255) NOT NULL,
        tipo_mime           VARCHAR(100),
        extension           VARCHAR(20),
        tamanio_bytes       BIGINT,
        url_almacenamiento  TEXT NOT NULL,
        whatsapp_media_id   VARCHAR(100),
        tipo_documento      VARCHAR(100),
        verificado          BOOLEAN DEFAULT FALSE,
        origen              VARCHAR(20) DEFAULT 'whatsapp' CHECK (origen IN ('whatsapp','manual','wordpress','email')),
        etiquetas           TEXT[],
        created_at          TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS solicitudes_archivos (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cliente_id   UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
        servicio_id  UUID REFERENCES servicios(id) ON DELETE SET NULL,
        agente_id    UUID REFERENCES agentes(id) ON DELETE SET NULL,
        titulo       VARCHAR(200) NOT NULL,
        descripcion  TEXT,
        estado       VARCHAR(20) DEFAULT 'pendiente' CHECK (estado IN ('pendiente','recibido','rechazado')),
        fecha_limite DATE,
        archivo_id   UUID REFERENCES archivos(id) ON DELETE SET NULL,
        created_at   TIMESTAMP DEFAULT NOW(),
        updated_at   TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS notificaciones (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cliente_id UUID REFERENCES clientes(id) ON DELETE CASCADE,
        agente_id  UUID REFERENCES agentes(id) ON DELETE CASCADE,
        tipo       VARCHAR(50) NOT NULL,
        titulo     VARCHAR(200),
        mensaje    TEXT,
        canal      VARCHAR(20) DEFAULT 'sistema' CHECK (canal IN ('sistema','email','whatsapp','todos')),
        leida      BOOLEAN DEFAULT FALSE,
        enviada    BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS actividad (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        cliente_id UUID REFERENCES clientes(id) ON DELETE SET NULL,
        agente_id  UUID REFERENCES agentes(id) ON DELETE SET NULL,
        accion     VARCHAR(100) NOT NULL,
        detalles   JSONB,
        ip         VARCHAR(45),
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_clientes_telefono       ON clientes(telefono);
      CREATE INDEX IF NOT EXISTS idx_clientes_email          ON clientes(email);
      CREATE INDEX IF NOT EXISTS idx_contactos_telefono      ON contactos(telefono);
      CREATE INDEX IF NOT EXISTS idx_contactos_cliente       ON contactos(cliente_id);
      CREATE INDEX IF NOT EXISTS idx_conversaciones_contacto ON conversaciones(contacto_id);
      CREATE INDEX IF NOT EXISTS idx_mensajes_conversacion   ON mensajes(conversacion_id);
      CREATE INDEX IF NOT EXISTS idx_mensajes_waid           ON mensajes(whatsapp_message_id);
      CREATE INDEX IF NOT EXISTS idx_archivos_cliente        ON archivos(cliente_id);
      CREATE INDEX IF NOT EXISTS idx_archivos_conversacion   ON archivos(conversacion_id);
      CREATE INDEX IF NOT EXISTS idx_servicios_cliente       ON servicios(cliente_id);
      CREATE INDEX IF NOT EXISTS idx_pagos_cliente           ON pagos(cliente_id);
      CREATE INDEX IF NOT EXISTS idx_actividad_cliente       ON actividad(cliente_id);
    `);

    // ── V2: tablas adicionales (migrate_v2.js) ────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS numeros_whatsapp (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nombre       VARCHAR(100) NOT NULL,
        phone_id     VARCHAR(50) UNIQUE NOT NULL,
        token        TEXT NOT NULL,
        business_id  VARCHAR(50),
        verify_token VARCHAR(100),
        estado       VARCHAR(20) DEFAULT 'activo' CHECK (estado IN ('activo','inactivo')),
        created_at   TIMESTAMP DEFAULT NOW(),
        updated_at   TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE conversaciones ADD COLUMN IF NOT EXISTS numero_id UUID REFERENCES numeros_whatsapp(id) ON DELETE SET NULL;
      ALTER TABLE conversaciones ADD COLUMN IF NOT EXISTS etiquetas TEXT[] DEFAULT '{}';
      CREATE TABLE IF NOT EXISTS reglas_enrutamiento (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nombre        VARCHAR(100) NOT NULL,
        condiciones   JSONB NOT NULL DEFAULT '[]',
        accion        VARCHAR(50) NOT NULL CHECK (accion IN ('asignar_agente','asignar_equipo','etiqueta','chatbot','respuesta_automatica')),
        configuracion JSONB NOT NULL DEFAULT '{}',
        prioridad     INTEGER DEFAULT 0,
        activa        BOOLEAN DEFAULT TRUE,
        created_at    TIMESTAMP DEFAULT NOW(),
        updated_at    TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS etiquetas (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nombre      VARCHAR(50) UNIQUE NOT NULL,
        color       VARCHAR(20) DEFAULT '#6B7280',
        descripcion TEXT,
        created_at  TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS secuencias (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nombre      VARCHAR(100) NOT NULL,
        descripcion TEXT,
        activa      BOOLEAN DEFAULT TRUE,
        created_at  TIMESTAMP DEFAULT NOW(),
        updated_at  TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS secuencia_pasos (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        secuencia_id  UUID NOT NULL REFERENCES secuencias(id) ON DELETE CASCADE,
        orden         INTEGER NOT NULL,
        tipo          VARCHAR(30) NOT NULL CHECK (tipo IN ('whatsapp','email','esperar')),
        configuracion JSONB NOT NULL DEFAULT '{}',
        created_at    TIMESTAMP DEFAULT NOW()
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
      CREATE TABLE IF NOT EXISTS campanas (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nombre                VARCHAR(200) NOT NULL,
        tipo                  VARCHAR(30) NOT NULL CHECK (tipo IN ('whatsapp','sms')),
        estado                VARCHAR(30) DEFAULT 'borrador' CHECK (estado IN ('borrador','programada','enviando','completada','pausada','cancelada')),
        mensaje               TEXT,
        plantilla_nombre      VARCHAR(100),
        plantilla_idioma      VARCHAR(10) DEFAULT 'es',
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
      CREATE TABLE IF NOT EXISTS plantillas_mensajes (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nombre      VARCHAR(100) NOT NULL,
        categoria   VARCHAR(50) NOT NULL CHECK (categoria IN ('marketing','utility','authentication','general')),
        idioma      VARCHAR(10) DEFAULT 'es',
        cuerpo      TEXT NOT NULL,
        componentes JSONB,
        estado      VARCHAR(30) DEFAULT 'activo' CHECK (estado IN ('borrador','pendiente_aprobacion','activo','rechazado')),
        created_at  TIMESTAMP DEFAULT NOW(),
        updated_at  TIMESTAMP DEFAULT NOW()
      );
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
      CREATE TABLE IF NOT EXISTS integraciones (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tipo          VARCHAR(50) NOT NULL,
        nombre        VARCHAR(100),
        configuracion JSONB DEFAULT '{}',
        activa        BOOLEAN DEFAULT false,
        ultimo_sync   TIMESTAMP,
        created_at    TIMESTAMP DEFAULT NOW(),
        updated_at    TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS widgets (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nombre             VARCHAR(100) NOT NULL,
        telefono           VARCHAR(30) NOT NULL,
        mensaje_bienvenida TEXT DEFAULT '¡Hola! ¿En qué podemos ayudarte?',
        color_primario     VARCHAR(20) DEFAULT '#25D366',
        posicion           VARCHAR(20) DEFAULT 'derecha' CHECK (posicion IN ('izquierda','derecha')),
        activo             BOOLEAN DEFAULT TRUE,
        dominio            TEXT,
        visitas            INTEGER DEFAULT 0,
        clics              INTEGER DEFAULT 0,
        created_at         TIMESTAMP DEFAULT NOW(),
        updated_at         TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_campana_dest_campana     ON campana_destinatarios(campana_id);
      CREATE INDEX IF NOT EXISTS idx_campana_dest_estado      ON campana_destinatarios(estado);
      CREATE INDEX IF NOT EXISTS idx_secuencia_subs_siguiente ON secuencia_suscripciones(siguiente_envio) WHERE estado='activo';
      CREATE INDEX IF NOT EXISTS idx_webhook_logs_webhook     ON webhook_logs(webhook_id);
      CREATE INDEX IF NOT EXISTS idx_conversaciones_numero    ON conversaciones(numero_id);
    `);

    // ── IA Configuración ──────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ia_configuracion (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tipo        VARCHAR(50) NOT NULL DEFAULT 'groq',
        api_key     TEXT,
        modelo      VARCHAR(100) DEFAULT 'llama-3.3-70b-versatile',
        temperatura NUMERIC(3,2) DEFAULT 0.7,
        activo      BOOLEAN DEFAULT FALSE,
        funciones   JSONB DEFAULT '{"traduccion":true,"deteccion_intencion":true,"respuesta_automatica":true}',
        created_at  TIMESTAMP DEFAULT NOW(),
        updated_at  TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE ia_configuracion DROP CONSTRAINT IF EXISTS ia_configuracion_tipo_check;
      ALTER TABLE ia_configuracion ADD CONSTRAINT ia_configuracion_tipo_check
        CHECK (tipo IN ('openai','anthropic','groq','custom'));
    `);

    // ── Chatbots ──────────────────────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chatbots (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nombre           VARCHAR(100) NOT NULL,
        descripcion      TEXT,
        activo           BOOLEAN DEFAULT false,
        trigger_tipo     VARCHAR(30) DEFAULT 'palabras',
        trigger_palabras TEXT[] DEFAULT '{}',
        nodo_inicio_id   UUID,
        numero_id        VARCHAR(50),
        created_at       TIMESTAMP DEFAULT NOW(),
        updated_at       TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE chatbots DROP CONSTRAINT IF EXISTS chatbots_trigger_tipo_check;
      ALTER TABLE chatbots ADD CONSTRAINT chatbots_trigger_tipo_check
        CHECK (trigger_tipo IN ('palabras','siempre','nuevo_contacto','todos'));
      CREATE TABLE IF NOT EXISTS chatbot_nodos (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chatbot_id    UUID REFERENCES chatbots(id) ON DELETE CASCADE,
        tipo          VARCHAR(30) DEFAULT 'mensaje',
        nombre        VARCHAR(100),
        configuracion JSONB DEFAULT '{}',
        posicion_x    FLOAT DEFAULT 0,
        posicion_y    FLOAT DEFAULT 0,
        created_at    TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE chatbot_nodos DROP CONSTRAINT IF EXISTS chatbot_nodos_tipo_check;
      ALTER TABLE chatbot_nodos ADD CONSTRAINT chatbot_nodos_tipo_check
        CHECK (tipo IN ('inicio','mensaje','pregunta','condicion','accion','esperar','fin','claude','ia_intent','traducir','asignar','etiquetar'));
      CREATE TABLE IF NOT EXISTS chatbot_conexiones (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chatbot_id      UUID REFERENCES chatbots(id) ON DELETE CASCADE,
        nodo_origen_id  UUID REFERENCES chatbot_nodos(id) ON DELETE CASCADE,
        nodo_destino_id UUID REFERENCES chatbot_nodos(id) ON DELETE CASCADE,
        condicion       VARCHAR(200),
        created_at      TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS chatbot_sesiones (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chatbot_id        UUID REFERENCES chatbots(id) ON DELETE CASCADE,
        contacto_id       UUID REFERENCES contactos(id) ON DELETE CASCADE,
        conversacion_id   UUID REFERENCES conversaciones(id) ON DELETE SET NULL,
        nodo_actual_id    UUID REFERENCES chatbot_nodos(id) ON DELETE SET NULL,
        estado            VARCHAR(20) DEFAULT 'activo'
                            CHECK (estado IN ('activo','completado','abandonado','transferido','error')),
        datos             JSONB DEFAULT '{}',
        mensajes_enviados INTEGER DEFAULT 0,
        created_at        TIMESTAMP DEFAULT NOW(),
        updated_at        TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE chatbot_sesiones ADD COLUMN IF NOT EXISTS conversacion_id UUID REFERENCES conversaciones(id) ON DELETE SET NULL;
      ALTER TABLE chatbot_sesiones ADD COLUMN IF NOT EXISTS mensajes_enviados INTEGER DEFAULT 0;
      CREATE TABLE IF NOT EXISTS base_conocimiento (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        titulo     VARCHAR(200) NOT NULL,
        contenido  TEXT NOT NULL,
        categoria  VARCHAR(100),
        etiquetas  TEXT[] DEFAULT '{}',
        activo     BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_chatbot_nodos_bot    ON chatbot_nodos(chatbot_id);
      CREATE INDEX IF NOT EXISTS idx_chatbot_conex_bot    ON chatbot_conexiones(chatbot_id);
      CREATE INDEX IF NOT EXISTS idx_chatbot_sesiones_bot ON chatbot_sesiones(chatbot_id);
      CREATE INDEX IF NOT EXISTS idx_chatbot_sesiones_con ON chatbot_sesiones(contacto_id);
      CREATE INDEX IF NOT EXISTS idx_chatbot_sesiones_estado ON chatbot_sesiones(estado);
    `);

    // ── Agenda ────────────────────────────────────────────────────────────────
    await pool.query(`
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
    `);
    // ── Agenda ──
    await pool.query(`
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
      CREATE INDEX IF NOT EXISTS idx_citas_agente    ON citas(agente_id);
      CREATE INDEX IF NOT EXISTS idx_citas_cliente   ON citas(cliente_id);
      CREATE INDEX IF NOT EXISTS idx_citas_fecha     ON citas(fecha_inicio);
      CREATE INDEX IF NOT EXISTS idx_disp_agente     ON agenda_disponibilidad(agente_id);
      CREATE INDEX IF NOT EXISTS idx_bloqueos_agente ON agenda_bloqueos(agente_id);
    `);
    // Disponibilidad Lun-Vie por defecto para agentes existentes
    await pool.query(`
      INSERT INTO agenda_disponibilidad (agente_id, dia_semana, hora_inicio, hora_fin)
      SELECT a.id, d.dia, '08:00', '17:00'
      FROM agentes a
      CROSS JOIN (VALUES (1),(2),(3),(4),(5)) AS d(dia)
      ON CONFLICT (agente_id, dia_semana) DO NOTHING
    `);
    // ── IA Configuración ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ia_configuracion (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tipo         VARCHAR(50) NOT NULL DEFAULT 'groq',
        api_key      TEXT,
        modelo       VARCHAR(100) DEFAULT 'llama-3.3-70b-versatile',
        temperatura  NUMERIC(3,2) DEFAULT 0.7,
        activo       BOOLEAN DEFAULT FALSE,
        funciones    JSONB DEFAULT '{"traduccion":true,"deteccion_intencion":true,"respuesta_automatica":true}',
        created_at   TIMESTAMP DEFAULT NOW(),
        updated_at   TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE ia_configuracion DROP CONSTRAINT IF EXISTS ia_configuracion_tipo_check;
      ALTER TABLE ia_configuracion ADD CONSTRAINT ia_configuracion_tipo_check
        CHECK (tipo IN ('openai','anthropic','groq','custom'));
    `);
    // ── Chatbots ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chatbots (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nombre           VARCHAR(100) NOT NULL,
        descripcion      TEXT,
        activo           BOOLEAN DEFAULT false,
        trigger_tipo     VARCHAR(30) DEFAULT 'palabras'
                           CHECK (trigger_tipo IN ('palabras','siempre','nuevo_contacto')),
        trigger_palabras TEXT[]  DEFAULT '{}',
        nodo_inicio_id   UUID,
        numero_id        VARCHAR(50),
        created_at       TIMESTAMP DEFAULT NOW(),
        updated_at       TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS chatbot_nodos (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chatbot_id     UUID REFERENCES chatbots(id) ON DELETE CASCADE,
        tipo           VARCHAR(30) DEFAULT 'mensaje'
                         CHECK (tipo IN ('inicio','mensaje','pregunta','condicion','accion','fin','ia')),
        nombre         VARCHAR(100),
        configuracion  JSONB DEFAULT '{}',
        posicion_x     FLOAT DEFAULT 0,
        posicion_y     FLOAT DEFAULT 0,
        created_at     TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS chatbot_conexiones (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chatbot_id      UUID REFERENCES chatbots(id) ON DELETE CASCADE,
        nodo_origen_id  UUID REFERENCES chatbot_nodos(id) ON DELETE CASCADE,
        nodo_destino_id UUID REFERENCES chatbot_nodos(id) ON DELETE CASCADE,
        condicion       JSONB,
        created_at      TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS chatbot_sesiones (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        chatbot_id       UUID REFERENCES chatbots(id) ON DELETE CASCADE,
        contacto_id      UUID REFERENCES contactos(id) ON DELETE CASCADE,
        conversacion_id  UUID REFERENCES conversaciones(id) ON DELETE SET NULL,
        nodo_actual_id   UUID REFERENCES chatbot_nodos(id) ON DELETE SET NULL,
        estado           VARCHAR(20) DEFAULT 'activo'
                           CHECK (estado IN ('activo','completado','abandonado','transferido','error')),
        datos            JSONB DEFAULT '{}',
        mensajes_enviados INTEGER DEFAULT 0,
        created_at       TIMESTAMP DEFAULT NOW(),
        updated_at       TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE chatbot_sesiones ADD COLUMN IF NOT EXISTS conversacion_id UUID REFERENCES conversaciones(id) ON DELETE SET NULL;
      ALTER TABLE chatbot_sesiones ADD COLUMN IF NOT EXISTS mensajes_enviados INTEGER DEFAULT 0;
      CREATE TABLE IF NOT EXISTS base_conocimiento (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        titulo      VARCHAR(200) NOT NULL,
        contenido   TEXT NOT NULL,
        categoria   VARCHAR(100),
        etiquetas   TEXT[] DEFAULT '{}',
        activo      BOOLEAN DEFAULT true,
        created_at  TIMESTAMP DEFAULT NOW(),
        updated_at  TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_chatbot_nodos_bot    ON chatbot_nodos(chatbot_id);
      CREATE INDEX IF NOT EXISTS idx_chatbot_conex_bot    ON chatbot_conexiones(chatbot_id);
      CREATE INDEX IF NOT EXISTS idx_chatbot_sesiones_bot ON chatbot_sesiones(chatbot_id);
      CREATE INDEX IF NOT EXISTS idx_chatbot_sesiones_con ON chatbot_sesiones(contacto_id);
    `);
    // Tabla integraciones (crear si no existe)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS integraciones (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tipo           VARCHAR(50) NOT NULL,
        nombre         VARCHAR(100),
        configuracion  JSONB DEFAULT '{}',
        activa         BOOLEAN DEFAULT false,
        created_at     TIMESTAMP DEFAULT NOW(),
        updated_at     TIMESTAMP DEFAULT NOW()
      );
    `);
    // Amelia integration
    await pool.query(`
      ALTER TABLE citas ADD COLUMN IF NOT EXISTS amelia_appointment_id INTEGER;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_citas_amelia ON citas(amelia_appointment_id) WHERE amelia_appointment_id IS NOT NULL;
    `);
    // Expandir CHECK constraint de integraciones para incluir 'amelia'
    await pool.query(`
      ALTER TABLE integraciones DROP CONSTRAINT IF EXISTS integraciones_tipo_check;
      ALTER TABLE integraciones ADD CONSTRAINT integraciones_tipo_check
        CHECK (tipo IN ('google_sheets','shopify','woocommerce','zapier','make','n8n','stripe','openai','amelia'));
    `).catch(() => {}); // ignorar si ya existe o no aplica
    // Unique en tipo para upsert
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_integraciones_tipo ON integraciones(tipo);
    `).catch(() => {});
    // Insertar config inicial de Amelia si no existe
    await pool.query(`
      INSERT INTO integraciones (tipo, nombre, configuracion, activa)
      VALUES ('amelia', 'Amelia Booking', '{"wp_url":"","api_key":"","webhook_secret":"","employee_map":{},"service_map":{}}', false)
      ON CONFLICT (tipo) DO NOTHING;
    `).catch(() => {});
    logger.info('✅ Migraciones aplicadas');
  } catch (err) {
    logger.error('❌ Error en migración:', err.message);
  }
}

// ── Arrancar ──────────────────────────────────────────────────────────────────
server.listen(PORT, async () => {
  await runMigrations();
  logger.info(`🚀 CorpEase v2 corriendo en puerto ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  logger.info(`📱 WhatsApp webhook: /api/whatsapp/webhook`);
  logger.info(`🖥️  Panel agentes:   ${process.env.FRONTEND_URL || 'http://localhost:5500'}`);
  logger.info(`🤖 Chatbots API:    /api/chatbots`);
  logger.info(`📢 Campañas API:    /api/campanas`);
  logger.info(`📊 Reportes API:    /api/reportes`);
  logger.info(`🔗 Webhooks API:    /api/webhooks-salientes`);
  logger.info(`⚙️  Widget JS:       /widget/widget.js`);
  iniciarCron();
});

module.exports = { app, server, io };
