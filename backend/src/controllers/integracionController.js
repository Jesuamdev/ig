// src/controllers/integracionController.js
const { query } = require('../models/db');
const axios = require('axios');

// ── NÚMEROS DE WHATSAPP ───────────────────────────────────────────────────────
const listarNumeros = async (req, res) => {
  try {
    const { rows } = await query(`SELECT id,nombre,phone_id,business_id,estado,created_at FROM numeros_whatsapp ORDER BY created_at DESC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const crearNumero = async (req, res) => {
  try {
    const { nombre, phone_id, token, business_id, verify_token } = req.body;
    if (!nombre || !phone_id || !token) return res.status(400).json({ message: 'nombre, phone_id y token son requeridos' });

    const { rows } = await query(`
      INSERT INTO numeros_whatsapp (nombre, phone_id, token, business_id, verify_token)
      VALUES ($1,$2,$3,$4,$5) RETURNING id,nombre,phone_id,business_id,estado,created_at
    `, [nombre, phone_id, token, business_id, verify_token]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const actualizarNumero = async (req, res) => {
  try {
    const { nombre, token, business_id, estado } = req.body;
    const { rows } = await query(`
      UPDATE numeros_whatsapp SET nombre=$1, token=$2, business_id=$3, estado=$4, updated_at=NOW()
      WHERE id=$5 RETURNING id,nombre,phone_id,estado
    `, [nombre, token, business_id, estado, req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const eliminarNumero = async (req, res) => {
  try {
    await query(`DELETE FROM numeros_whatsapp WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── REGLAS DE ENRUTAMIENTO ────────────────────────────────────────────────────
const listarReglas = async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM reglas_enrutamiento ORDER BY prioridad DESC, created_at ASC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const crearRegla = async (req, res) => {
  try {
    const { nombre, condiciones, accion, configuracion, prioridad } = req.body;
    if (!nombre || !accion) return res.status(400).json({ message: 'nombre y accion requeridos' });
    const { rows } = await query(`
      INSERT INTO reglas_enrutamiento (nombre, condiciones, accion, configuracion, prioridad)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [nombre, JSON.stringify(condiciones || []), accion, JSON.stringify(configuracion || {}), prioridad || 0]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const actualizarRegla = async (req, res) => {
  try {
    const { nombre, condiciones, accion, configuracion, prioridad, activa } = req.body;
    const { rows } = await query(`
      UPDATE reglas_enrutamiento
      SET nombre=$1, condiciones=$2, accion=$3, configuracion=$4, prioridad=$5, activa=$6, updated_at=NOW()
      WHERE id=$7 RETURNING *
    `, [nombre, JSON.stringify(condiciones), accion, JSON.stringify(configuracion), prioridad, activa, req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrada' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const eliminarRegla = async (req, res) => {
  try {
    await query(`DELETE FROM reglas_enrutamiento WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── WEBHOOKS SALIENTES ────────────────────────────────────────────────────────
const listarWebhooks = async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT w.*, (SELECT COUNT(*) FROM webhook_logs WHERE webhook_id=w.id) AS total_logs
      FROM webhooks_salientes w ORDER BY w.created_at DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const crearWebhook = async (req, res) => {
  try {
    const { nombre, url, secret_key, eventos } = req.body;
    if (!nombre || !url || !eventos?.length) return res.status(400).json({ message: 'nombre, url y eventos requeridos' });
    const { rows } = await query(`
      INSERT INTO webhooks_salientes (nombre, url, secret_key, eventos)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [nombre, url, secret_key, eventos]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const actualizarWebhook = async (req, res) => {
  try {
    const { nombre, url, secret_key, eventos, activo } = req.body;
    const { rows } = await query(`
      UPDATE webhooks_salientes SET nombre=$1, url=$2, secret_key=$3, eventos=$4, activo=$5, updated_at=NOW()
      WHERE id=$6 RETURNING *
    `, [nombre, url, secret_key, eventos, activo, req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const eliminarWebhook = async (req, res) => {
  try {
    await query(`DELETE FROM webhooks_salientes WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const logsWebhook = async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT * FROM webhook_logs WHERE webhook_id=$1 ORDER BY created_at DESC LIMIT 100
    `, [req.params.id]);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const probarWebhook = async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM webhooks_salientes WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrado' });
    const { despacharEvento } = require('../services/webhookSalienteService');
    await despacharEvento('test', { mensaje: 'Prueba de webhook', timestamp: new Date().toISOString() });
    res.json({ success: true, mensaje: 'Evento de prueba enviado' });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── INTEGRACIONES EXTERNAS ────────────────────────────────────────────────────
const listarIntegraciones = async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, tipo, nombre, activa, ultimo_sync, created_at,
             -- No devolver configuración sensible completa
             jsonb_build_object(
               'tiene_api_key', (configuracion->>'api_key') IS NOT NULL,
               'webhook_url', configuracion->>'webhook_url',
               'spreadsheet_id', configuracion->>'spreadsheet_id'
             ) AS config_publica
      FROM integraciones ORDER BY tipo, created_at
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const upsertIntegracion = async (req, res) => {
  try {
    const { tipo, nombre, configuracion } = req.body;
    const tipos_validos = ['google_sheets','shopify','woocommerce','zapier','make','n8n','stripe','openai'];
    if (!tipos_validos.includes(tipo)) return res.status(400).json({ message: 'Tipo inválido' });

    const { rows: exist } = await query(`SELECT id FROM integraciones WHERE tipo=$1`, [tipo]);
    let result;
    if (exist.length) {
      const { rows } = await query(`
        UPDATE integraciones SET nombre=$1, configuracion=$2, updated_at=NOW() WHERE tipo=$3 RETURNING *
      `, [nombre, JSON.stringify(configuracion), tipo]);
      result = rows[0];
    } else {
      const { rows } = await query(`
        INSERT INTO integraciones (tipo, nombre, configuracion) VALUES ($1,$2,$3) RETURNING *
      `, [tipo, nombre, JSON.stringify(configuracion)]);
      result = rows[0];
    }
    res.json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const toggleIntegracion = async (req, res) => {
  try {
    const { rows } = await query(`
      UPDATE integraciones SET activa=NOT activa, updated_at=NOW() WHERE id=$1 RETURNING *
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrada' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── WIDGETS ───────────────────────────────────────────────────────────────────
const listarWidgets = async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM widgets ORDER BY created_at DESC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const crearWidget = async (req, res) => {
  try {
    const { nombre, telefono, mensaje_bienvenida, color_primario, posicion, dominio } = req.body;
    if (!nombre || !telefono) return res.status(400).json({ message: 'nombre y telefono requeridos' });
    const { rows } = await query(`
      INSERT INTO widgets (nombre, telefono, mensaje_bienvenida, color_primario, posicion, dominio)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [nombre, telefono.replace(/\D/g,''), mensaje_bienvenida, color_primario || '#25D366', posicion || 'derecha', dominio]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const actualizarWidget = async (req, res) => {
  try {
    const { nombre, telefono, mensaje_bienvenida, color_primario, posicion, activo, dominio } = req.body;
    const { rows } = await query(`
      UPDATE widgets SET nombre=$1, telefono=$2, mensaje_bienvenida=$3,
        color_primario=$4, posicion=$5, activo=$6, dominio=$7, updated_at=NOW()
      WHERE id=$8 RETURNING *
    `, [nombre, telefono?.replace(/\D/g,''), mensaje_bienvenida, color_primario, posicion, activo, dominio, req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrado' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const eliminarWidget = async (req, res) => {
  try {
    await query(`DELETE FROM widgets WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// Obtener snippet de código para el widget
const widgetSnippet = async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM widgets WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrado' });
    const w = rows[0];
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const snippet = `<!-- WhatsApp Widget by 33Solutions -->
<script>
  window.WA_WIDGET_CONFIG = {
    id: "${w.id}",
    telefono: "${w.telefono}",
    mensaje: "${(w.mensaje_bienvenida || '').replace(/"/g, '\\"')}",
    color: "${w.color_primario}",
    posicion: "${w.posicion}"
  };
</script>
<script src="${baseUrl}/widget/widget.js" async></script>`;
    res.json({ snippet, widget: w });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── IA CONFIGURACIÓN ──────────────────────────────────────────────────────────
const obtenerConfigIA = async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT id, tipo, modelo, temperatura, activo, funciones, created_at
      FROM ia_configuracion LIMIT 1
    `);
    res.json(rows[0] || null);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const upsertConfigIA = async (req, res) => {
  try {
    const { tipo, api_key, modelo, temperatura, activo, funciones } = req.body;
    const { rows: exist } = await query(`SELECT id FROM ia_configuracion LIMIT 1`);
    let result;
    if (exist.length) {
      const campos = ['tipo=$1', 'modelo=$2', 'temperatura=$3', 'activo=$4', 'funciones=$5', 'updated_at=NOW()'];
      const vals = [tipo, modelo, temperatura, activo, JSON.stringify(funciones)];
      if (api_key) { campos.push(`api_key=$${vals.length+1}`); vals.push(api_key); }
      const { rows } = await query(
        `UPDATE ia_configuracion SET ${campos.join(',')} WHERE id=$${vals.length+1} RETURNING id,tipo,modelo,activo,funciones`,
        [...vals, exist[0].id]
      );
      result = rows[0];
    } else {
      const { rows } = await query(`
        INSERT INTO ia_configuracion (tipo, api_key, modelo, temperatura, activo, funciones)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,tipo,modelo,activo,funciones
      `, [tipo, api_key, modelo, temperatura, activo, JSON.stringify(funciones)]);
      result = rows[0];
    }
    res.json(result);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── PLANTILLAS DE MENSAJES ────────────────────────────────────────────────────
const listarPlantillas = async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM plantillas_mensajes ORDER BY created_at DESC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const crearPlantilla = async (req, res) => {
  try {
    const { nombre, categoria, idioma, cuerpo, componentes } = req.body;
    if (!nombre || !cuerpo) return res.status(400).json({ message: 'nombre y cuerpo requeridos' });
    const { rows } = await query(`
      INSERT INTO plantillas_mensajes (nombre, categoria, idioma, cuerpo, componentes)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [nombre, categoria || 'general', idioma || 'es', cuerpo, componentes ? JSON.stringify(componentes) : null]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const actualizarPlantilla = async (req, res) => {
  try {
    const { nombre, categoria, idioma, cuerpo, componentes, estado } = req.body;
    const { rows } = await query(`
      UPDATE plantillas_mensajes SET nombre=$1,categoria=$2,idioma=$3,cuerpo=$4,componentes=$5,estado=$6,updated_at=NOW()
      WHERE id=$7 RETURNING *
    `, [nombre, categoria, idioma, cuerpo, componentes ? JSON.stringify(componentes) : null, estado, req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrada' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const eliminarPlantilla = async (req, res) => {
  try {
    await query(`DELETE FROM plantillas_mensajes WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── SECUENCIAS ────────────────────────────────────────────────────────────────
const listarSecuencias = async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT s.*,
        (SELECT COUNT(*) FROM secuencia_pasos WHERE secuencia_id=s.id) AS total_pasos,
        (SELECT COUNT(*) FROM secuencia_suscripciones WHERE secuencia_id=s.id AND estado='activo') AS suscriptores_activos
      FROM secuencias s ORDER BY s.created_at DESC
    `);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const obtenerSecuencia = async (req, res) => {
  try {
    const { rows: seq } = await query(`SELECT * FROM secuencias WHERE id=$1`, [req.params.id]);
    if (!seq.length) return res.status(404).json({ message: 'No encontrada' });
    const { rows: pasos } = await query(`SELECT * FROM secuencia_pasos WHERE secuencia_id=$1 ORDER BY orden ASC`, [req.params.id]);
    res.json({ ...seq[0], pasos });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const crearSecuencia = async (req, res) => {
  try {
    const { nombre, descripcion, pasos = [] } = req.body;
    if (!nombre) return res.status(400).json({ message: 'Nombre requerido' });
    const { rows } = await query(`INSERT INTO secuencias (nombre, descripcion) VALUES ($1,$2) RETURNING *`, [nombre, descripcion]);
    const seq = rows[0];
    for (const [i, paso] of pasos.entries()) {
      await query(`
        INSERT INTO secuencia_pasos (secuencia_id, orden, tipo, configuracion)
        VALUES ($1,$2,$3,$4)
      `, [seq.id, paso.orden ?? i, paso.tipo, JSON.stringify(paso.configuracion || {})]);
    }
    res.status(201).json(seq);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const actualizarSecuencia = async (req, res) => {
  try {
    const { nombre, descripcion, activa, pasos } = req.body;
    const { rows } = await query(`
      UPDATE secuencias SET nombre=$1, descripcion=$2, activa=$3, updated_at=NOW()
      WHERE id=$4 RETURNING *
    `, [nombre, descripcion, activa, req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'No encontrada' });

    if (pasos) {
      await query(`DELETE FROM secuencia_pasos WHERE secuencia_id=$1`, [req.params.id]);
      for (const [i, paso] of pasos.entries()) {
        await query(`
          INSERT INTO secuencia_pasos (secuencia_id, orden, tipo, configuracion)
          VALUES ($1,$2,$3,$4)
        `, [req.params.id, paso.orden ?? i, paso.tipo, JSON.stringify(paso.configuracion || {})]);
      }
    }
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const suscribirContacto = async (req, res) => {
  try {
    const { contacto_id, datos } = req.body;
    const { suscribir } = require('../services/secuenciaService');
    const sub = await suscribir(req.params.id, contacto_id, datos || {});
    if (!sub) return res.status(400).json({ message: 'No se pudo suscribir el contacto' });
    res.status(201).json(sub);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

// ── ETIQUETAS ─────────────────────────────────────────────────────────────────
const listarEtiquetas = async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM etiquetas ORDER BY nombre ASC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const crearEtiqueta = async (req, res) => {
  try {
    const { nombre, color, descripcion } = req.body;
    if (!nombre) return res.status(400).json({ message: 'Nombre requerido' });
    const { rows } = await query(`
      INSERT INTO etiquetas (nombre, color, descripcion) VALUES ($1,$2,$3) RETURNING *
    `, [nombre, color || '#6B7280', descripcion]);
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ message: err.message }); }
};

const eliminarEtiqueta = async (req, res) => {
  try {
    await query(`DELETE FROM etiquetas WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ message: err.message }); }
};

module.exports = {
  // Números
  listarNumeros, crearNumero, actualizarNumero, eliminarNumero,
  // Reglas
  listarReglas, crearRegla, actualizarRegla, eliminarRegla,
  // Webhooks
  listarWebhooks, crearWebhook, actualizarWebhook, eliminarWebhook, logsWebhook, probarWebhook,
  // Integraciones
  listarIntegraciones, upsertIntegracion, toggleIntegracion,
  // Widgets
  listarWidgets, crearWidget, actualizarWidget, eliminarWidget, widgetSnippet,
  // IA
  obtenerConfigIA, upsertConfigIA,
  // Plantillas
  listarPlantillas, crearPlantilla, actualizarPlantilla, eliminarPlantilla,
  // Secuencias
  listarSecuencias, obtenerSecuencia, crearSecuencia, actualizarSecuencia, suscribirContacto,
  // Etiquetas
  listarEtiquetas, crearEtiqueta, eliminarEtiqueta,
};
