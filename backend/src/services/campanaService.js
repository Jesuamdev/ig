// src/services/campanaService.js
// Gestión y envío de campañas de difusión masiva
const { query } = require('../models/db');
const logger = require('../utils/logger');
const axios = require('axios');

/**
 * Enviar una campaña (puede ser llamado por cron o manualmente)
 */
async function enviarCampana(campanaId) {
  let campana;
  try {
    const { rows } = await query(`SELECT * FROM campanas WHERE id=$1`, [campanaId]);
    if (!rows.length) throw new Error('Campaña no encontrada');
    campana = rows[0];

    if (!['programada','borrador'].includes(campana.estado)) {
      logger.warn(`Campaña ${campanaId} ya fue procesada (estado: ${campana.estado})`);
      return;
    }

    // Marcar como enviando
    await query(`UPDATE campanas SET estado='enviando', iniciada_at=NOW(), updated_at=NOW() WHERE id=$1`, [campanaId]);

    // Obtener número de WhatsApp a usar
    let phoneId = process.env.WHATSAPP_PHONE_ID;
    let token   = process.env.WHATSAPP_TOKEN;

    if (campana.numero_id) {
      const { rows: numRows } = await query(`SELECT * FROM numeros_whatsapp WHERE id=$1`, [campana.numero_id]);
      if (numRows.length) { phoneId = numRows[0].phone_id; token = numRows[0].token; }
    }

    // Obtener destinatarios pendientes
    const { rows: destinatarios } = await query(`
      SELECT * FROM campana_destinatarios
      WHERE campana_id=$1 AND estado='pendiente'
      ORDER BY created_at ASC
    `, [campanaId]);

    logger.info(`📢 Enviando campaña "${campana.nombre}": ${destinatarios.length} destinatarios`);

    let enviados = 0, fallidos = 0;

    for (const dest of destinatarios) {
      try {
        // Rate limiting: 1 mensaje cada 100ms
        await sleep(100);

        const waMessageId = await enviarMensajeWA(dest.telefono, campana, phoneId, token);

        await query(`
          UPDATE campana_destinatarios
          SET estado='enviado', whatsapp_message_id=$1, enviado_at=NOW()
          WHERE id=$2
        `, [waMessageId, dest.id]);
        enviados++;
      } catch (err) {
        await query(`
          UPDATE campana_destinatarios
          SET estado='fallido', error_mensaje=$1
          WHERE id=$2
        `, [err.message.substring(0, 200), dest.id]);
        fallidos++;
        logger.error(`Campaña ${campanaId}: fallo envío a ${dest.telefono}: ${err.message}`);
      }
    }

    // Actualizar estadísticas finales
    await query(`
      UPDATE campanas
      SET estado='completada',
          total_enviados=$1,
          total_fallidos=$2,
          completada_at=NOW(),
          updated_at=NOW()
      WHERE id=$3
    `, [enviados, fallidos, campanaId]);

    logger.info(`✅ Campaña "${campana.nombre}" completada: ${enviados} enviados, ${fallidos} fallidos`);
    return { enviados, fallidos };

  } catch (err) {
    logger.error(`❌ Error en campaña ${campanaId}: ${err.message}`);
    await query(`UPDATE campanas SET estado='cancelada', updated_at=NOW() WHERE id=$1`, [campanaId]).catch(() => {});
    throw err;
  }
}

async function enviarMensajeWA(telefono, campana, phoneId, token) {
  const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  let payload;
  if (campana.plantilla_nombre) {
    payload = {
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'template',
      template: {
        name: campana.plantilla_nombre,
        language: { code: campana.plantilla_idioma || 'es' },
        components: campana.plantilla_componentes || [],
      },
    };
  } else {
    payload = {
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'text',
      text: { body: campana.mensaje },
    };
  }

  const res = await axios.post(url, payload, { headers });
  return res.data.messages?.[0]?.id;
}

/**
 * Procesar campañas programadas (llamado por cron)
 */
async function procesarCampanasProgramadas() {
  try {
    const { rows } = await query(`
      SELECT id FROM campanas
      WHERE estado='programada' AND programada_para <= NOW()
    `);

    for (const { id } of rows) {
      await enviarCampana(id).catch(err => logger.error(`Cron campaña ${id}:`, err.message));
    }
  } catch (err) {
    logger.error('procesarCampanasProgramadas:', err.message);
  }
}

/**
 * Actualizar estadísticas de entrega/lectura basadas en webhooks de estado
 */
async function actualizarEstadoCampana(waMessageId, estado) {
  try {
    const campo = estado === 'delivered' ? 'entregado_at' :
                  estado === 'read'      ? 'leido_at' : null;

    if (campo) {
      const { rows } = await query(`
        UPDATE campana_destinatarios
        SET estado=$1, ${campo}=NOW()
        WHERE whatsapp_message_id=$2
        RETURNING campana_id
      `, [estado === 'delivered' ? 'entregado' : 'leido', waMessageId]);

      if (rows.length) {
        // Actualizar contador en la campaña
        const campo2 = estado === 'delivered' ? 'total_entregados' : 'total_leidos';
        await query(`UPDATE campanas SET ${campo2}=${campo2}+1 WHERE id=$1`, [rows[0].campana_id]);
      }
    }
  } catch (err) {
    logger.error('actualizarEstadoCampana:', err.message);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { enviarCampana, procesarCampanasProgramadas, actualizarEstadoCampana };
