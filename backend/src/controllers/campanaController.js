// src/controllers/campanaController.js
const { query } = require('../models/db');
const { enviarCampana } = require('../services/campanaService');

const listar = async (req, res) => {
  try {
    const { estado, page = 1, limit = 20 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conds = []; const params = [];
    if (estado) { params.push(estado); conds.push(`c.estado=$${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows } = await query(`
      SELECT c.*, a.nombre AS agente_nombre, n.nombre AS numero_nombre
      FROM campanas c
      LEFT JOIN agentes a ON c.agente_id=a.id
      LEFT JOIN numeros_whatsapp n ON c.numero_id=n.id
      ${where}
      ORDER BY c.created_at DESC
      LIMIT $${params.length+1} OFFSET $${params.length+2}
    `, [...params, parseInt(limit), offset]);

    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const obtener = async (req, res) => {
  try {
    const { rows: camp } = await query(`
      SELECT c.*, a.nombre AS agente_nombre, n.nombre AS numero_nombre
      FROM campanas c
      LEFT JOIN agentes a ON c.agente_id=a.id
      LEFT JOIN numeros_whatsapp n ON c.numero_id=n.id
      WHERE c.id=$1
    `, [req.params.id]);
    if (!camp.length) return res.status(404).json({ message: 'No encontrada' });

    const { rows: destinatarios } = await query(`
      SELECT cd.*, co.nombre AS contacto_nombre_real
      FROM campana_destinatarios cd
      LEFT JOIN contactos co ON cd.contacto_id=co.id
      WHERE cd.campana_id=$1
      ORDER BY cd.created_at ASC LIMIT 500
    `, [req.params.id]);

    res.json({ ...camp[0], destinatarios });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const crear = async (req, res) => {
  try {
    const {
      nombre, tipo, mensaje, plantilla_nombre, plantilla_idioma, plantilla_componentes,
      programada_para, numero_id, destinatarios = []
    } = req.body;

    if (!nombre?.trim()) return res.status(400).json({ message: 'Nombre requerido' });
    if (!destinatarios.length) return res.status(400).json({ message: 'Debe agregar destinatarios' });

    const { rows } = await query(`
      INSERT INTO campanas (nombre, tipo, mensaje, plantilla_nombre, plantilla_idioma, plantilla_componentes,
        programada_para, numero_id, agente_id, total_destinatarios,
        estado)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, $11) RETURNING *
    `, [
      nombre, tipo || 'whatsapp', mensaje, plantilla_nombre, plantilla_idioma || 'es',
      plantilla_componentes ? JSON.stringify(plantilla_componentes) : null,
      programada_para || null, numero_id || null, req.user.id,
      destinatarios.length,
      programada_para ? 'programada' : 'borrador',
    ]);
    const campana = rows[0];

    // Insertar destinatarios
    for (const dest of destinatarios) {
      const telefono = (dest.telefono || '').replace(/\D/g, '');
      if (!telefono) continue;
      await query(`
        INSERT INTO campana_destinatarios (campana_id, contacto_id, telefono, nombre)
        VALUES ($1,$2,$3,$4)
      `, [campana.id, dest.contacto_id || null, telefono, dest.nombre || null]);
    }

    res.status(201).json(campana);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const actualizarDestinatarios = async (req, res) => {
  try {
    const { destinatarios = [] } = req.body;
    // Verificar que está en borrador
    const { rows } = await query(`SELECT estado FROM campanas WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrada' });
    if (!['borrador','programada'].includes(rows[0].estado)) {
      return res.status(400).json({ message: 'No se puede modificar una campaña en curso' });
    }

    await query(`DELETE FROM campana_destinatarios WHERE campana_id=$1`, [req.params.id]);

    for (const dest of destinatarios) {
      const telefono = (dest.telefono || '').replace(/\D/g, '');
      if (!telefono) continue;
      await query(`
        INSERT INTO campana_destinatarios (campana_id, contacto_id, telefono, nombre)
        VALUES ($1,$2,$3,$4)
      `, [req.params.id, dest.contacto_id || null, telefono, dest.nombre || null]);
    }

    await query(`UPDATE campanas SET total_destinatarios=$1, updated_at=NOW() WHERE id=$2`, [destinatarios.length, req.params.id]);
    res.json({ success: true, total: destinatarios.length });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const enviar = async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM campanas WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrada' });
    if (!['borrador','programada'].includes(rows[0].estado)) {
      return res.status(400).json({ message: `Campaña ya está en estado: ${rows[0].estado}` });
    }

    // Enviar de forma asíncrona
    enviarCampana(req.params.id).catch(() => {});
    res.json({ success: true, mensaje: 'Campaña iniciada' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const pausar = async (req, res) => {
  try {
    await query(`UPDATE campanas SET estado='pausada', updated_at=NOW() WHERE id=$1 AND estado='enviando'`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const cancelar = async (req, res) => {
  try {
    await query(`UPDATE campanas SET estado='cancelada', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const eliminar = async (req, res) => {
  try {
    const { rows } = await query(`SELECT estado FROM campanas WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrada' });
    if (rows[0].estado === 'enviando') return res.status(400).json({ message: 'No puedes eliminar una campaña enviando' });
    await query(`DELETE FROM campanas WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// Agregar contactos desde filtros
const agregarDesdeContactos = async (req, res) => {
  try {
    const { campana_id } = req.params;
    const { etiquetas, pais, cliente_vinculado } = req.body;

    const conds = []; const params = [campana_id];
    if (etiquetas?.length) { params.push(etiquetas); conds.push(`c.etiquetas && $${params.length}`); }
    if (pais) { params.push(`%${pais}%`); conds.push(`cl.pais ILIKE $${params.length}`); }

    const where = conds.length ? `AND ${conds.join(' AND ')}` : '';

    const { rows: contactos } = await query(`
      SELECT DISTINCT c.id, c.telefono, c.nombre
      FROM contactos c
      LEFT JOIN clientes cl ON c.cliente_id=cl.id
      WHERE c.telefono IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM campana_destinatarios cd WHERE cd.campana_id=$1 AND cd.telefono=c.telefono
        )
        ${where}
      LIMIT 5000
    `, params);

    let agregados = 0;
    for (const cont of contactos) {
      await query(`
        INSERT INTO campana_destinatarios (campana_id, contacto_id, telefono, nombre)
        VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING
      `, [campana_id, cont.id, cont.telefono, cont.nombre]);
      agregados++;
    }

    await query(`
      UPDATE campanas SET total_destinatarios=(
        SELECT COUNT(*) FROM campana_destinatarios WHERE campana_id=$1
      ), updated_at=NOW() WHERE id=$1
    `, [campana_id]);

    res.json({ success: true, agregados });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

module.exports = { listar, obtener, crear, actualizarDestinatarios, enviar, pausar, cancelar, eliminar, agregarDesdeContactos };
