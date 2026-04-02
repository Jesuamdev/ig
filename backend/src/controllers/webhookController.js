// src/controllers/webhookController.js
// Preserva 100% la lógica original del sistema WhatsApp
// + vincula archivos recibidos al perfil del cliente si existe
// + integra chatbots, enrutamiento inteligente y webhooks salientes
const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');
const { query, withTransaction } = require('../models/db');
const storageService = require('../services/storageService');
const { procesarFlujos } = require('../services/flowService');
const logger  = require('../utils/logger');

// Lazy-load para evitar dependencias circulares
function getChatbotService() { return require('../services/chatbotService'); }
function getEnrutamientoService() { return require('../services/enrutamientoService'); }
function getWebhookSalienteService() { return require('../services/webhookSalienteService'); }
function getCampanaService() { return require('../services/campanaService'); }
function getAiService() { return require('../services/aiService'); }

// GET /api/whatsapp/webhook — verificación Meta
function verificarWebhook(req, res) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('✅ Webhook verificado por Meta');
    return res.status(200).send(challenge);
  }
  logger.warn('❌ Fallo verificación webhook — token incorrecto');
  return res.sendStatus(403);
}

// POST /api/whatsapp/webhook — recepción de mensajes
async function recibirMensaje(req, res) {
  res.sendStatus(200); // responder 200 inmediatamente

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body.object || body.object !== 'whatsapp_business_account') return;

    const value = body.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages?.length) return;

    const io = req.app.get('io');

    for (const mensaje of value.messages) {
      await procesarMensaje(mensaje, value.contacts?.[0], io);
    }

    if (value.statuses?.length) {
      for (const status of value.statuses) {
        await actualizarEstadoMensaje(status);
      }
    }
  } catch (err) {
    logger.error('Error procesando webhook:', err.message);
  }
}

