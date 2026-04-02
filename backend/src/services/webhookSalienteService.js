// src/services/webhookSalienteService.js
// Envío de eventos a webhooks externos (outbound webhooks)
const { query } = require('../models/db');
const logger = require('../utils/logger');
const axios = require('axios');
const crypto = require('crypto');

/**
 * Despachar un evento a todos los webhooks suscritos
 */
async function despacharEvento(evento, payload) {
  try {
    const { rows: webhooks } = await query(`
      SELECT * FROM webhooks_salientes
      WHERE activo=TRUE AND $1=ANY(eventos)
    `, [evento]);

    if (!webhooks.length) return;

    for (const wh of webhooks) {
      enviarWebhook(wh, evento, payload).catch(err =>
        logger.error(`Webhook ${wh.id} error: ${err.message}`)
      );
    }
  } catch (err) {
    logger.error('despacharEvento:', err.message);
  }
}

async function enviarWebhook(webhook, evento, payload) {
  const inicio = Date.now();
  const cuerpo = JSON.stringify({ evento, timestamp: new Date().toISOString(), data: payload });

  const headers = {
    'Content-Type': 'application/json',
    'X-Webhook-Event': evento,
    'X-Webhook-Signature': generarFirma(cuerpo, webhook.secret_key),
  };

  let estadoHttp = null, respuesta = null;

  try {
    const res = await axios.post(webhook.url, cuerpo, { headers, timeout: 10000 });
    estadoHttp = res.status;
    respuesta = typeof res.data === 'string' ? res.data.substring(0, 500) : JSON.stringify(res.data).substring(0, 500);
  } catch (err) {
    estadoHttp = err.response?.status || 0;
    respuesta = err.message;
  }

  const duracion = Date.now() - inicio;

  // Guardar log
  await query(`
    INSERT INTO webhook_logs (webhook_id, evento, payload, estado, respuesta, duracion_ms)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [webhook.id, evento, payload, estadoHttp, respuesta, duracion]).catch(() => {});

  // Actualizar último envío
  await query(`
    UPDATE webhooks_salientes SET ultimo_envio=NOW(), ultimo_estado=$1, updated_at=NOW() WHERE id=$2
  `, [estadoHttp, webhook.id]).catch(() => {});

  logger.info(`📤 Webhook ${webhook.nombre} [${evento}] → ${estadoHttp} (${duracion}ms)`);
}

function generarFirma(cuerpo, secretKey) {
  if (!secretKey) return '';
  return 'sha256=' + crypto.createHmac('sha256', secretKey).update(cuerpo).digest('hex');
}

module.exports = { despacharEvento };
