// src/controllers/chatbotController.js
const { query } = require('../models/db');

// ── CHATBOTS ──────────────────────────────────────────────────────────────────
const listarChatbots = async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT b.*,
        (SELECT COUNT(*) FROM chatbot_sesiones WHERE chatbot_id=b.id AND estado='activo') AS sesiones_activas,
        (SELECT COUNT(*) FROM chatbot_sesiones WHERE chatbot_id=b.id) AS sesiones_total,
        (SELECT COUNT(*) FROM chatbot_nodos WHERE chatbot_id=b.id) AS total_nodos
      FROM chatbots b ORDER BY b.created_at DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const obtenerChatbot = async (req, res) => {
  try {
    const { rows: bot } = await query(`SELECT * FROM chatbots WHERE id=$1`, [req.params.id]);
    if (!bot.length) return res.status(404).json({ message: 'No encontrado' });

    const { rows: nodos } = await query(`SELECT * FROM chatbot_nodos WHERE chatbot_id=$1 ORDER BY created_at ASC`, [req.params.id]);
    const { rows: conexiones } = await query(`SELECT * FROM chatbot_conexiones WHERE chatbot_id=$1 ORDER BY created_at ASC`, [req.params.id]);

    res.json({ ...bot[0], nodos, conexiones });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const crearChatbot = async (req, res) => {
  try {
    const { nombre, descripcion, trigger_tipo, trigger_palabras, numero_id } = req.body;
    if (!nombre?.trim()) return res.status(400).json({ message: 'Nombre requerido' });

    const { rows } = await query(`
      INSERT INTO chatbots (nombre, descripcion, trigger_tipo, trigger_palabras, numero_id)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [nombre, descripcion, trigger_tipo || 'palabras', trigger_palabras || [], numero_id || null]);

    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const actualizarChatbot = async (req, res) => {
  try {
    const { nombre, descripcion, activo, trigger_tipo, trigger_palabras, nodo_inicio_id, numero_id } = req.body;
    const { rows } = await query(`
      UPDATE chatbots
      SET nombre=$1, descripcion=$2, activo=$3, trigger_tipo=$4,
          trigger_palabras=$5, nodo_inicio_id=$6, numero_id=$7, updated_at=NOW()
      WHERE id=$8 RETURNING *
    `, [nombre, descripcion, activo, trigger_tipo, trigger_palabras, nodo_inicio_id, numero_id, req.params.id]);

    if (!rows.length) return res.status(404).json({ message: 'No encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const eliminarChatbot = async (req, res) => {
  try {
    await query(`DELETE FROM chatbots WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── NODOS ────────────────────────────────────────────────────────────────────
const listarNodos = async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT * FROM chatbot_nodos WHERE chatbot_id=$1 ORDER BY created_at ASC`,
      [req.params.chatbot_id]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const crearNodo = async (req, res) => {
  try {
    const { chatbot_id } = req.params;
    const { tipo, nombre, configuracion, posicion_x, posicion_y } = req.body;
    const { rows } = await query(`
      INSERT INTO chatbot_nodos (chatbot_id, tipo, nombre, configuracion, posicion_x, posicion_y)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [chatbot_id, tipo, nombre, JSON.stringify(configuracion || {}), posicion_x || 0, posicion_y || 0]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const actualizarNodo = async (req, res) => {
  try {
    const { nombre, configuracion, posicion_x, posicion_y } = req.body;
    const { rows } = await query(`
      UPDATE chatbot_nodos
      SET nombre=$1, configuracion=$2, posicion_x=$3, posicion_y=$4
      WHERE id=$5 AND chatbot_id=$6 RETURNING *
    `, [nombre, JSON.stringify(configuracion || {}), posicion_x, posicion_y, req.params.nodo_id, req.params.chatbot_id]);
    if (!rows.length) return res.status(404).json({ message: 'Nodo no encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const eliminarNodo = async (req, res) => {
  try {
    await query(`DELETE FROM chatbot_nodos WHERE id=$1 AND chatbot_id=$2`, [req.params.nodo_id, req.params.chatbot_id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── CONEXIONES ───────────────────────────────────────────────────────────────
const crearConexion = async (req, res) => {
  try {
    const { chatbot_id } = req.params;
    const { nodo_origen_id, nodo_destino_id, condicion } = req.body;
    const { rows } = await query(`
      INSERT INTO chatbot_conexiones (chatbot_id, nodo_origen_id, nodo_destino_id, condicion)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [chatbot_id, nodo_origen_id, nodo_destino_id, condicion || null]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const actualizarConexion = async (req, res) => {
  try {
    const { condicion } = req.body;
    const { rows } = await query(
      `UPDATE chatbot_conexiones SET condicion=$1 WHERE id=$2 AND chatbot_id=$3 RETURNING *`,
      [condicion ? JSON.stringify(condicion) : null, req.params.conexion_id, req.params.chatbot_id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Conexión no encontrada' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const eliminarConexion = async (req, res) => {
  try {
    await query(`DELETE FROM chatbot_conexiones WHERE id=$1 AND chatbot_id=$2`, [req.params.conexion_id, req.params.chatbot_id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── SESIONES ─────────────────────────────────────────────────────────────────
const listarSesiones = async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT s.*, b.nombre AS chatbot_nombre, co.telefono, co.nombre AS contacto_nombre
      FROM chatbot_sesiones s
      JOIN chatbots b ON s.chatbot_id=b.id
      JOIN contactos co ON s.contacto_id=co.id
      WHERE s.chatbot_id=$1
      ORDER BY s.created_at DESC LIMIT 100
    `, [req.params.chatbot_id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── BASE DE CONOCIMIENTO ─────────────────────────────────────────────────────
const listarBaseConocimiento = async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM base_conocimiento ORDER BY created_at DESC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const crearEntradaBC = async (req, res) => {
  try {
    const { titulo, contenido, categoria, etiquetas } = req.body;
    if (!titulo || !contenido) return res.status(400).json({ message: 'Título y contenido requeridos' });
    const { rows } = await query(`
      INSERT INTO base_conocimiento (titulo, contenido, categoria, etiquetas)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [titulo, contenido, categoria, etiquetas || []]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const actualizarEntradaBC = async (req, res) => {
  try {
    const { titulo, contenido, categoria, etiquetas, activo } = req.body;
    const { rows } = await query(`
      UPDATE base_conocimiento
      SET titulo=$1, contenido=$2, categoria=$3, etiquetas=$4, activo=$5, updated_at=NOW()
      WHERE id=$6 RETURNING *
    `, [titulo, contenido, categoria, etiquetas, activo, req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const eliminarEntradaBC = async (req, res) => {
  try {
    await query(`DELETE FROM base_conocimiento WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

module.exports = {
  listarChatbots, obtenerChatbot, crearChatbot, actualizarChatbot, eliminarChatbot,
  listarNodos, crearNodo, actualizarNodo, eliminarNodo,
  crearConexion, actualizarConexion, eliminarConexion,
  listarSesiones,
  listarBaseConocimiento, crearEntradaBC, actualizarEntradaBC, eliminarEntradaBC,
};