async function procesarMensaje(mensaje, contactoMeta, io) {
  const telefono    = mensaje.from;
  const waMessageId = mensaje.id;
  const tipo        = mensaje.type;

  // Evitar duplicados
  const dup = await query('SELECT id FROM mensajes WHERE whatsapp_message_id = $1', [waMessageId]);
  if (dup.rows.length) return;

  await withTransaction(async (client) => {

    // 1. Upsert contacto
    const nombreContacto = contactoMeta?.profile?.name || null;
    const { rows: cRows } = await client.query(`
      INSERT INTO contactos (telefono, nombre, ultimo_mensaje)
      VALUES ($1, $2, NOW())
      ON CONFLICT (telefono) DO UPDATE
        SET ultimo_mensaje = NOW(),
            nombre = COALESCE(contactos.nombre, $2)
      RETURNING *
    `, [telefono, nombreContacto]);
    const contacto = cRows[0];

    // 2. Buscar cliente vinculado por teléfono
    const clienteLink = await client.query(
      `SELECT id, nombre FROM clientes WHERE telefono = $1 AND estado = 'activo' LIMIT 1`,
      ['+' + telefono.replace(/^\+/, '')]
    );
    const clienteId = clienteLink.rows[0]?.id || contacto.cliente_id || null;

    // Actualizar cliente_id en contacto si se encontró
    if (clienteId && !contacto.cliente_id) {
      await client.query(`UPDATE contactos SET cliente_id = $1 WHERE id = $2`, [clienteId, contacto.id]);
    }

    // 3. Conversación activa
    let { rows: convRows } = await client.query(`
      SELECT * FROM conversaciones
      WHERE contacto_id = $1 AND estado NOT IN ('cerrado')
      ORDER BY ultima_actividad DESC LIMIT 1
    `, [contacto.id]);

    let conversacion;
    const preview = extraerTextoPreview(mensaje, tipo);

    if (!convRows.length) {
      const { rows: nueva } = await client.query(`
        INSERT INTO conversaciones (contacto_id, estado, ultimo_mensaje, ultima_actividad)
        VALUES ($1, 'abierto', $2, NOW()) RETURNING *
      `, [contacto.id, preview]);
      conversacion = nueva[0];
    } else {
      conversacion = convRows[0];
      await client.query(`
        UPDATE conversaciones
        SET ultimo_mensaje = $1, ultima_actividad = NOW(),
            mensajes_sin_leer = mensajes_sin_leer + 1
        WHERE id = $2
      `, [preview, conversacion.id]);
    }

    // 4. Guardar mensaje
    const contenido = extraerContenidoTexto(mensaje, tipo);
    const { rows: msgRows } = await client.query(`
      INSERT INTO mensajes (conversacion_id, contacto_id, direccion, tipo, contenido, whatsapp_message_id)
      VALUES ($1,$2,'entrante',$3,$4,$5) RETURNING *
    `, [conversacion.id, contacto.id, tipo, contenido, waMessageId]);
    const mensajeGuardado = msgRows[0];

    // 5. Descargar y guardar archivo si aplica
    let archivoGuardado = null;
    if (['image','document','audio','video'].includes(tipo)) {
      archivoGuardado = await descargarYGuardarArchivo(
        mensaje, tipo, mensajeGuardado.id, conversacion.id, contacto.id, clienteId, client
      );
    }

    // 6. Registrar en actividad del cliente si está vinculado
    if (clienteId) {
      await client.query(`
        INSERT INTO actividad (cliente_id, accion, detalles)
        VALUES ($1, $2, $3)
      `, [clienteId,
        archivoGuardado ? 'archivo.recibido_whatsapp' : 'mensaje.recibido_whatsapp',
        JSON.stringify({ tipo, preview: preview.substring(0,80) })
      ]);
    }

    // 7. Emitir por Socket.io
    if (io) {
      io.emit('nuevo_mensaje', {
        conversacion_id: conversacion.id,
        contacto:  { id: contacto.id, telefono, nombre: contacto.nombre },
        cliente_id: clienteId,
        mensaje:   mensajeGuardado,
        archivo:   archivoGuardado,
        timestamp: new Date().toISOString(),
      });

      if (conversacion.agente_id) {
        io.to(`agent_${conversacion.agente_id}`).emit('notificacion', {
          tipo: 'nuevo_mensaje',
          titulo: `Mensaje de ${contacto.nombre || telefono}`,
          conversacion_id: conversacion.id,
        });
      }
    }

    // 7b. Detección de intención con IA (asíncrono, no bloquea)
    const textoMensaje = contenido;
    if (textoMensaje && tipo === 'text') {
      setImmediate(async () => {
        try {
          const aiService = getAiService();
          const intencion = await aiService.detectarIntencion(textoMensaje);
          if (intencion?.intencion && intencion.intencion !== 'otro') {
            await query(`
              UPDATE conversaciones SET titulo=COALESCE(titulo,$1) WHERE id=$2
            `, [`[IA] ${intencion.intencion}`, conversacion.id]).catch(() => {});
          }
        } catch (_) {}
      });
    }

    // 7c. Procesar chatbot si hay sesión activa o nuevo chatbot detectado
    const esConversacionNueva = !convRows.length;
    setImmediate(async () => {
      try {
        const chatbotService = getChatbotService();
        let sesionActiva = await chatbotService.obtenerSesionActiva(contacto.id);

        if (!sesionActiva && tipo === 'text') {
          // Intentar detectar si algún chatbot debe activarse
          const numeroId = conversacion.numero_id || null;
          const bot = await chatbotService.detectarChatbot(contenido, contacto.id, numeroId);
          if (bot) {
            sesionActiva = await chatbotService.iniciarSesion(bot.id, contacto.id, conversacion.id);
            if (sesionActiva) {
              const waService = require('../services/whatsappService');
              await chatbotService.ejecutarNodoInicio(sesionActiva, waService).catch(() => {});
            }
          }
        } else if (sesionActiva && tipo === 'text') {
          // Continuar sesión activa
          const waService = require('../services/whatsappService');
          await chatbotService.procesarRespuesta(sesionActiva, contenido, waService, io).catch(() => {});
        }
      } catch (err) {
        logger.error('chatbot procesamiento:', err.message);
      }
    });

    // 7d. Aplicar reglas de enrutamiento si es conversación nueva
    if (esConversacionNueva) {
      setImmediate(async () => {
        try {
          const enrutamiento = getEnrutamientoService();
          await enrutamiento.aplicarReglas(conversacion, contacto, mensajeGuardado).catch(() => {});
        } catch (_) {}
      });
    }

    // 7e. Despachar webhook saliente
    setImmediate(async () => {
      try {
        const whSaliente = getWebhookSalienteService();
        await whSaliente.despacharEvento('mensaje.nuevo', {
          conversacion_id: conversacion.id,
          contacto_id: contacto.id,
          telefono, tipo,
          contenido: contenido.substring(0, 500),
          direccion: 'entrante',
          timestamp: new Date().toISOString(),
        });
      } catch (_) {}
    });

    // 8. Ejecutar flujos automáticos si llegó un archivo
    if (archivoGuardado) {
      let clienteData = null;
      if (clienteId) {
        const { rows: cRows } = await client.query(
          `SELECT id, nombre, apellido, agente_id FROM clientes WHERE id = $1`, [clienteId]
        );
        clienteData = cRows[0] || null;
      }
      // Ejecutar fuera de la transacción para no bloquearla
      setImmediate(() => {
        procesarFlujos({
          archivo:      archivoGuardado,
          cliente:      clienteData,
          contacto:     { id: contacto.id, telefono, nombre: contacto.nombre },
          conversacion: { id: conversacion.id, agente_id: conversacion.agente_id },
          io,
        }).catch(err => logger.error('flowService error:', err.message));
      });
    }

    logger.info(`✅ Mensaje procesado: ${tipo} de ${telefono}${clienteId ? ` [cliente ${clienteId}]` : ''}`);
  });
}

