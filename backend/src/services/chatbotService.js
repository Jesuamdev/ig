// src/services/chatbotService.js
// Motor de ejecución de chatbots visuales
const { query, withTransaction } = require('../models/db');
const logger = require('../utils/logger');

/**
 * Verifica si un mensaje activa algún chatbot
 */
async function detectarChatbot(texto, contactoId, numeroId) {
  try {
    const { rows: bots } = await query(`
      SELECT * FROM chatbots
      WHERE activo = TRUE
        AND (numero_id IS NULL OR numero_id = $1)
      ORDER BY created_at ASC
    `, [numeroId || null]);

    for (const bot of bots) {
      if (bot.trigger_tipo === 'todos' || bot.trigger_tipo === 'siempre') return bot;
      if (bot.trigger_tipo === 'nuevo_contacto') {
        // Solo para primer mensaje
        const { rows } = await query(
          `SELECT COUNT(*) AS total FROM mensajes m
           JOIN conversaciones c ON m.conversacion_id = c.id
           WHERE c.contacto_id = $1`, [contactoId]
        );
        if (parseInt(rows[0].total) <= 1) return bot;
      }
      if (bot.trigger_tipo === 'palabras' && bot.trigger_palabras?.length) {
        const textoLower = (texto || '').toLowerCase();
        const activado = bot.trigger_palabras.some(p => textoLower.includes(p.toLowerCase()));
        if (activado) return bot;
      }
    }
    return null;
  } catch (err) {
    logger.error('chatbotService.detectarChatbot:', err.message);
    return null;
  }
}

/**
 * Iniciar sesión de chatbot para un contacto
 */
async function iniciarSesion(chatbotId, contactoId, conversacionId) {
  try {
    const { rows: bot } = await query(`SELECT * FROM chatbots WHERE id=$1`, [chatbotId]);
    if (!bot.length || !bot[0].nodo_inicio_id) return null;

    // Cancelar sesiones activas anteriores del mismo bot
    await query(`
      UPDATE chatbot_sesiones SET estado='abandonado', updated_at=NOW()
      WHERE contacto_id=$1 AND chatbot_id=$2 AND estado='activo'
    `, [contactoId, chatbotId]);

    const { rows } = await query(`
      INSERT INTO chatbot_sesiones (chatbot_id, contacto_id, conversacion_id, nodo_actual_id, estado)
      VALUES ($1,$2,$3,$4,'activo') RETURNING *
    `, [chatbotId, contactoId, conversacionId, bot[0].nodo_inicio_id]);

    logger.info(`🤖 Sesión chatbot iniciada: bot=${chatbotId} contacto=${contactoId}`);
    return rows[0];
  } catch (err) {
    logger.error('chatbotService.iniciarSesion:', err.message);
    return null;
  }
}

/**
 * Obtener sesión activa de un contacto
 */
async function obtenerSesionActiva(contactoId) {
  try {
    const { rows } = await query(`
      SELECT s.*, b.nombre AS chatbot_nombre
      FROM chatbot_sesiones s
      JOIN chatbots b ON s.chatbot_id = b.id
      WHERE s.contacto_id=$1 AND s.estado='activo'
      ORDER BY s.created_at DESC LIMIT 1
    `, [contactoId]);
    return rows[0] || null;
  } catch (err) {
    return null;
  }
}

/**
 * Procesar respuesta del usuario dentro de una sesión
 * Retorna { mensajes, finSesion, transferirAgente }
 */
