// src/services/chatbotService.js
// Motor de ejecución de chatbots visuales — soporte completo de 11 tipos de nodo
const { query } = require('../models/db');
const logger = require('../utils/logger');

// ── Detección de chatbot activo ───────────────────────────────────────────────
async function detectarChatbot(texto, contactoId, numeroId) {
  try {
    const { rows: bots } = await query(`
      SELECT * FROM chatbots
      WHERE activo = TRUE AND (numero_id IS NULL OR numero_id = $1)
      ORDER BY created_at ASC
    `, [numeroId || null]);

    for (const bot of bots) {
      if (bot.trigger_tipo === 'todos' || bot.trigger_tipo === 'siempre') return bot;
      if (bot.trigger_tipo === 'nuevo_contacto') {
        const { rows } = await query(
          `SELECT COUNT(*) AS total FROM mensajes m
           JOIN conversaciones c ON m.conversacion_id = c.id
           WHERE c.contacto_id = $1`, [contactoId]
        );
        if (parseInt(rows[0].total) <= 1) return bot;
      }
      if (bot.trigger_tipo === 'palabras' && bot.trigger_palabras?.length) {
        const textoLower = (texto || '').toLowerCase();
        if (bot.trigger_palabras.some(p => textoLower.includes(p.toLowerCase()))) return bot;
      }
    }
    return null;
  } catch (err) {
    logger.error('chatbotService.detectarChatbot:', err.message);
    return null;
  }
}

// ── Iniciar sesión de chatbot ─────────────────────────────────────────────────
async function iniciarSesion(chatbotId, contactoId, conversacionId) {
  try {
    const { rows: bot } = await query(`SELECT * FROM chatbots WHERE id=$1`, [chatbotId]);
    if (!bot.length || !bot[0].nodo_inicio_id) return null;

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

// ── Obtener sesión activa ─────────────────────────────────────────────────────
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
  } catch { return null; }
}

// ── Ejecutar nodo de inicio (primer mensaje del bot) ──────────────────────────
async function ejecutarNodoInicio(sesion, waService) {
  try {
    const { rows } = await query(`SELECT * FROM chatbot_nodos WHERE id=$1`, [sesion.nodo_actual_id]);
    if (!rows.length) return;
    await ejecutarNodo(rows[0], sesion, '', waService);
  } catch (err) {
    logger.error('chatbotService.ejecutarNodoInicio:', err.message);
  }
}

// ── Procesar respuesta del usuario ────────────────────────────────────────────
async function procesarRespuesta(sesion, textoUsuario, waService, io) {
  try {
    const { rows: nodoRows } = await query(`SELECT * FROM chatbot_nodos WHERE id=$1`, [sesion.nodo_actual_id]);
    if (!nodoRows.length) { await terminarSesion(sesion.id, 'completado'); return { finSesion: true }; }

    const nodoActual = nodoRows[0];
    const config = nodoActual.configuracion || {};

    // Guardar respuesta si el nodo actual esperaba input del usuario
    let datosActualizados = sesion.datos || {};
    if (nodoActual.tipo === 'pregunta' && config.guardar_en) {
      datosActualizados[config.guardar_en] = textoUsuario;
      await query(`UPDATE chatbot_sesiones SET datos=$1 WHERE id=$2`, [JSON.stringify(datosActualizados), sesion.id]);
      sesion.datos = datosActualizados;
    }

    // Evaluar conexiones para encontrar el siguiente nodo
    const siguienteNodoId = await evaluarConexiones(sesion, nodoActual, textoUsuario);
    if (!siguienteNodoId) {
      await terminarSesion(sesion.id, 'completado');
      return { finSesion: true };
    }

    // Encadenar ejecución de nodos hasta llegar a uno que espere input del usuario
    return await encadenarNodos(siguienteNodoId, sesion, textoUsuario, waService, io);

  } catch (err) {
    logger.error('chatbotService.procesarRespuesta:', err.message);
    return { finSesion: true };
  }
}

// ── Encadenar ejecución de nodos ──────────────────────────────────────────────
async function encadenarNodos(nodoId, sesion, textoUsuario, waService, io, profundidad = 0) {
  if (profundidad > 20) { // Evitar loops infinitos
    await terminarSesion(sesion.id, 'completado');
    return { finSesion: true };
  }

  const { rows: nodoRows } = await query(`SELECT * FROM chatbot_nodos WHERE id=$1`, [nodoId]);
  if (!nodoRows.length) { await terminarSesion(sesion.id, 'completado'); return { finSesion: true }; }

  const nodo = nodoRows[0];

  // Actualizar nodo actual en sesión
  await query(`
    UPDATE chatbot_sesiones SET nodo_actual_id=$1, mensajes_enviados=mensajes_enviados+1, updated_at=NOW()
    WHERE id=$2
  `, [nodo.id, sesion.id]);
  sesion.nodo_actual_id = nodo.id;

  // Ejecutar el nodo
  const resultado = await ejecutarNodo(nodo, sesion, textoUsuario, waService);

  if (resultado.finSesion) {
    await terminarSesion(sesion.id, resultado.transferir ? 'transferido' : 'completado');
    return resultado;
  }

  // Si el nodo espera input del usuario, detener encadenamiento
  if (resultado.esperarInput) {
    return { finSesion: false };
  }

  // Avanzar al siguiente nodo automáticamente
  const siguienteId = resultado.siguienteNodoId || await evaluarConexiones(sesion, nodo, textoUsuario);
  if (!siguienteId) {
    await terminarSesion(sesion.id, 'completado');
    return { finSesion: true };
  }

  return encadenarNodos(siguienteId, sesion, textoUsuario, waService, io, profundidad + 1);
}

