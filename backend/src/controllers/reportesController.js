// src/controllers/reportesController.js
const { query } = require('../models/db');

// Resumen general de métricas avanzadas
const resumenAvanzado = async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const desdeFecha = desde || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const hastaFecha = hasta || new Date().toISOString().split('T')[0];

    const [
      mensajes, conversaciones, contactosNuevos,
      campanas, chatbots, tiempoRespuesta, por_dia,
      distribucion_estado, top_etiquetas,
    ] = await Promise.all([
      query(`
        SELECT
          COUNT(*) FILTER (WHERE direccion='entrante') AS entrantes,
          COUNT(*) FILTER (WHERE direccion='saliente') AS salientes,
          COUNT(*) AS total
        FROM mensajes WHERE created_at BETWEEN $1 AND $2::DATE + 1
      `, [desdeFecha, hastaFecha]),

      query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE estado='resuelto') AS resueltas,
          COUNT(*) FILTER (WHERE estado='cerrado') AS cerradas,
          COUNT(*) FILTER (WHERE estado='abierto') AS abiertas,
          COUNT(*) FILTER (WHERE estado='en_proceso') AS en_proceso
        FROM conversaciones WHERE created_at BETWEEN $1 AND $2::DATE + 1
      `, [desdeFecha, hastaFecha]),

      query(`
        SELECT COUNT(*) AS total FROM contactos
        WHERE created_at BETWEEN $1 AND $2::DATE + 1
      `, [desdeFecha, hastaFecha]),

      query(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(total_enviados),0) AS enviados,
               COALESCE(SUM(total_entregados),0) AS entregados,
               COALESCE(SUM(total_leidos),0) AS leidos
        FROM campanas WHERE created_at BETWEEN $1 AND $2::DATE + 1
      `, [desdeFecha, hastaFecha]),

      query(`
        SELECT COUNT(*) AS sesiones_total,
               COUNT(*) FILTER (WHERE estado='completado') AS completadas,
               COUNT(*) FILTER (WHERE estado='transferido') AS transferidas
        FROM chatbot_sesiones WHERE created_at BETWEEN $1 AND $2::DATE + 1
      `, [desdeFecha, hastaFecha]),

      // Tiempo promedio de respuesta (minutos)
      query(`
        SELECT ROUND(AVG(EXTRACT(EPOCH FROM (m2.created_at - m1.created_at))/60)::NUMERIC, 1) AS promedio_minutos
        FROM mensajes m1
        JOIN mensajes m2 ON m1.conversacion_id=m2.conversacion_id
          AND m1.direccion='entrante' AND m2.direccion='saliente'
          AND m2.created_at > m1.created_at
        WHERE m1.created_at BETWEEN $1 AND $2::DATE + 1
      `, [desdeFecha, hastaFecha]),

      // Mensajes por día
      query(`
        SELECT DATE(created_at) AS fecha,
               COUNT(*) FILTER (WHERE direccion='entrante') AS entrantes,
               COUNT(*) FILTER (WHERE direccion='saliente') AS salientes
        FROM mensajes WHERE created_at BETWEEN $1 AND $2::DATE + 1
        GROUP BY DATE(created_at) ORDER BY fecha ASC
      `, [desdeFecha, hastaFecha]),

      // Distribución de conversaciones por estado
      query(`
        SELECT estado, COUNT(*) AS total
        FROM conversaciones GROUP BY estado
      `),

      // Top etiquetas en conversaciones
      query(`
        SELECT unnest(etiquetas) AS etiqueta, COUNT(*) AS total
        FROM conversaciones
        WHERE etiquetas IS NOT NULL AND cardinality(etiquetas) > 0
        GROUP BY etiqueta ORDER BY total DESC LIMIT 10
      `),
    ]);

    res.json({
      periodo: { desde: desdeFecha, hasta: hastaFecha },
      mensajes: mensajes.rows[0],
      conversaciones: conversaciones.rows[0],
      contactos_nuevos: parseInt(contactosNuevos.rows[0].total),
      campanas: campanas.rows[0],
      chatbots: chatbots.rows[0],
      tiempo_respuesta_promedio_min: parseFloat(tiempoRespuesta.rows[0]?.promedio_minutos || 0),
      mensajes_por_dia: por_dia.rows,
      distribucion_estado: distribucion_estado.rows,
      top_etiquetas: top_etiquetas.rows,
    });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// Reporte de rendimiento por agente
