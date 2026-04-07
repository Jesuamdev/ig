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