// ── Ejecutar un nodo individual ───────────────────────────────────────────────
async function ejecutarNodo(nodo, sesion, textoUsuario, waService) {
  const config = nodo.configuracion || {};
  const datos  = sesion.datos || {};

  try {
    switch (nodo.tipo) {

      // ── INICIO: igual que mensaje, no espera input ──────────────────────────
      case 'inicio':
      case 'mensaje': {
        const texto = reemplazarVariables(config.mensaje || '', datos);
        if (texto) await enviarTextoConOpciones(texto, config.opciones, sesion, waService);
        return { esperarInput: false };
      }

      // ── PREGUNTA: envía y espera respuesta del usuario ──────────────────────
      case 'pregunta': {
        const texto = reemplazarVariables(config.mensaje || '', datos);
        if (texto) await enviarTextoConOpciones(texto, config.opciones, sesion, waService);
        return { esperarInput: true };
      }

      // ── CLAUDE AI: genera respuesta con IA ─────────────────────────────────
      case 'claude': {
        try {
          const aiService = require('./aiService');
          const sistema = reemplazarVariables(config.sistema || '', datos);
          const pregunta = textoUsuario || config.pregunta_default || '¿En qué puedo ayudarte?';
          const respuesta = await aiService.generarRespuesta(pregunta, sistema);
          if (respuesta) await enviarMensaje(respuesta, sesion, waService);

          // Guardar respuesta en datos si se configuró
          if (config.guardar_en && respuesta) {
            datos[config.guardar_en] = respuesta;
            await query(`UPDATE chatbot_sesiones SET datos=$1 WHERE id=$2`, [JSON.stringify(datos), sesion.id]);
            sesion.datos = datos;
          }
        } catch (e) {
          logger.warn('chatbot claude node:', e.message);
          await enviarMensaje('En este momento no puedo responder con IA. Un agente te atenderá pronto.', sesion, waService);
        }
        return { esperarInput: false };
      }

      // ── DETECTAR INTENCIÓN: clasifica y guarda en datos ─────────────────────
      case 'ia_intent': {
        try {
          const aiService = require('./aiService');
          const resultado = await aiService.detectarIntencion(textoUsuario || '');
          if (resultado?.intencion) {
            datos['intencion'] = resultado.intencion;
            datos['confianza'] = resultado.confianza;
            datos['idioma']    = resultado.idioma;
            await query(`UPDATE chatbot_sesiones SET datos=$1 WHERE id=$2`, [JSON.stringify(datos), sesion.id]);
            sesion.datos = datos;
          }
        } catch (e) { logger.warn('chatbot ia_intent:', e.message); }
        // La siguiente conexión se evaluará contra datos.intencion
        return { esperarInput: false };
      }

      // ── TRADUCIR: traduce el mensaje del usuario ────────────────────────────
      case 'traducir': {
        try {
          const aiService = require('./aiService');
          const idioma = config.idioma_destino || 'es';
          const traducido = await aiService.traducir(textoUsuario || '', idioma);
          datos['texto_traducido'] = traducido;
          await query(`UPDATE chatbot_sesiones SET datos=$1 WHERE id=$2`, [JSON.stringify(datos), sesion.id]);
          sesion.datos = datos;
        } catch (e) { logger.warn('chatbot traducir:', e.message); }
        return { esperarInput: false };
      }

      // ── CONDICIÓN: evalúa datos de sesión y elige camino ───────────────────
      case 'condicion': {
        // El routing lo hace evaluarConexiones basándose en datos de sesión
        // Este nodo en sí no envía nada
        return { esperarInput: false };
      }

      // ── ASIGNAR AGENTE: transfiere a humano ─────────────────────────────────
      case 'asignar': {
        const agenteId = config.agente_id;
        if (agenteId && sesion.conversacion_id) {
          await query(`UPDATE conversaciones SET agente_id=$1 WHERE id=$2`, [agenteId, sesion.conversacion_id]);
        }
        const msgTransfer = reemplazarVariables(config.mensaje || 'Te estamos conectando con un agente. ¡Un momento! 👤', datos);
        await enviarMensaje(msgTransfer, sesion, waService);
        return { finSesion: true, transferir: true };
      }

      // ── ETIQUETAR: agrega etiqueta al contacto o conversación ───────────────
      case 'etiquetar': {
        if (config.etiqueta) {
          if (config.objetivo === 'conversacion' && sesion.conversacion_id) {
            await query(`
              UPDATE conversaciones
              SET etiquetas = array_append(COALESCE(etiquetas,'{}'), $1)
              WHERE id=$2 AND NOT ($1=ANY(COALESCE(etiquetas,'{}')))
            `, [config.etiqueta, sesion.conversacion_id]).catch(() => {});
          } else {
            await query(`
              UPDATE contactos SET etiquetas = array_append(COALESCE(etiquetas,'{}'), $1)
              WHERE id=$2 AND NOT ($1=ANY(COALESCE(etiquetas,'{}')))
            `, [config.etiqueta, sesion.contacto_id]).catch(() => {});
          }
        }
        return { esperarInput: false };
      }

      // ── ESPERAR: pausa N segundos (simplificado) ────────────────────────────
      case 'esperar': {
        const segundos = Math.min(parseInt(config.segundos) || 2, 10);
        await new Promise(r => setTimeout(r, segundos * 1000));
        return { esperarInput: false };
      }

      // ── FIN: cierra la conversación del bot ─────────────────────────────────
      case 'fin': {
        const texto = reemplazarVariables(config.mensaje || 'Gracias por contactarnos. ¡Hasta pronto! 😊', datos);
        await enviarMensaje(texto, sesion, waService);
        return { finSesion: true };
      }

      default:
        return { esperarInput: false };
    }
  } catch (err) {
    logger.error(`chatbot nodo ${nodo.tipo}:`, err.message);
    return { esperarInput: false };
  }
}

