// src/services/secuenciaService.js
// Motor de secuencias automáticas de seguimiento
const { query } = require('../models/db');
const logger = require('../utils/logger');

/**
 * Suscribir un contacto a una secuencia
 */
async function suscribir(secuenciaId, contactoId, datos = {}) {
  try {
    // Verificar que no esté ya suscrito y activo
    const { rows: exist } = await query(`
      SELECT id FROM secuencia_suscripciones
      WHERE secuencia_id=$1 AND contacto_id=$2 AND estado='activo'
    `, [secuenciaId, contactoId]);
    if (exist.length) return exist[0];

    // Obtener primer paso
    const { rows: pasos } = await query(`
      SELECT * FROM secuencia_pasos WHERE secuencia_id=$1 ORDER BY orden ASC LIMIT 1
    `, [secuenciaId]);

    if (!pasos.length) return null;
    const primerPaso = pasos[0];

    let siguienteEnvio = new Date();
    if (primerPaso.tipo === 'esperar') {
      const dias = primerPaso.configuracion?.dias || 1;
      siguienteEnvio = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
    }

    const { rows } = await query(`
      INSERT INTO secuencia_suscripciones (secuencia_id, contacto_id, paso_actual, siguiente_envio, datos)
      VALUES ($1,$2,0,$3,$4) RETURNING *
    `, [secuenciaId, contactoId, siguienteEnvio, JSON.stringify(datos)]);

    logger.info(`📋 Contacto ${contactoId} suscrito a secuencia ${secuenciaId}`);
    return rows[0];
  } catch (err) {
    logger.error('secuenciaService.suscribir:', err.message);
    return null;
  }
}

/**
 * Procesar secuencias pendientes (llamado por cron)
 */
async function procesarSecuencias() {
  try {
    const waService = require('./whatsappService');
    const emailService = require('./emailService');

    const { rows: subs } = await query(`
      SELECT ss.*, s.nombre AS secuencia_nombre,
             co.telefono, co.nombre AS contacto_nombre, co.email AS contacto_email
      FROM secuencia_suscripciones ss
      JOIN secuencias s ON ss.secuencia_id = s.id
      JOIN contactos co ON ss.contacto_id = co.id
      WHERE ss.estado='activo' AND ss.siguiente_envio <= NOW()
      AND s.activa = TRUE
      LIMIT 50
    `);

    logger.info(`⏰ Procesando ${subs.length} suscripciones de secuencia`);

    for (const sub of subs) {
      await procesarSuscripcion(sub, waService, emailService).catch(err =>
        logger.error(`Secuencia sub ${sub.id}: ${err.message}`)
      );
    }
  } catch (err) {
    logger.error('procesarSecuencias:', err.message);
  }
}

async function procesarSuscripcion(sub, waService, emailService) {
  // Obtener todos los pasos ordenados
  const { rows: pasos } = await query(`
    SELECT * FROM secuencia_pasos WHERE secuencia_id=$1 ORDER BY orden ASC
  `, [sub.secuencia_id]);

  const pasoActual = pasos[sub.paso_actual];
  if (!pasoActual) {
    // Secuencia completada
    await query(`UPDATE secuencia_suscripciones SET estado='completado', updated_at=NOW() WHERE id=$1`, [sub.id]);
    return;
  }

  const config = pasoActual.configuracion || {};

  if (pasoActual.tipo === 'whatsapp' && sub.telefono) {
    const mensaje = reemplazarVariables(config.mensaje || '', sub);
    if (mensaje) {
      await waService.enviarTexto(sub.telefono, mensaje, null, null).catch(() => {});
    }
  } else if (pasoActual.tipo === 'email' && sub.contacto_email) {
    const asunto = reemplazarVariables(config.asunto || 'Mensaje automático', sub);
    const cuerpo = reemplazarVariables(config.cuerpo || '', sub);
    await emailService.enviarEmail(sub.contacto_email, asunto, `<p>${cuerpo}</p>`, cuerpo).catch(() => {});
  }

  // Avanzar al siguiente paso
  const siguientePasoIdx = sub.paso_actual + 1;
  const siguientePaso = pasos[siguientePasoIdx];

  if (!siguientePaso) {
    await query(`UPDATE secuencia_suscripciones SET estado='completado', updated_at=NOW() WHERE id=$1`, [sub.id]);
    return;
  }

  let siguienteEnvio = new Date();
  if (siguientePaso.tipo === 'esperar') {
    const dias = siguientePaso.configuracion?.dias || 1;
    siguienteEnvio = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
    // Si el paso actual era esperar, el real siguiente es después del esperar
    await query(`
      UPDATE secuencia_suscripciones
      SET paso_actual=$1, siguiente_envio=$2, updated_at=NOW()
      WHERE id=$3
    `, [siguientePasoIdx, siguienteEnvio, sub.id]);
    return;
  }

  await query(`
    UPDATE secuencia_suscripciones
    SET paso_actual=$1, siguiente_envio=NOW(), updated_at=NOW()
    WHERE id=$2
  `, [siguientePasoIdx, sub.id]);
}

function reemplazarVariables(texto, datos) {
  return texto
    .replace(/\{\{nombre\}\}/gi, datos.contacto_nombre || 'cliente')
    .replace(/\{\{telefono\}\}/gi, datos.telefono || '')
    .replace(/\{\{email\}\}/gi, datos.contacto_email || '');
}

module.exports = { suscribir, procesarSecuencias };
