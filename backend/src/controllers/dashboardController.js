// src/controllers/dashboardController.js
const { query } = require('../models/db');

async function resumen(req, res) {
  try {
    const hoy    = new Date();
    const ini30  = new Date(hoy); ini30.setDate(ini30.getDate() + 30);
    const mesIni = new Date(hoy.getFullYear(), hoy.getMonth(), 1);

    const [clientes, servicios, pagos, archivos, conversaciones, sinClasificar, mensajesHoy, proximosPagos, citasHoy, mensajes7dias] =
      await Promise.all([
        query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE created_at >= $1) AS nuevos_mes FROM clientes WHERE estado='activo'`, [mesIni]),
        query(`SELECT COUNT(*) AS activos FROM servicios WHERE estado IN ('pendiente','en_proceso','esperando_cliente')`),
        query(`SELECT COUNT(*) AS pendientes, COALESCE(SUM(monto),0) AS total_pendiente FROM pagos WHERE estado IN ('pendiente','enviado')`),
        query(`SELECT COUNT(*) AS total FROM archivos`),
        query(`SELECT COUNT(*) AS abiertas FROM conversaciones WHERE estado IN ('abierto','en_proceso')`),
        query(`SELECT COUNT(*) AS total FROM archivos WHERE tipo_documento IS NULL`),
        query(`SELECT COUNT(*) AS total FROM mensajes WHERE created_at >= CURRENT_DATE AND direccion='entrante'`),
        query(`SELECT p.*, c.nombre||' '||COALESCE(c.apellido,'') AS cliente_nombre, c.telefono, s.nombre AS servicio_nombre
               FROM pagos p JOIN clientes c ON p.cliente_id=c.id LEFT JOIN servicios s ON p.servicio_id=s.id
               WHERE p.estado IN ('pendiente','enviado') AND p.fecha_vencimiento <= $1
               ORDER BY p.fecha_vencimiento ASC LIMIT 5`, [ini30]),
        query(`SELECT COUNT(*) AS hoy, COUNT(*) FILTER (WHERE fecha_inicio >= NOW()) AS proximas
               FROM citas WHERE fecha_inicio::date = CURRENT_DATE AND estado NOT IN ('cancelada')`),
        query(`SELECT DATE_TRUNC('day', created_at) AS dia, COUNT(*) AS total
               FROM mensajes WHERE created_at >= NOW() - INTERVAL '7 days' AND direccion='entrante'
               GROUP BY dia ORDER BY dia ASC`),
      ]);

    // Mensajes por día últimos 7 días (rellenar días sin datos con 0)
    const diasSemana = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(hoy); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
      const row = mensajes7dias.rows.find(r => new Date(r.dia).toDateString() === d.toDateString());
      diasSemana.push({ fecha: d, total: row ? parseInt(row.total) : 0 });
    }

    res.json({
      clientes: {
        total:    parseInt(clientes.rows[0].total),
        nuevos_mes: parseInt(clientes.rows[0].nuevos_mes),
      },
      servicios_activos: parseInt(servicios.rows[0].activos),
      pagos: {
        pendientes:    parseInt(pagos.rows[0].pendientes),
        total_pendiente: parseFloat(pagos.rows[0].total_pendiente),
      },
      archivos_total:       parseInt(archivos.rows[0].total),
      archivos_sin_clasificar: parseInt(sinClasificar.rows[0].total),
      conversaciones_abiertas: parseInt(conversaciones.rows[0].abiertas),
      mensajes_hoy:         parseInt(mensajesHoy.rows[0].total),
      citas_hoy:            parseInt(citasHoy.rows[0].hoy),
      citas_proximas:       parseInt(citasHoy.rows[0].proximas),
      proximos_pagos:       proximosPagos.rows,
      mensajes_7dias:       diasSemana,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

module.exports = { resumen };

// ── conversacionesController.js (inline para mantener archivos compactos) ──────
const { query: q2 } = require('../models/db');
const waService = require('../services/whatsappService');

const conv = {
  async listar(req, res) {
    try {
      const { estado, buscar, page = 1, limit = 20 } = req.query;
      const offset = (parseInt(page) - 1) * parseInt(limit);
      const params = []; const conds = [];
      if (estado) { params.push(estado); conds.push(`c.estado=$${params.length}`); }
      if (buscar) { params.push(`%${buscar}%`); conds.push(`(co.nombre ILIKE $${params.length} OR co.telefono ILIKE $${params.length})`); }
      const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

      const { rows } = await q2(`
        SELECT c.*, co.telefono, co.nombre AS contacto_nombre, co.cliente_id,
               cl.nombre||' '||COALESCE(cl.apellido,'') AS cliente_nombre,
               a.nombre AS agente_nombre
        FROM conversaciones c
        JOIN contactos co ON c.contacto_id = co.id
        LEFT JOIN clientes cl ON co.cliente_id = cl.id
        LEFT JOIN agentes a ON c.agente_id = a.id
        ${where} ORDER BY c.ultima_actividad DESC LIMIT $${params.length+1} OFFSET $${params.length+2}
      `, [...params, parseInt(limit), offset]);
      res.json(rows);
    } catch (err) { res.status(500).json({ message: err.message }); }
  },

  async obtener(req, res) {
    try {
      const { rows: convRows } = await q2(`
        SELECT c.*, co.telefono, co.nombre AS contacto_nombre, co.cliente_id, co.id AS contacto_id
        FROM conversaciones c JOIN contactos co ON c.contacto_id=co.id WHERE c.id=$1
      `, [req.params.id]);
      if (!convRows.length) return res.status(404).json({ message: 'No encontrada' });

      const { rows: mensajes } = await q2(
        `SELECT m.*, a.id AS archivo_id, a.nombre_original AS archivo_nombre
         FROM mensajes m
         LEFT JOIN archivos a ON a.mensaje_id = m.id
         WHERE m.conversacion_id=$1 ORDER BY m.created_at ASC`, [req.params.id]
      );
      const { rows: archivos } = await q2(
        `SELECT * FROM archivos WHERE conversacion_id=$1 ORDER BY created_at DESC`, [req.params.id]
      );

      await q2(`UPDATE conversaciones SET mensajes_sin_leer=0 WHERE id=$1`, [req.params.id]);
      res.json({ ...convRows[0], mensajes, archivos });
    } catch (err) { res.status(500).json({ message: err.message }); }
  },

  async enviarMensaje(req, res) {
    try {
      const { texto } = req.body;
      if (!texto?.trim()) return res.status(400).json({ message: 'Texto requerido' });

      const { rows: cRows } = await q2(
        `SELECT c.*, co.telefono FROM conversaciones c JOIN contactos co ON c.contacto_id=co.id WHERE c.id=$1`,
        [req.params.id]
      );
      if (!cRows.length) return res.status(404).json({ message: 'Conversación no encontrada' });

      const result = await waService.enviarTexto(
        cRows[0].telefono.replace(/\D/g,''), texto, req.params.id, req.user.id
      );

      const io = req.app.get('io');
      if (io) io.emit('nuevo_mensaje', { conversacion_id: req.params.id, direccion: 'saliente', contenido: texto });

      res.json({ success: true, messageId: result.messageId });
    } catch (err) { res.status(500).json({ message: err.message }); }
  },

  async cambiarEstado(req, res) {
    try {
      const { estado } = req.body;
      const { rows } = await q2(
        `UPDATE conversaciones SET estado=$1 WHERE id=$2 RETURNING *`, [estado, req.params.id]
      );
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ message: err.message }); }
  },

  async asignarAgente(req, res) {
    try {
      const { agente_id } = req.body;
      const { rows } = await q2(
        `UPDATE conversaciones SET agente_id=$1 WHERE id=$2 RETURNING *`, [agente_id, req.params.id]
      );
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ message: err.message }); }
  },
};

module.exports.conv = conv;