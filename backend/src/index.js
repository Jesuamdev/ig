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