const rendimientoAgentes = async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const desdeFecha = desde || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const hastaFecha = hasta || new Date().toISOString().split('T')[0];

    const { rows } = await query(`
      SELECT
        a.id, a.nombre, a.email, a.rol,
        COUNT(DISTINCT c.id) AS conversaciones_asignadas,
        COUNT(DISTINCT c.id) FILTER (WHERE c.estado='resuelto') AS conversaciones_resueltas,
        COUNT(m.id) FILTER (WHERE m.direccion='saliente') AS mensajes_enviados,
        ROUND(AVG(EXTRACT(EPOCH FROM (m2.created_at - m1.created_at))/60)::NUMERIC, 1) AS tiempo_respuesta_promedio_min
      FROM agentes a
      LEFT JOIN conversaciones c ON c.agente_id=a.id AND c.created_at BETWEEN $1 AND $2::DATE+1
      LEFT JOIN mensajes m ON m.agente_id=a.id AND m.created_at BETWEEN $1 AND $2::DATE+1
      LEFT JOIN mensajes m1 ON m1.conversacion_id=c.id AND m1.direccion='entrante' AND m1.created_at BETWEEN $1 AND $2::DATE+1
      LEFT JOIN mensajes m2 ON m2.conversacion_id=c.id AND m2.direccion='saliente' AND m2.created_at > m1.created_at
      WHERE a.estado='activo'
      GROUP BY a.id, a.nombre, a.email, a.rol
      ORDER BY conversaciones_asignadas DESC
    `, [desdeFecha, hastaFecha]);

    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// Reporte de campañas
const reporteCampanas = async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT c.*,
             a.nombre AS agente_nombre,
             CASE WHEN c.total_destinatarios > 0
               THEN ROUND((c.total_enviados::NUMERIC / c.total_destinatarios) * 100, 1)
               ELSE 0 END AS tasa_entrega,
             CASE WHEN c.total_enviados > 0
               THEN ROUND((c.total_leidos::NUMERIC / c.total_enviados) * 100, 1)
               ELSE 0 END AS tasa_apertura
      FROM campanas c
      LEFT JOIN agentes a ON c.agente_id=a.id
      ORDER BY c.created_at DESC LIMIT 50
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// Reporte de chatbots
const reporteChatbots = async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        b.id, b.nombre, b.activo, b.trigger_tipo,
        COUNT(s.id) AS sesiones_total,
        COUNT(s.id) FILTER (WHERE s.estado='completado') AS completadas,
        COUNT(s.id) FILTER (WHERE s.estado='transferido') AS transferidas,
        COUNT(s.id) FILTER (WHERE s.estado='abandonado') AS abandonadas,
        COUNT(s.id) FILTER (WHERE s.estado='activo') AS activas,
        ROUND(AVG(s.mensajes_enviados)::NUMERIC, 1) AS promedio_mensajes,
        CASE WHEN COUNT(s.id)>0
          THEN ROUND((COUNT(s.id) FILTER (WHERE s.estado='completado')::NUMERIC / COUNT(s.id)) * 100, 1)
          ELSE 0 END AS tasa_completado
      FROM chatbots b
      LEFT JOIN chatbot_sesiones s ON s.chatbot_id=b.id
      GROUP BY b.id, b.nombre, b.activo, b.trigger_tipo
      ORDER BY sesiones_total DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// Exportar conversaciones a CSV
const exportarConversaciones = async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const { rows } = await query(`
      SELECT c.numero_caso, co.telefono, co.nombre AS contacto,
             a.nombre AS agente, c.estado, c.titulo,
             c.ultima_actividad, c.created_at
      FROM conversaciones c
      JOIN contactos co ON c.contacto_id=co.id
      LEFT JOIN agentes a ON c.agente_id=a.id
      WHERE ($1::DATE IS NULL OR c.created_at >= $1)
        AND ($2::DATE IS NULL OR c.created_at <= $2::DATE + 1)
      ORDER BY c.created_at DESC
    `, [desde || null, hasta || null]);

    const csv = [
      'Caso,Teléfono,Contacto,Agente,Estado,Título,Última Actividad,Creado',
      ...rows.map(r =>
        `${r.numero_caso},"${r.telefono}","${r.contacto || ''}","${r.agente || ''}","${r.estado}","${r.titulo || ''}","${r.ultima_actividad}","${r.created_at}"`
      ),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=conversaciones.csv');
    res.send('\uFEFF' + csv);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

module.exports = { resumenAvanzado, rendimientoAgentes, reporteCampanas, reporteChatbots, exportarConversaciones };
