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
const { procesarRecordatorios } = require('../services/cronService');
const { query }    = require('../models/db');
const bcrypt       = require('bcryptjs');

// ── AUTH ───────────────────────────────────────────────────────────────────────
router.post('/auth/login',              authCtrl.loginAgente);
router.post('/auth/cliente/login',      authCtrl.loginCliente);
router.get ('/auth/perfil',             authenticate, authCtrl.perfil);
router.put ('/auth/cambiar-password',   authenticate, authCtrl.cambiarPassword);

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
        notas = COALESCE(notas, '') || $1
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
    await query(`UPDATE conversaciones SET cliente_id = $1 WHERE contacto_id = $2`, [cliente.id, contactoId]);

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
  const { rows } = await query(`SELECT * FROM notificaciones WHERE agente_id IS NULL ORDER BY created_at DESC LIMIT 50`);
  res.json(rows);
});
router.put('/notificaciones/:id/leer', authenticate, async (req, res) => {
  await query(`UPDATE notificaciones SET leida=TRUE WHERE id=$1`, [req.params.id]);
  res.json({ success: true });
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────
router.post('/admin/run-reminders', authenticate, soloAdmin, async (req, res) => {
  await procesarRecordatorios();
  res.json({ success: true, message: 'Recordatorios procesados' });
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

module.exports = router;