async function procesarRespuesta(sesion, textoUsuario, waService, io) {
  try {
    const { rows: nodoRows } = await query(
      `SELECT * FROM chatbot_nodos WHERE id=$1`, [sesion.nodo_actual_id]
    );
    if (!nodoRows.length) {
      await terminarSesion(sesion.id, 'completado');
      return { finSesion: true, mensajes: [] };
    }

    const nodoActual = nodoRows[0];
    const config = nodoActual.configuracion || {};

    // Buscar siguiente nodo según respuesta
    let siguienteNodoId = null;
    const { rows: conexiones } = await query(`
      SELECT * FROM chatbot_conexiones
      WHERE chatbot_id=$1 AND nodo_origen_id=$2
      ORDER BY created_at ASC
    `, [sesion.chatbot_id, nodoActual.id]);

    for (const conn of conexiones) {
      if (!conn.condicion) { siguienteNodoId = conn.nodo_destino_id; break; }
      const condLower = conn.condicion.toLowerCase();
      const txtLower  = (textoUsuario || '').toLowerCase();
      if (condLower === txtLower || txtLower.includes(condLower)) {
        siguienteNodoId = conn.nodo_destino_id;
        break;
      }
    }

    if (!siguienteNodoId && conexiones.length > 0) {
      // Usar la primera conexión sin condición como fallback
      const fallback = conexiones.find(c => !c.condicion);
      if (fallback) siguienteNodoId = fallback.nodo_destino_id;
    }

    if (!siguienteNodoId) {
      await terminarSesion(sesion.id, 'completado');
      return { finSesion: true, mensajes: [] };
    }

    // Cargar nodo siguiente y ejecutarlo
    const { rows: sigNodoRows } = await query(`SELECT * FROM chatbot_nodos WHERE id=$1`, [siguienteNodoId]);
    if (!sigNodoRows.length) {
      await terminarSesion(sesion.id, 'completado');
      return { finSesion: true, mensajes: [] };
    }

    const sigNodo = sigNodoRows[0];
    const sigConfig = sigNodo.configuracion || {};

    // Actualizar sesión al nuevo nodo
    await query(`
      UPDATE chatbot_sesiones
      SET nodo_actual_id=$1, mensajes_enviados=mensajes_enviados+1, updated_at=NOW()
      WHERE id=$2
    `, [sigNodo.id, sesion.id]);

    // Guardar datos recopilados si el nodo anterior era pregunta
    if (nodoActual.tipo === 'pregunta' && config.guardar_en) {
      const datosActuales = sesion.datos || {};
      datosActuales[config.guardar_en] = textoUsuario;
      await query(`UPDATE chatbot_sesiones SET datos=$1 WHERE id=$2`, [JSON.stringify(datosActuales), sesion.id]);
    }

    const mensajesEnviados = [];

    if (sigNodo.tipo === 'mensaje' || sigNodo.tipo === 'pregunta') {
      const texto = reemplazarVariables(sigConfig.mensaje || '', sesion.datos || {});
      if (texto && sesion.conversacion_id) {
        // Obtener teléfono del contacto
        const { rows: contactoRows } = await query(`SELECT telefono FROM contactos WHERE id=$1`, [sesion.contacto_id]);
        if (contactoRows.length) {
          try {
            await waService.enviarTexto(contactoRows[0].telefono, texto, sesion.conversacion_id, null);
            mensajesEnviados.push(texto);
          } catch(e) { logger.error('chatbot enviar:', e.message); }
        }
      }
    } else if (sigNodo.tipo === 'accion') {
      await ejecutarAccion(sigConfig, sesion, waService);
      if (sigConfig.accion === 'transferir_agente') {
        await terminarSesion(sesion.id, 'transferido');
        return { finSesion: true, transferirAgente: true, mensajes: mensajesEnviados };
      }
    } else if (sigNodo.tipo === 'fin') {
      const textoFin = reemplazarVariables(sigConfig.mensaje || '', sesion.datos || {});
      if (textoFin && sesion.conversacion_id) {
        const { rows: cRows } = await query(`SELECT telefono FROM contactos WHERE id=$1`, [sesion.contacto_id]);
        if (cRows.length) {
          try {
            await waService.enviarTexto(cRows[0].telefono, textoFin, sesion.conversacion_id, null);
            mensajesEnviados.push(textoFin);
          } catch(e) {}
        }
      }
      await terminarSesion(sesion.id, 'completado');
      return { finSesion: true, mensajes: mensajesEnviados };
    }

    // Si hay opciones de respuesta, enviarlas como lista
    if (sigConfig.opciones?.length > 0 && sesion.conversacion_id) {
      const listaOpciones = sigConfig.opciones.map((o, i) => `${i+1}. ${o}`).join('\n');
      const { rows: cRows } = await query(`SELECT telefono FROM contactos WHERE id=$1`, [sesion.contacto_id]);
      if (cRows.length) {
        try {
          await waService.enviarTexto(cRows[0].telefono, listaOpciones, sesion.conversacion_id, null);
        } catch(e) {}
      }
    }

    return { finSesion: false, mensajes: mensajesEnviados };
  } catch (err) {
    logger.error('chatbotService.procesarRespuesta:', err.message);
    return { finSesion: true, mensajes: [] };
  }
}

/**
 * Ejecutar primer nodo de un bot (bienvenida)
 */
async function ejecutarNodoInicio(sesion, waService) {
  try {
    const { rows: nodoRows } = await query(`SELECT * FROM chatbot_nodos WHERE id=$1`, [sesion.nodo_actual_id]);
    if (!nodoRows.length) return;

    const nodo = nodoRows[0];
    const config = nodo.configuracion || {};

    if (['mensaje', 'pregunta'].includes(nodo.tipo)) {
      const texto = reemplazarVariables(config.mensaje || '', {});
      if (texto && sesion.conversacion_id) {
        const { rows: cRows } = await query(`SELECT telefono FROM contactos WHERE id=$1`, [sesion.contacto_id]);
        if (cRows.length) {
          await waService.enviarTexto(cRows[0].telefono, texto, sesion.conversacion_id, null).catch(() => {});
        }
      }
      // Enviar opciones si existen
      if (config.opciones?.length > 0 && sesion.conversacion_id) {
        const lista = config.opciones.map((o, i) => `${i+1}. ${o}`).join('\n');
        const { rows: cRows } = await query(`SELECT telefono FROM contactos WHERE id=$1`, [sesion.contacto_id]);
        if (cRows.length) {
          await waService.enviarTexto(cRows[0].telefono, lista, sesion.conversacion_id, null).catch(() => {});
        }
      }
    }
  } catch (err) {
    logger.error('chatbotService.ejecutarNodoInicio:', err.message);
  }
}

async function ejecutarAccion(config, sesion, waService) {
  if (config.accion === 'etiquetar_contacto' && config.etiqueta) {
    await query(`
      UPDATE contactos SET etiquetas = array_append(etiquetas, $1) WHERE id=$2
    `, [config.etiqueta, sesion.contacto_id]).catch(() => {});
  } else if (config.accion === 'asignar_agente' && config.agente_id) {
    await query(`
      UPDATE conversaciones SET agente_id=$1 WHERE id=$2
    `, [config.agente_id, sesion.conversacion_id]).catch(() => {});
  }
}

async function terminarSesion(sesionId, estado) {
  await query(`
    UPDATE chatbot_sesiones SET estado=$1, updated_at=NOW() WHERE id=$2
  `, [estado, sesionId]).catch(() => {});
}

function reemplazarVariables(texto, datos) {
  return texto.replace(/\{\{(\w+)\}\}/g, (_, key) => datos[key] || `{{${key}}}`);
}

module.exports = {
  detectarChatbot,
  iniciarSesion,
  obtenerSesionActiva,
  procesarRespuesta,
  ejecutarNodoInicio,
  terminarSesion,
};