async function descargarYGuardarArchivo(mensaje, tipo, mensajeId, conversacionId, contactoId, clienteId, client) {
  try {
    const mediaInfo = mensaje[tipo];
    const mediaId   = mediaInfo?.id;
    if (!mediaId) return null;

    const metaRes = await axios.get(
      `https://graph.facebook.com/v18.0/${mediaId}`,
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } }
    );

    const mediaUrl  = metaRes.data.url;
    const mimeType  = metaRes.data.mime_type || mediaInfo.mime_type || 'application/octet-stream';

    const fileRes = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    });

    const buffer          = Buffer.from(fileRes.data);
    const extension       = obtenerExtension(mimeType, tipo);
    const nombreOriginal  = mediaInfo.filename || `${tipo}_${Date.now()}.${extension}`;
    const nombreAlmacenado = `${uuidv4()}.${extension}`;

    const urlAlmacenamiento = await storageService.upload({
      buffer, filename: nombreAlmacenado, mimeType,
      folder: `archivos/${new Date().getFullYear()}/${String(new Date().getMonth() + 1).padStart(2,'0')}`,
    });

    const { rows } = await client.query(`
      INSERT INTO archivos (
        mensaje_id, conversacion_id, contacto_id, cliente_id,
        nombre_original, nombre_almacenado, tipo_mime, extension,
        tamanio_bytes, url_almacenamiento, whatsapp_media_id, origen
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'whatsapp')
      RETURNING *
    `, [mensajeId, conversacionId, contactoId, clienteId,
        nombreOriginal, nombreAlmacenado, mimeType, extension,
        buffer.length, urlAlmacenamiento, mediaId]);

    logger.info(`📎 Archivo guardado: ${nombreOriginal} (${(buffer.length / 1024).toFixed(1)} KB)${clienteId ? ` → cliente ${clienteId}` : ''}`);
    return rows[0];
  } catch (err) {
    logger.error(`Error descargando archivo: ${err.message}`);
    return null;
  }
}

async function actualizarEstadoMensaje(status) {
  try {
    await query(`UPDATE mensajes SET estado = $1 WHERE whatsapp_message_id = $2`, [status.status, status.id]);

    // Actualizar estadísticas de campaña si aplica
    if (['delivered','read'].includes(status.status)) {
      const campanaService = getCampanaService();
      await campanaService.actualizarEstadoCampana(status.id, status.status).catch(() => {});
    }
  } catch (err) {
    logger.error('actualizarEstado:', err.message);
  }
}

// Helpers
function extraerContenidoTexto(msg, tipo) {
  switch (tipo) {
    case 'text':     return msg.text?.body || '';
    case 'image':    return msg.image?.caption || '[Imagen]';
    case 'document': return msg.document?.filename || '[Documento]';
    case 'audio':    return '[Audio]';
    case 'video':    return msg.video?.caption || '[Video]';
    default:         return `[${tipo}]`;
  }
}

function extraerTextoPreview(msg, tipo) {
  const c = extraerContenidoTexto(msg, tipo);
  return tipo !== 'text' ? `📎 ${c}` : c.substring(0, 100);
}

function obtenerExtension(mimeType, tipo) {
  const mapa = {
    'application/pdf': 'pdf', 'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4',
  };
  return mapa[mimeType] || tipo || 'bin';
}

module.exports = { verificarWebhook, recibirMensaje };