// ── Evaluar conexiones para encontrar el siguiente nodo ───────────────────────
async function evaluarConexiones(sesion, nodoActual, textoUsuario) {
  const { rows: conexiones } = await query(`
    SELECT * FROM chatbot_conexiones
    WHERE chatbot_id=$1 AND nodo_origen_id=$2
    ORDER BY created_at ASC
  `, [sesion.chatbot_id, nodoActual.id]);

  if (!conexiones.length) return null;

  const datos = sesion.datos || {};

  for (const conn of conexiones) {
    if (!conn.condicion) {
      return conn.nodo_destino_id; // conexión sin condición → siempre aplica
    }

    const condicion = conn.condicion.toLowerCase().trim();

    // Para nodo ia_intent: comparar contra la intención detectada
    if (nodoActual.tipo === 'ia_intent') {
      const intencion = (datos.intencion || '').toLowerCase();
      if (intencion === condicion || intencion.includes(condicion)) return conn.nodo_destino_id;
      continue;
    }

    // Para nodo condicion: comparar contra datos de sesión
    if (nodoActual.tipo === 'condicion') {
      const config = nodoActual.configuracion || {};
      const campo = config.campo || config.variable || 'opcion';
      const valorDato = String(datos[campo] || '').toLowerCase();
      if (valorDato === condicion || valorDato.includes(condicion)) return conn.nodo_destino_id;
      continue;
    }

    // Default: comparar contra texto del usuario
    const txtLower = (textoUsuario || '').toLowerCase();
    if (txtLower === condicion || txtLower.includes(condicion)) return conn.nodo_destino_id;
  }

  // Fallback: primera conexión sin condición
  const fallback = conexiones.find(c => !c.condicion);
  return fallback?.nodo_destino_id || null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function enviarTextoConOpciones(texto, opciones, sesion, waService) {
  await enviarMensaje(texto, sesion, waService);
  if (opciones?.length > 0) {
    const lista = opciones.map((o, i) => `${i + 1}. ${o}`).join('\n');
    await enviarMensaje(lista, sesion, waService);
  }
}

async function enviarMensaje(texto, sesion, waService) {
  if (!texto || !sesion.conversacion_id) return;
  try {
    const { rows } = await query(`SELECT telefono FROM contactos WHERE id=$1`, [sesion.contacto_id]);
    if (rows.length) await waService.enviarTexto(rows[0].telefono, texto, sesion.conversacion_id, null);
  } catch (e) { logger.error('chatbot enviarMensaje:', e.message); }
}

function reemplazarVariables(texto, datos) {
  return texto.replace(/\{\{(\w+)\}\}/g, (_, key) => datos[key] !== undefined ? datos[key] : `{{${key}}}`);
}

async function terminarSesion(sesionId, estado) {
  await query(`UPDATE chatbot_sesiones SET estado=$1, updated_at=NOW() WHERE id=$2`, [estado, sesionId]).catch(() => {});
}

module.exports = {
  detectarChatbot,
  iniciarSesion,
  obtenerSesionActiva,
  procesarRespuesta,
  ejecutarNodoInicio,
  terminarSesion,
};
