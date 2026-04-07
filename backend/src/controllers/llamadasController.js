// src/controllers/llamadasController.js — Gestión de llamadas en el CRM
const { query } = require('../models/db');
const logger    = require('../utils/logger');

// ── POST /api/llamadas — Registrar inicio de llamada ─────────────────────────
async function iniciarLlamada(req, res) {
  const { conversacion_id, contacto_id, numero_destino, tipo = 'saliente' } = req.body;
  if (!numero_destino) return res.status(400).json({ message: 'numero_destino es requerido' });

  try {
    const { rows } = await query(`
      INSERT INTO llamadas (conversacion_id, contacto_id, agente_id, tipo, estado, numero_destino)
      VALUES ($1, $2, $3, $4, 'iniciada', $5)
      RETURNING *
    `, [conversacion_id || null, contacto_id || null, req.user.id, tipo, numero_destino]);

    const llamada = rows[0];

    // Registrar en actividad si hay conversación
    if (conversacion_id) {
      const { rows: conv } = await query(`
        SELECT ct.cliente_id FROM conversaciones c
        JOIN contactos ct ON ct.id = c.contacto_id
        WHERE c.id=$1
      `, [conversacion_id]);
      if (conv.length && conv[0].cliente_id) {
        await query(
          `INSERT INTO actividad (agente_id, cliente_id, accion, detalles) VALUES ($1,$2,'llamada.iniciada',$3)`,
          [req.user.id, conv[0].cliente_id, JSON.stringify({ llamada_id: llamada.id, numero: numero_destino })]
        );
      }
    }

    logger.info(`Llamada iniciada: ${llamada.id} → ${numero_destino} por agente ${req.user.id}`);
    res.status(201).json(llamada);
  } catch (err) {
    logger.error('iniciarLlamada:', err.message);
    res.status(500).json({ message: err.message });
  }
}

// ── PUT /api/llamadas/:id — Actualizar estado de llamada ──────────────────────
async function actualizarLlamada(req, res) {
  const { id } = req.params;
  const { estado, duracion_segundos, notas } = req.body;

  try {
    const campos = [];
    const vals   = [];
    let   i      = 1;

    if (estado) {
      campos.push(`estado=$${i++}`);
      vals.push(estado);
      if (estado === 'respondida')   { campos.push(`answered_at=NOW()`); }
      if (['finalizada','cancelada','fallida','no_respondida','ocupado'].includes(estado)) {
        campos.push(`ended_at=NOW()`);
      }
    }
    if (duracion_segundos !== undefined) { campos.push(`duracion_segundos=$${i++}`); vals.push(duracion_segundos); }
    if (notas              !== undefined) { campos.push(`notas=$${i++}`);             vals.push(notas); }

    if (!campos.length) return res.status(400).json({ message: 'Nada que actualizar' });

    vals.push(id);
    const { rows } = await query(
      `UPDATE llamadas SET ${campos.join(',')} WHERE id=$${i} AND agente_id=$${i + 1} RETURNING *`,
      [...vals, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Llamada no encontrada' });

    // Registrar finalización en actividad
    const ll = rows[0];
    if (estado === 'finalizada' && ll.conversacion_id) {
      const { rows: conv } = await query(`
        SELECT ct.cliente_id FROM conversaciones c
        JOIN contactos ct ON ct.id = c.contacto_id
        WHERE c.id=$1
      `, [ll.conversacion_id]);
      if (conv.length && conv[0].cliente_id) {
        await query(
          `INSERT INTO actividad (agente_id, cliente_id, accion, detalles) VALUES ($1,$2,'llamada.finalizada',$3)`,
          [req.user.id, conv[0].cliente_id, JSON.stringify({
            llamada_id: ll.id,
            duracion:   duracion_segundos || 0,
            numero:     ll.numero_destino,
          })]
        );
      }
    }

    res.json(rows[0]);
  } catch (err) {
    logger.error('actualizarLlamada:', err.message);
    res.status(500).json({ message: err.message });
  }
}

// ── GET /api/llamadas — Historial ─────────────────────────────────────────────
async function historialLlamadas(req, res) {
  const { conversacion_id, contacto_id, limit = 50 } = req.query;

  try {
    const conditions = [];
    const vals       = [];
    let   i          = 1;

    if (conversacion_id) { conditions.push(`l.conversacion_id=$${i++}`); vals.push(conversacion_id); }
    else if (contacto_id){ conditions.push(`l.contacto_id=$${i++}`);     vals.push(contacto_id); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    vals.push(parseInt(limit, 10));

    const { rows } = await query(`
      SELECT l.*, ag.nombre AS agente_nombre
      FROM llamadas l
      LEFT JOIN agentes ag ON l.agente_id = ag.id
      ${where}
      ORDER BY l.created_at DESC
      LIMIT $${i}
    `, vals);

    res.json(rows);
  } catch (err) {
    logger.error('historialLlamadas:', err.message);
    res.status(500).json({ message: err.message });
  }
}

// ── GET /api/llamadas/stats — Estadísticas del agente ─────────────────────────
async function estadisticasLlamadas(req, res) {
  try {
    const { rows } = await query(`
      SELECT
        COUNT(*)                                              AS total,
        COUNT(*) FILTER (WHERE estado='finalizada')          AS completadas,
        COUNT(*) FILTER (WHERE estado='no_respondida')       AS no_respondidas,
        COUNT(*) FILTER (WHERE estado='cancelada')           AS canceladas,
        COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '24 hours') AS hoy,
        COALESCE(ROUND(AVG(duracion_segundos) FILTER (
          WHERE estado='finalizada' AND duracion_segundos > 0
        )),0)                                                AS duracion_promedio_seg
      FROM llamadas
      WHERE agente_id = $1
    `, [req.user.id]);
    res.json(rows[0]);
  } catch (err) {
    logger.error('estadisticasLlamadas:', err.message);
    res.status(500).json({ message: err.message });
  }
}

module.exports = { iniciarLlamada, actualizarLlamada, historialLlamadas, estadisticasLlamadas };
