// src/routes/index.js
const router = require('express').Router();
const multer = require('multer');
const logger = require('../utils/logger');

const { authenticate, soloAgente, soloCliente, soloAdmin } = require('../middleware/auth');
const authCtrl     = require('../controllers/authController');
const clientesCtrl = require('../controllers/clientesController');
const svcsCtrl     = require('../controllers/serviciosController');
const pagosCtrl    = require('../controllers/pagosController');
const archCtrl     = require('../controllers/archivosController');
const dashCtrl     = require('../controllers/dashboardController');
const { conv }     = require('../controllers/dashboardController');
const webhookCtrl  = require('../controllers/webhookController');
const llamadasCtrl = require('../controllers/llamadasController');
const { procesarRecordatorios, procesarRecordatoriosCitas } = require('../services/cronService');
const ameliaService = require('../services/ameliaService');
const { query }    = require('../models/db');
const bcrypt       = require('bcryptjs');

// ── AUTH ───────────────────────────────────────────────────────────────────────
router.post('/auth/login',              authCtrl.loginAgente);
router.post('/auth/cliente/login',      authCtrl.loginCliente);
router.get ('/auth/perfil',             authenticate, authCtrl.perfil);
router.put ('/auth/cambiar-password',   authenticate, authCtrl.cambiarPassword);
router.post('/auth/forgot-password',    authCtrl.forgotPassword);
router.post('/auth/reset-password',     authCtrl.resetPassword);

// ── WHATSAPP WEBHOOK (público) ─────────────────────────────────────────────────
router.get ('/whatsapp/webhook',  webhookCtrl.verificarWebhook);
router.post('/whatsapp/webhook',  webhookCtrl.recibirMensaje);

// ── WHATSAPP — envío (solo agentes) ───────────────────────────────────────────
router.post('/whatsapp/enviar', authenticate, soloAgente, async (req, res) => {
  try {
    const { telefono, mensaje, conversacion_id } = req.body;
    const waService = require('../services/whatsappService');
    const result = await waService.enviarTexto(telefono.replace(/\D/g,''), mensaje, conversacion_id, req.user.id);
    res.json({ success: true, ...result });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
router.get('/dashboard', authenticate, soloAgente, dashCtrl.resumen);

// ── CLIENTES ──────────────────────────────────────────────────────────────────
router.get ('/clientes',                  authenticate, soloAgente, clientesCtrl.listar);
router.get ('/clientes/:id',              authenticate, soloAgente, clientesCtrl.obtener);
router.post('/clientes',                  authenticate, soloAgente, clientesCtrl.crear);
router.put ('/clientes/:id',              authenticate, soloAgente, clientesCtrl.actualizar);
router.post('/clientes/:id/activar-portal', authenticate, soloAgente, clientesCtrl.activarPortal);
router.get ('/clientes/:id/timeline',     authenticate, soloAgente, clientesCtrl.timeline);

// ── NOTAS INTERNAS ────────────────────────────────────────────────────────────
router.get('/clientes/:id/notas', authenticate, soloAgente, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT a.id, a.detalles, a.created_at, ag.nombre AS agente_nombre
      FROM actividad a
      LEFT JOIN agentes ag ON a.agente_id = ag.id
      WHERE a.cliente_id = $1 AND a.accion = 'nota.interna'
      ORDER BY a.created_at DESC LIMIT 50
    `, [req.params.id]);
    res.json(rows.map(r => ({
      id: r.id,
      texto: r.detalles?.texto || '',
      agente: r.agente_nombre,
      fecha: r.created_at,
    })));
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/clientes/:id/notas', authenticate, soloAgente, async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto?.trim()) return res.status(400).json({ message: 'Texto requerido' });
    await query(`
      INSERT INTO actividad (cliente_id, agente_id, accion, detalles)
      VALUES ($1, $2, 'nota.interna', $3)
    `, [req.params.id, req.user.id, JSON.stringify({ texto: texto.trim() })]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── ETIQUETAS EN CONVERSACIONES ───────────────────────────────────────────────
router.put('/conversaciones/:id/etiquetas', authenticate, soloAgente, async (req, res) => {
  try {
    const { etiquetas } = req.body;
    const { rows } = await query(`
      UPDATE conversaciones SET etiquetas = $1 WHERE id = $2 RETURNING *
    `, [etiquetas || [], req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrada' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── HISTORIAL DE ACTIVIDAD COMPLETO ──────────────────────────────────────────
router.get('/clientes/:id/actividad', authenticate, soloAgente, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT a.*, ag.nombre AS agente_nombre
      FROM actividad a
      LEFT JOIN agentes ag ON a.agente_id = ag.id
      WHERE a.cliente_id = $1
      ORDER BY a.created_at DESC LIMIT 100
    `, [req.params.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── CONFIGURACIÓN DE RECORDATORIOS ────────────────────────────────────────────
router.get('/pagos/:id/recordatorios', authenticate, soloAgente, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT p.*, c.nombre AS cliente_nombre, c.email, c.telefono,
             s.nombre AS servicio_nombre,
             EXTRACT(DAY FROM (p.fecha_vencimiento - NOW())) AS dias_restantes
      FROM pagos p
      JOIN clientes c ON p.cliente_id = c.id
      LEFT JOIN servicios s ON p.servicio_id = s.id
      WHERE p.id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/pagos/:id/programar-recordatorio', authenticate, soloAgente, async (req, res) => {
  try {
    const { dias_antes, canales = ['whatsapp', 'email'], mensaje_personalizado } = req.body;
    const { rows } = await query(`
      UPDATE pagos SET
        recordatorio_enviado = FALSE,
        descripcion = COALESCE(descripcion, '') || $1
      WHERE id = $2 RETURNING *
    `, [`\n[Recordatorio programado: ${dias_antes} días antes, canales: ${canales.join(',')}]`, req.params.id]);

    await query(`INSERT INTO actividad (agente_id, cliente_id, accion, detalles)
      SELECT $1, p.cliente_id, 'recordatorio.programado', $2
      FROM pagos p WHERE p.id = $3`,
      [req.user.id, JSON.stringify({ dias_antes, canales }), req.params.id]);

    res.json({ success: true, pago: rows[0] });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/recordatorios/ejecutar', authenticate, soloAgente, async (req, res) => {
  try {
    await procesarRecordatorios();
    res.json({ success: true, message: 'Recordatorios procesados' });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── SERVICIOS ─────────────────────────────────────────────────────────────────
router.get ('/servicios',      authenticate, soloAgente, svcsCtrl.listar);
router.post('/servicios',      authenticate, soloAgente, svcsCtrl.crear);
router.put ('/servicios/:id',  authenticate, soloAgente, svcsCtrl.actualizar);

// ── PAGOS ─────────────────────────────────────────────────────────────────────
router.get ('/pagos',                          authenticate, soloAgente, pagosCtrl.listar);
router.post('/pagos',                          authenticate, soloAgente, pagosCtrl.crear);
router.put ('/pagos/:id/marcar-pagado',        authenticate, soloAgente, pagosCtrl.marcarPagado);
router.post('/pagos/:id/enviar-recordatorio',  authenticate, soloAgente, pagosCtrl.enviarRecordatorio);
router.post('/pagos/:id/enviar-factura',       authenticate, soloAgente, pagosCtrl.enviarFactura);

// ── ARCHIVOS ──────────────────────────────────────────────────────────────────
router.get ('/archivos',              authenticate, soloAgente, archCtrl.listar);
router.post('/archivos/upload',       authenticate, soloAgente, ...archCtrl.uploadManual);
router.patch('/archivos/:id',         authenticate, soloAgente, archCtrl.clasificar);
router.get ('/archivos/:id/descargar',authenticate,             archCtrl.descargar);

// ── SOLICITUDES DE ARCHIVOS ───────────────────────────────────────────────────
router.get ('/solicitudes-archivos',              authenticate, soloAgente, archCtrl.listarSolicitudes);
router.post('/solicitudes-archivos',              authenticate, soloAgente, archCtrl.crearSolicitud);
router.put ('/solicitudes-archivos/:id/vincular', authenticate, soloAgente, archCtrl.vincularArchivo);

// ── CONVERSACIONES ────────────────────────────────────────────────────────────
router.get ('/conversaciones',                 authenticate, soloAgente, conv.listar);
router.get ('/conversaciones/:id',             authenticate, soloAgente, conv.obtener);
router.post('/conversaciones/:id/mensajes',    authenticate, soloAgente, conv.enviarMensaje);
router.put ('/conversaciones/:id/estado',      authenticate, soloAgente, conv.cambiarEstado);
router.put ('/conversaciones/:id/asignar',     authenticate, soloAgente, conv.asignarAgente);
router.put ('/conversaciones/:id/leer',        authenticate, soloAgente, async (req, res) => {
  try {
    await query(`UPDATE conversaciones SET mensajes_sin_leer=0 WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});
router.delete('/conversaciones/:id',           authenticate, soloAgente, async (req, res) => {
  try {
    await query(`DELETE FROM conversaciones WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── AGENTES ───────────────────────────────────────────────────────────────────
router.get ('/agentes', authenticate, soloAgente, async (req, res) => {
  const { rows } = await query(`SELECT id,nombre,email,rol,estado,avatar_url,created_at FROM agentes ORDER BY nombre`);
  res.json(rows);
});
router.post('/agentes', authenticate, soloAdmin, async (req, res) => {
  const { nombre, email, password, rol = 'agente' } = req.body;
  const hash = await bcrypt.hash(password, 12);
  const { rows } = await query(`INSERT INTO agentes (nombre,email,password,rol) VALUES ($1,$2,$3,$4) RETURNING id,nombre,email,rol`, [nombre,email,hash,rol]);
  res.status(201).json(rows[0]);
});
router.delete('/agentes/:id', authenticate, soloAdmin, async (req, res) => {
  await query(`UPDATE agentes SET estado='inactivo' WHERE id=$1`, [req.params.id]);
  res.json({ message: 'Agente desactivado' });
});

// ── CONVERTIR CONTACTO WA → CLIENTE ──────────────────────────────────────────
router.post('/whatsapp/contacto/:contactoId/convertir-cliente', authenticate, soloAgente, async (req, res) => {
  const { contactoId } = req.params;
  const { nombre, apellido, email, pais, password, activar_portal = true } = req.body;

  if (!nombre || !email) return res.status(400).json({ message: 'Nombre y email son requeridos' });

  try {
    const { rows: cRows } = await query(`SELECT * FROM contactos WHERE id = $1`, [contactoId]);
    if (!cRows.length) return res.status(404).json({ message: 'Contacto no encontrado' });
    const contacto = cRows[0];

    if (contacto.cliente_id) {
      const { rows: existing } = await query(`SELECT id, nombre, apellido, email FROM clientes WHERE id = $1`, [contacto.cliente_id]);
      return res.json({ cliente: existing[0], ya_existia: true });
    }

    const { rows: clienteRows } = await query(`
      INSERT INTO clientes (nombre, apellido, email, telefono, pais, origen, agente_id)
      VALUES ($1, $2, $3, $4, $5, 'whatsapp', $6)
      ON CONFLICT (email) DO UPDATE SET telefono = COALESCE(clientes.telefono, EXCLUDED.telefono)
      RETURNING *
    `, [nombre, apellido || '', email.toLowerCase().trim(), contacto.telefono, pais || null, req.user.id]);
    const cliente = clienteRows[0];

    await query(`UPDATE contactos SET cliente_id = $1, nombre = $2 WHERE id = $3`,
      [cliente.id, `${nombre} ${apellido || ''}`.trim(), contactoId]);

    await query(`UPDATE archivos SET cliente_id = $1 WHERE contacto_id = $2 AND cliente_id IS NULL`, [cliente.id, contactoId]);

    let passwordGenerado = null;
    if (activar_portal) {
      const pass = password || generarPass();
      const hash = await bcrypt.hash(pass, 12);
      await query(`UPDATE clientes SET password = $1, portal_activo = TRUE WHERE id = $2`, [hash, cliente.id]);
      passwordGenerado = pass;
    }

    await query(`INSERT INTO actividad (agente_id, cliente_id, accion, detalles) VALUES ($1,$2,$3,$4)`,
      [req.user.id, cliente.id, 'cliente.creado_desde_whatsapp', JSON.stringify({ telefono: contacto.telefono })]);

    res.status(201).json({ cliente, password_temporal: passwordGenerado, ya_existia: false });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'Ya existe un cliente con ese email' });
    logger.error('convertirCliente:', err.message);
    res.status(500).json({ message: err.message });
  }
});

function generarPass() {
  const c = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#';
  return Array.from({ length: 10 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

router.get('/contactos', authenticate, soloAgente, async (req, res) => {
  const { buscar } = req.query;
  const params = []; const conds = [];
  if (buscar) { params.push(`%${buscar}%`); conds.push(`(telefono ILIKE $1 OR nombre ILIKE $1 OR email ILIKE $1)`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const { rows } = await query(`SELECT * FROM contactos ${where} ORDER BY ultimo_mensaje DESC LIMIT 50`, params);
  res.json(rows);
});
router.put('/contactos/:id', authenticate, soloAgente, async (req, res) => {
  const { nombre, email, empresa, notas, cliente_id } = req.body;
  const { rows } = await query(`UPDATE contactos SET nombre=$1,email=$2,empresa=$3,notas=$4,cliente_id=$5 WHERE id=$6 RETURNING *`,
    [nombre,email,empresa,notas,cliente_id||null,req.params.id]);
  res.json(rows[0]);
});

// ── NOTIFICACIONES ─────────────────────────────────────────────────────────────
router.get ('/notificaciones', authenticate, soloAgente, async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM notificaciones WHERE (agente_id = $1 OR agente_id IS NULL) ORDER BY created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json(rows);
});
router.get ('/notificaciones/unread-count', authenticate, soloAgente, async (req, res) => {
  const { rows } = await query(
    `SELECT COUNT(*) AS total FROM notificaciones WHERE (agente_id = $1 OR agente_id IS NULL) AND leida = FALSE`,
    [req.user.id]
  );
  res.json({ total: parseInt(rows[0].total) });
});
router.put('/notificaciones/:id/leer', authenticate, async (req, res) => {
  await query(`UPDATE notificaciones SET leida=TRUE WHERE id=$1`, [req.params.id]);
  res.json({ success: true });
});
router.put('/notificaciones/leer-todas', authenticate, soloAgente, async (req, res) => {
  await query(
    `UPDATE notificaciones SET leida=TRUE WHERE (agente_id = $1 OR agente_id IS NULL) AND leida=FALSE`,
    [req.user.id]
  );
  res.json({ success: true });
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────
router.post('/admin/run-reminders', authenticate, soloAdmin, async (req, res) => {
  await procesarRecordatorios();
  res.json({ success: true, message: 'Recordatorios procesados' });
});
router.post('/admin/run-cita-reminders', authenticate, soloAdmin, async (req, res) => {
  await procesarRecordatoriosCitas();
  res.json({ success: true, message: 'Recordatorios de citas procesados' });
});

// ── WORDPRESS WEBHOOK (público) ───────────────────────────────────────────────
router.post('/wordpress/webhook', async (req, res) => {
  const token = req.headers['x-wp-webhook-secret'] || req.query.secret;
  if (token !== process.env.WP_WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const { event = 'new_lead', email, first_name, last_name, name, phone, country, service_interest, message } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  let firstName = first_name;
  let lastName  = last_name;
  if (!firstName && name) { const p = name.trim().split(' '); firstName = p[0]; lastName = p.slice(1).join(' ') || ''; }

  try {
    const { rows } = await query(`
      INSERT INTO clientes (nombre, apellido, email, telefono, pais, origen)
      VALUES ($1,$2,$3,$4,$5,'wordpress')
      ON CONFLICT (email) DO UPDATE SET telefono = COALESCE(clientes.telefono, EXCLUDED.telefono)
      RETURNING id
    `, [firstName||'Sin', lastName||'Nombre', email.toLowerCase(), phone||null, country||null]);

    const clienteId = rows[0].id;
    if (phone) {
      await query(`INSERT INTO contactos (telefono,nombre,email,cliente_id) VALUES ($1,$2,$3,$4) ON CONFLICT (telefono) DO UPDATE SET cliente_id=EXCLUDED.cliente_id`,
        [phone, `${firstName} ${lastName}`.trim(), email, clienteId]);
    }
    if (service_interest) {
      const tipoMap = { llc:'llc_formation', llc_formation:'llc_formation', tax:'tax_filing', tax_filing:'tax_filing', registered_agent:'registered_agent', ein:'ein_application', bookkeeping:'bookkeeping' };
      const tipo = tipoMap[service_interest.toLowerCase()] || 'otro';
      await query(`INSERT INTO servicios (cliente_id,tipo,nombre) VALUES ($1,$2,$3)`,
        [clienteId, tipo, `${tipo.replace('_',' ')} — ${firstName}`]);
    }
    res.status(201).json({ received: true, clienteId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PORTAL DEL CLIENTE ────────────────────────────────────────────────────────
router.get ('/portal/perfil',          authenticate, soloCliente, clientesCtrl.portalPerfil);
router.get ('/portal/servicios',       authenticate, soloCliente, clientesCtrl.portalServicios);
router.get ('/portal/pagos',           authenticate, soloCliente, clientesCtrl.portalPagos);
router.get ('/portal/archivos',        authenticate, soloCliente, clientesCtrl.portalArchivos);
router.get ('/portal/solicitudes',     authenticate, soloCliente, clientesCtrl.portalSolicitudes);
router.get ('/portal/notificaciones',  authenticate, soloCliente, clientesCtrl.portalNotificaciones);
router.put ('/portal/cambiar-password',authenticate, soloCliente, authCtrl.cambiarPassword);
router.get ('/portal/citas',           authenticate, soloCliente, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT c.id, c.titulo, c.fecha_inicio, c.fecha_fin, c.estado, c.tipo, c.notas, c.color,
             a.nombre AS agente_nombre,
             s.nombre AS servicio_nombre, s.duracion_minutos
      FROM citas c
      LEFT JOIN agentes a         ON a.id = c.agente_id
      LEFT JOIN agenda_servicios s ON s.id = c.servicio_id
      WHERE c.cliente_id = $1
        AND c.fecha_inicio >= NOW() - INTERVAL '30 days'
      ORDER BY c.fecha_inicio ASC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── PORTAL: SUBIR ARCHIVO PARA UNA SOLICITUD ──────────────────────────────────
router.post('/portal/solicitudes/:id/subir', authenticate, soloCliente, ...(() => {
  const multer = require('multer');
  const path   = require('path');
  const { v4: uuidv4 } = require('uuid');
  const storageService = require('../services/storageService');
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
  });
  return [
    upload.single('archivo'),
    async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ message: 'Archivo requerido' });
        const clienteId = req.user.id;
        const solicitudId = req.params.id;

        // Verificar que la solicitud pertenece al cliente
        const { rows: sol } = await query(
          `SELECT * FROM solicitudes_archivos WHERE id = $1 AND cliente_id = $2`,
          [solicitudId, clienteId]
        );
        if (!sol.length) return res.status(404).json({ message: 'Solicitud no encontrada' });

        const ext   = path.extname(req.file.originalname).replace('.', '');
        const fname = `${uuidv4()}.${ext}`;
        const url   = await storageService.upload({
          buffer: req.file.buffer,
          filename: fname,
          mimeType: req.file.mimetype,
          folder: `clientes/${clienteId}/solicitudes`,
        });

        // Guardar archivo en BD
        logger.info(`Portal upload: guardando en BD para cliente ${clienteId}, solicitud ${solicitudId}`);
        const { rows: archivoRows } = await query(`
          INSERT INTO archivos (cliente_id, nombre_original, nombre_almacenado, tipo_mime, extension, tamanio_bytes, url_almacenamiento, tipo_documento, origen)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual') RETURNING *
        `, [clienteId, req.file.originalname, fname, req.file.mimetype, ext, req.file.size, url, sol[0].titulo]);

        logger.info(`Portal upload: archivo guardado con id ${archivoRows[0].id}`);

        // Vincular a la solicitud y marcar como recibido
        await query(`
          UPDATE solicitudes_archivos SET archivo_id = $1, estado = 'recibido' WHERE id = $2
        `, [archivoRows[0].id, solicitudId]);

        logger.info(`Portal upload: solicitud ${solicitudId} marcada como recibida`);

        // Registrar actividad
        await query(`INSERT INTO actividad (cliente_id, accion, detalles) VALUES ($1,$2,$3)`,
          [clienteId, 'archivo.subido_portal', JSON.stringify({ nombre: req.file.originalname, solicitud: sol[0].titulo })]);

        // Emitir notificación en tiempo real al panel del agente
        const io = req.app.get('io');
        if (io) {
          // FIX: alias corregido de "a" a "ag" para la tabla agentes
          const { rows: cInfo } = await query(`
            SELECT c.nombre, c.apellido, c.agente_id
            FROM clientes c
            LEFT JOIN agentes ag ON c.agente_id = ag.id
            WHERE c.id = $1
          `, [clienteId]);

          const cliente = cInfo[0];
          const payload = {
            tipo:             'archivo_portal',
            cliente_id:       clienteId,
            cliente_nombre:   cliente ? `${cliente.nombre} ${cliente.apellido||''}`.trim() : 'Cliente',
            archivo_id:       archivoRows[0].id,
            archivo_nombre:   req.file.originalname,
            solicitud_titulo: sol[0].titulo,
            timestamp:        new Date().toISOString(),
          };
          io.emit('archivo_portal', payload);
          if (cliente?.agente_id) {
            io.to(`agent_${cliente.agente_id}`).emit('archivo_portal', payload);
          }
        }

        res.status(201).json({ success: true, archivo: archivoRows[0] });
      } catch (err) {
        logger.error('portalSubirArchivo:', err.message || err.detail || err.code || JSON.stringify(err));
        res.status(500).json({ message: err.message || err.detail || 'Error interno' });
      }
    }
  ];
})());

// ══════════════════════════════════════════════════════════════════════════════
// NUEVAS RUTAS v2
// ══════════════════════════════════════════════════════════════════════════════
const chatbotCtrl  = require('../controllers/chatbotController');
const campanaCtrl  = require('../controllers/campanaController');
const reportesCtrl = require('../controllers/reportesController');
const integCtrl    = require('../controllers/integracionController');

// ── MÚLTIPLES NÚMEROS WHATSAPP ─────────────────────────────────────────────────
router.get   ('/numeros',      authenticate, soloAdmin, integCtrl.listarNumeros);
router.post  ('/numeros',      authenticate, soloAdmin, integCtrl.crearNumero);
router.put   ('/numeros/:id',  authenticate, soloAdmin, integCtrl.actualizarNumero);
router.delete('/numeros/:id',  authenticate, soloAdmin, integCtrl.eliminarNumero);

// ── REGLAS DE ENRUTAMIENTO ─────────────────────────────────────────────────────
router.get   ('/reglas-enrutamiento',      authenticate, soloAdmin, integCtrl.listarReglas);
router.post  ('/reglas-enrutamiento',      authenticate, soloAdmin, integCtrl.crearRegla);
router.put   ('/reglas-enrutamiento/:id',  authenticate, soloAdmin, integCtrl.actualizarRegla);
router.delete('/reglas-enrutamiento/:id',  authenticate, soloAdmin, integCtrl.eliminarRegla);

// ── CHATBOTS ───────────────────────────────────────────────────────────────────
router.get   ('/chatbots',                           authenticate, soloAgente, chatbotCtrl.listarChatbots);
router.post  ('/chatbots',                           authenticate, soloAgente, chatbotCtrl.crearChatbot);
router.get   ('/chatbots/:id',                       authenticate, soloAgente, chatbotCtrl.obtenerChatbot);
router.put   ('/chatbots/:id',                       authenticate, soloAgente, chatbotCtrl.actualizarChatbot);
router.delete('/chatbots/:id',                       authenticate, soloAgente, chatbotCtrl.eliminarChatbot);
// Nodos
router.get   ('/chatbots/:chatbot_id/nodos',                    authenticate, soloAgente, chatbotCtrl.listarNodos);
router.post  ('/chatbots/:chatbot_id/nodos',                    authenticate, soloAgente, chatbotCtrl.crearNodo);
router.put   ('/chatbots/:chatbot_id/nodos/:nodo_id',           authenticate, soloAgente, chatbotCtrl.actualizarNodo);
router.delete('/chatbots/:chatbot_id/nodos/:nodo_id',           authenticate, soloAgente, chatbotCtrl.eliminarNodo);
// Conexiones
router.post  ('/chatbots/:chatbot_id/conexiones',               authenticate, soloAgente, chatbotCtrl.crearConexion);
router.put   ('/chatbots/:chatbot_id/conexiones/:conexion_id',  authenticate, soloAgente, chatbotCtrl.actualizarConexion);
router.delete('/chatbots/:chatbot_id/conexiones/:conexion_id',  authenticate, soloAgente, chatbotCtrl.eliminarConexion);
// Sesiones
router.get   ('/chatbots/:chatbot_id/sesiones',                 authenticate, soloAgente, chatbotCtrl.listarSesiones);

// ── BASE DE CONOCIMIENTO (IA) ──────────────────────────────────────────────────
router.get   ('/base-conocimiento',      authenticate, soloAgente, chatbotCtrl.listarBaseConocimiento);
router.post  ('/base-conocimiento',      authenticate, soloAgente, chatbotCtrl.crearEntradaBC);
router.put   ('/base-conocimiento/:id',  authenticate, soloAgente, chatbotCtrl.actualizarEntradaBC);
router.delete('/base-conocimiento/:id',  authenticate, soloAgente, chatbotCtrl.eliminarEntradaBC);

// ── CAMPAÑAS ───────────────────────────────────────────────────────────────────
router.get   ('/campanas',                              authenticate, soloAgente, campanaCtrl.listar);
router.post  ('/campanas',                              authenticate, soloAgente, campanaCtrl.crear);
router.get   ('/campanas/:id',                          authenticate, soloAgente, campanaCtrl.obtener);
router.post  ('/campanas/:id/enviar',                   authenticate, soloAgente, campanaCtrl.enviar);
router.post  ('/campanas/:id/pausar',                   authenticate, soloAdmin,  campanaCtrl.pausar);
router.post  ('/campanas/:id/cancelar',                 authenticate, soloAdmin,  campanaCtrl.cancelar);
router.delete('/campanas/:id',                          authenticate, soloAdmin,  campanaCtrl.eliminar);
router.put   ('/campanas/:id/destinatarios',            authenticate, soloAgente, campanaCtrl.actualizarDestinatarios);
router.post  ('/campanas/:campana_id/agregar-contactos', authenticate, soloAgente, campanaCtrl.agregarDesdeContactos);

// ── PLANTILLAS DE MENSAJES ─────────────────────────────────────────────────────
router.get   ('/plantillas',      authenticate, soloAgente, integCtrl.listarPlantillas);
router.post  ('/plantillas',      authenticate, soloAgente, integCtrl.crearPlantilla);
router.put   ('/plantillas/:id',  authenticate, soloAgente, integCtrl.actualizarPlantilla);
router.delete('/plantillas/:id',  authenticate, soloAgente, integCtrl.eliminarPlantilla);

// ── SECUENCIAS ─────────────────────────────────────────────────────────────────
router.get   ('/secuencias',                      authenticate, soloAgente, integCtrl.listarSecuencias);
router.post  ('/secuencias',                      authenticate, soloAgente, integCtrl.crearSecuencia);
router.get   ('/secuencias/:id',                  authenticate, soloAgente, integCtrl.obtenerSecuencia);
router.put   ('/secuencias/:id',                  authenticate, soloAgente, integCtrl.actualizarSecuencia);
router.post  ('/secuencias/:id/suscribir',        authenticate, soloAgente, integCtrl.suscribirContacto);

// ── REPORTES Y ANALÍTICA ───────────────────────────────────────────────────────
router.get('/reportes/resumen',       authenticate, soloAgente, reportesCtrl.resumenAvanzado);
router.get('/reportes/agentes',       authenticate, soloAgente, reportesCtrl.rendimientoAgentes);
router.get('/reportes/campanas',      authenticate, soloAgente, reportesCtrl.reporteCampanas);
router.get('/reportes/chatbots',      authenticate, soloAgente, reportesCtrl.reporteChatbots);
router.get('/reportes/exportar',      authenticate, soloAgente, reportesCtrl.exportarConversaciones);

// ── WEBHOOKS SALIENTES ─────────────────────────────────────────────────────────
router.get   ('/webhooks-salientes',           authenticate, soloAdmin, integCtrl.listarWebhooks);
router.post  ('/webhooks-salientes',           authenticate, soloAdmin, integCtrl.crearWebhook);
router.put   ('/webhooks-salientes/:id',       authenticate, soloAdmin, integCtrl.actualizarWebhook);
router.delete('/webhooks-salientes/:id',       authenticate, soloAdmin, integCtrl.eliminarWebhook);
router.get   ('/webhooks-salientes/:id/logs',  authenticate, soloAdmin, integCtrl.logsWebhook);
router.post  ('/webhooks-salientes/:id/probar',authenticate, soloAdmin, integCtrl.probarWebhook);

// ── INTEGRACIONES EXTERNAS ─────────────────────────────────────────────────────
router.get ('/integraciones',         authenticate, soloAdmin, integCtrl.listarIntegraciones);
router.post('/integraciones',         authenticate, soloAdmin, integCtrl.upsertIntegracion);
router.post('/integraciones/:id/toggle', authenticate, soloAdmin, integCtrl.toggleIntegracion);

// ── WIDGET WEB ─────────────────────────────────────────────────────────────────
router.get   ('/widgets',               authenticate, soloAdmin, integCtrl.listarWidgets);
router.post  ('/widgets',               authenticate, soloAdmin, integCtrl.crearWidget);
router.put   ('/widgets/:id',           authenticate, soloAdmin, integCtrl.actualizarWidget);
router.delete('/widgets/:id',           authenticate, soloAdmin, integCtrl.eliminarWidget);
router.get   ('/widgets/:id/snippet',   authenticate, soloAdmin, integCtrl.widgetSnippet);
// Endpoint público para registrar clic en widget
router.post('/widget/:id/clic', async (req, res) => {
  await query(`UPDATE widgets SET clics=clics+1 WHERE id=$1`, [req.params.id]).catch(() => {});
  const { rows } = await query(`SELECT * FROM widgets WHERE id=$1 AND activo=TRUE`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ message: 'Widget no encontrado' });
  res.json({ telefono: rows[0].telefono, mensaje: rows[0].mensaje_bienvenida, color: rows[0].color_primario });
});

// ── IA CONFIGURACIÓN ───────────────────────────────────────────────────────────
router.get ('/ia/config',  authenticate, soloAdmin, integCtrl.obtenerConfigIA);
router.post('/ia/config',  authenticate, soloAdmin, integCtrl.upsertConfigIA);

// ── IA: DETECCIÓN DE INTENCIÓN / RESPUESTA ─────────────────────────────────────
router.post('/ia/detectar-intencion', authenticate, soloAgente, async (req, res) => {
  try {
    const { texto } = req.body;
    const aiService = require('../services/aiService');
    const resultado = await aiService.detectarIntencion(texto);
    res.json(resultado || { intencion: 'no_disponible', confianza: 0 });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/ia/traducir', authenticate, soloAgente, async (req, res) => {
  try {
    const { texto, idioma } = req.body;
    const aiService = require('../services/aiService');
    const traducido = await aiService.traducir(texto, idioma || 'es');
    res.json({ original: texto, traducido, idioma });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/ia/respuesta', authenticate, soloAgente, async (req, res) => {
  try {
    const { pregunta, contexto } = req.body;
    const aiService = require('../services/aiService');
    const respuesta = await aiService.generarRespuesta(pregunta, contexto);
    res.json({ respuesta: respuesta || null, disponible: !!respuesta });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── ETIQUETAS ──────────────────────────────────────────────────────────────────
router.get   ('/etiquetas',      authenticate, soloAgente, integCtrl.listarEtiquetas);
router.post  ('/etiquetas',      authenticate, soloAgente, integCtrl.crearEtiqueta);
router.delete('/etiquetas/:id',  authenticate, soloAdmin,  integCtrl.eliminarEtiqueta);

// ── TIMELINE DEL CONTACTO (WhatsApp) ──────────────────────────────────────────
router.get('/contactos/:id/timeline', authenticate, soloAgente, async (req, res) => {
  try {
    const { rows: mensajes } = await query(`
      SELECT m.*, c.numero_caso
      FROM mensajes m
      JOIN conversaciones c ON m.conversacion_id=c.id
      JOIN contactos co ON c.contacto_id=co.id
      WHERE co.id=$1
      ORDER BY m.created_at DESC LIMIT 100
    `, [req.params.id]);
    const { rows: sesiones } = await query(`
      SELECT s.*, b.nombre AS chatbot_nombre
      FROM chatbot_sesiones s
      JOIN chatbots b ON s.chatbot_id=b.id
      WHERE s.contacto_id=$1
      ORDER BY s.created_at DESC LIMIT 20
    `, [req.params.id]);
    const { rows: suscripciones } = await query(`
      SELECT ss.*, s.nombre AS secuencia_nombre
      FROM secuencia_suscripciones ss
      JOIN secuencias s ON ss.secuencia_id=s.id
      WHERE ss.contacto_id=$1
      ORDER BY ss.created_at DESC LIMIT 20
    `, [req.params.id]);
    res.json({ mensajes, sesiones, suscripciones });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── INTEGRACIÓN GOOGLE SHEETS: exportar contactos ─────────────────────────────
router.post('/integraciones/google-sheets/sync-contactos', authenticate, soloAdmin, async (req, res) => {
  try {
    const { rows: integ } = await query(`SELECT * FROM integraciones WHERE tipo='google_sheets' AND activa=TRUE LIMIT 1`);
    if (!integ.length) return res.status(400).json({ message: 'Integración Google Sheets no configurada o inactiva' });

    const config = integ[0].configuracion;
    const { rows: contactos } = await query(`
      SELECT c.telefono, c.nombre, c.email, c.empresa, c.etiquetas, c.ultimo_mensaje,
             cl.nombre||' '||COALESCE(cl.apellido,'') AS cliente_nombre
      FROM contactos c LEFT JOIN clientes cl ON c.cliente_id=cl.id
      ORDER BY c.ultimo_mensaje DESC LIMIT 10000
    `);

    // Formato para Google Sheets API (requiere webhook URL de Apps Script o similar)
    if (config.webhook_url) {
      const axios = require('axios');
      await axios.post(config.webhook_url, { contactos }, { timeout: 30000 });
      await query(`UPDATE integraciones SET ultimo_sync=NOW() WHERE id=$1`, [integ[0].id]);
      res.json({ success: true, sincronizados: contactos.length });
    } else {
      res.json({ success: true, datos: contactos, mensaje: 'Configura un webhook_url de Google Apps Script para sincronizar' });
    }
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── INTEGRACIÓN SHOPIFY: recibir eventos ──────────────────────────────────────
router.post('/integraciones/shopify/webhook', async (req, res) => {
  try {
    const topic = req.headers['x-shopify-topic'];
    const shopDomain = req.headers['x-shopify-shop-domain'];

    const { rows: integ } = await query(`SELECT * FROM integraciones WHERE tipo='shopify' AND activa=TRUE LIMIT 1`);
    if (!integ.length) return res.status(200).json({ ignored: true });

    const data = req.body;
    const { despacharEvento } = require('../services/webhookSalienteService');

    if (topic === 'orders/create') {
      const telefono = data.shipping_address?.phone || data.billing_address?.phone;
      const nombre   = `${data.customer?.first_name || ''} ${data.customer?.last_name || ''}`.trim();
      const email    = data.customer?.email;

      if (telefono) {
        const tel = telefono.replace(/\D/g, '');
        await query(`
          INSERT INTO contactos (telefono, nombre, email) VALUES ($1,$2,$3)
          ON CONFLICT (telefono) DO UPDATE SET nombre=COALESCE(contactos.nombre,$2)
        `, [tel, nombre, email]).catch(() => {});
      }

      await despacharEvento('shopify.pedido_creado', {
        pedido_id: data.id, total: data.total_price, cliente: nombre, email,
      });
    } else if (topic === 'customers/create') {
      await despacharEvento('shopify.cliente_creado', {
        cliente_id: data.id, nombre: `${data.first_name} ${data.last_name}`, email: data.email,
      });
    }

    res.status(200).json({ received: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── INTEGRACIÓN WOOCOMMERCE: recibir eventos ───────────────────────────────────
router.post('/integraciones/woocommerce/webhook', async (req, res) => {
  try {
    const topic = req.headers['x-wc-webhook-topic'];
    const { rows: integ } = await query(`SELECT * FROM integraciones WHERE tipo='woocommerce' AND activa=TRUE LIMIT 1`);
    if (!integ.length) return res.status(200).json({ ignored: true });

    const data = req.body;
    const { despacharEvento } = require('../services/webhookSalienteService');

    if (topic === 'order.created') {
      const telefono = data.billing?.phone;
      const nombre   = `${data.billing?.first_name || ''} ${data.billing?.last_name || ''}`.trim();
      const email    = data.billing?.email;

      if (telefono) {
        await query(`
          INSERT INTO contactos (telefono, nombre, email) VALUES ($1,$2,$3)
          ON CONFLICT (telefono) DO UPDATE SET nombre=COALESCE(contactos.nombre,$2)
        `, [telefono.replace(/\D/g,''), nombre, email]).catch(() => {});
      }

      await despacharEvento('woocommerce.pedido_creado', {
        pedido_id: data.id, total: data.total, cliente: nombre, email,
      });
    }

    res.status(200).json({ received: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── HEALTH CHECK EXTENDIDO ─────────────────────────────────────────────────────
router.get('/system/status', authenticate, soloAdmin, async (req, res) => {
  try {
    const { rows: db } = await query(`SELECT NOW() AS time, version() AS pg_version`);
    const { rows: stats } = await query(`
      SELECT
        (SELECT COUNT(*) FROM clientes WHERE estado='activo') AS clientes,
        (SELECT COUNT(*) FROM contactos) AS contactos,
        (SELECT COUNT(*) FROM conversaciones WHERE estado IN ('abierto','en_proceso')) AS conversaciones_abiertas,
        (SELECT COUNT(*) FROM chatbots WHERE activo=TRUE) AS chatbots_activos,
        (SELECT COUNT(*) FROM chatbot_sesiones WHERE estado='activo') AS sesiones_chatbot,
        (SELECT COUNT(*) FROM campanas WHERE estado='enviando') AS campanas_activas,
        (SELECT COUNT(*) FROM secuencia_suscripciones WHERE estado='activo') AS suscripciones_activas
    `);
    res.json({
      status: 'ok',
      db: { time: db[0].time, version: db[0].pg_version.split(' ').slice(0,2).join(' ') },
      stats: stats[0],
      uptime_seconds: Math.floor(process.uptime()),
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

// ── AGENDA / CITAS ────────────────────────────────────────────────────────────
const citasCtrl = require('../controllers/citasController');

router.get ('/citas',                    authenticate, soloAgente, citasCtrl.listarCitas);
router.get ('/citas/slots',              authenticate, soloAgente, citasCtrl.obtenerSlots);
router.get ('/citas/:id',                authenticate, soloAgente, citasCtrl.obtenerCita);
router.post('/citas',                    authenticate, soloAgente, citasCtrl.crearCita);
router.put ('/citas/:id',                authenticate, soloAgente, citasCtrl.actualizarCita);
router.delete('/citas/:id',             authenticate, soloAgente, citasCtrl.eliminarCita);

router.get ('/agenda/servicios',         authenticate, soloAgente, citasCtrl.listarServicios);
router.post('/agenda/servicios',         authenticate, soloAdmin,  citasCtrl.crearServicio);
router.put ('/agenda/servicios/:id',     authenticate, soloAdmin,  citasCtrl.actualizarServicio);
router.delete('/agenda/servicios/:id',  authenticate, soloAdmin,  citasCtrl.eliminarServicio);

router.get ('/agenda/disponibilidad',    authenticate, soloAgente, citasCtrl.obtenerDisponibilidad);
router.post('/agenda/disponibilidad',    authenticate, soloAgente, citasCtrl.guardarDisponibilidad);

router.get ('/agenda/bloqueos',          authenticate, soloAgente, citasCtrl.listarBloqueos);
router.post('/agenda/bloqueos',          authenticate, soloAgente, citasCtrl.crearBloqueo);
router.delete('/agenda/bloqueos/:id',   authenticate, soloAgente, citasCtrl.eliminarBloqueo);

// ── LLAMADAS ──────────────────────────────────────────────────────────────────
router.post('/llamadas',           authenticate, soloAgente, llamadasCtrl.iniciarLlamada);
router.put ('/llamadas/:id',       authenticate, soloAgente, llamadasCtrl.actualizarLlamada);
router.get ('/llamadas',           authenticate, soloAgente, llamadasCtrl.historialLlamadas);
router.get ('/llamadas/stats',     authenticate, soloAgente, llamadasCtrl.estadisticasLlamadas);

// ── NOTIFICAR LLAMADA POR WHATSAPP ────────────────────────────────────────────
router.post('/llamadas/notificar-contacto', authenticate, soloAgente, async (req, res) => {
  try {
    const { telefono, conversacion_id, agente_nombre } = req.body;
    if (!telefono) return res.status(400).json({ message: 'telefono requerido' });
    const waService = require('../services/whatsappService');
    const mensaje = `📞 Hola, soy *${agente_nombre || 'tu agente'}* de IG Accounting Services.\n\nTe estoy contactando para hablar contigo. Por favor responde este mensaje cuando estés disponible o llámame de vuelta.`;
    await waService.enviarTexto(telefono.replace(/\D/g,''), mensaje, conversacion_id || null, req.user.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// ── AMELIA INTEGRATION ────────────────────────────────────────────────────────

// Webhook público que Amelia llama (sin auth — verificar token secreto)
router.post('/amelia/webhook', async (req, res) => {
  try {
    const secret = req.headers['x-amelia-secret'] || req.query.secret;
    const { rows: cfg } = await query(
      `SELECT configuracion FROM integraciones WHERE tipo='amelia' AND activa=true LIMIT 1`
    );
    if (!cfg.length) return res.status(400).json({ message: 'Amelia no configurada' });

    const webhookSecret = cfg[0].configuracion?.webhook_secret;
    if (webhookSecret && secret !== webhookSecret) {
      return res.status(401).json({ message: 'Token inválido' });
    }

    const event   = req.headers['x-amelia-event'] || req.body.action || 'bookingAdded';
    const payload = req.body;

    const result = await ameliaService.procesarWebhook(event, payload, null);
    res.json(result);
  } catch (err) {
    logger.error('Amelia webhook:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// Rutas admin para Amelia
router.get('/amelia/servicios', authenticate, soloAdmin, async (req, res) => {
  try {
    const data = await ameliaService.listarServiciosAmelia();
    res.json(data);
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.post('/amelia/sync-cita/:id', authenticate, soloAdmin, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT c.*, cl.nombre AS cliente_nombre, cl.apellido AS cliente_apellido,
             cl.email AS cliente_email, cl.telefono AS cliente_telefono
      FROM citas c LEFT JOIN clientes cl ON cl.id=c.cliente_id
      WHERE c.id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Cita no encontrada' });
    const cita = rows[0];
    if (cita.amelia_appointment_id) {
      await ameliaService.actualizarEnAmelia(cita);
    } else {
      await ameliaService.crearEnAmelia(cita);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

// Guardar/actualizar config de Amelia + mapeos
router.post('/amelia/config', authenticate, soloAdmin, async (req, res) => {
  try {
    const { wp_url, api_key, webhook_secret, employee_map, service_map, activa } = req.body;
    const config = { wp_url, api_key, webhook_secret: webhook_secret||'', employee_map: employee_map||{}, service_map: service_map||{} };
    const { rows } = await query(
      `INSERT INTO integraciones (tipo, nombre, configuracion, activa)
       VALUES ('amelia','Amelia Booking',$1,$2)
       ON CONFLICT (tipo) DO UPDATE SET configuracion=$1, activa=$2, updated_at=NOW()
       RETURNING *`,
      [JSON.stringify(config), activa !== false]
    );
    res.json({ success: true, integracion: rows[0] });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

router.get('/amelia/config', authenticate, soloAdmin, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, activa, configuracion FROM integraciones WHERE tipo='amelia' LIMIT 1`
    );
    if (!rows.length) return res.json({ activa: false, configuracion: {} });
    // Ocultar api_key parcialmente
    const cfg = { ...rows[0].configuracion };
    if (cfg.api_key) cfg.api_key_masked = cfg.api_key.substring(0,6) + '••••••';
    delete cfg.api_key;
    res.json({ id: rows[0].id, activa: rows[0].activa, configuracion: cfg });
  } catch (err) { res.status(500).json({ message: err.message }); }
});

module.exports = router;
