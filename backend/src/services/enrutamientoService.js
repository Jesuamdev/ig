// src/services/enrutamientoService.js
// Motor de enrutamiento inteligente de conversaciones
const { query } = require('../models/db');
const logger = require('../utils/logger');

/**
 * Evaluar reglas de enrutamiento para una conversación recién creada/actualizada
 */
async function aplicarReglas(conversacion, contacto, mensaje) {
  try {
    const { rows: reglas } = await query(`
      SELECT * FROM reglas_enrutamiento
      WHERE activa=TRUE
      ORDER BY prioridad DESC, created_at ASC
    `);

    if (!reglas.length) return null;

    for (const regla of reglas) {
      const cumple = evaluarCondiciones(regla.condiciones, conversacion, contacto, mensaje);
      if (cumple) {
        await ejecutarAccion(regla, conversacion, contacto);
        logger.info(`🔀 Regla "${regla.nombre}" aplicada a conversación ${conversacion.id}`);
        return regla;
      }
    }
    return null;
  } catch (err) {
    logger.error('enrutamientoService.aplicarReglas:', err.message);
    return null;
  }
}

function evaluarCondiciones(condiciones, conversacion, contacto, mensaje) {
  if (!Array.isArray(condiciones) || condiciones.length === 0) return true;

  return condiciones.every(cond => {
    const { campo, operador, valor } = cond;

    let valorCampo = obtenerValorCampo(campo, conversacion, contacto, mensaje);
    if (valorCampo === undefined || valorCampo === null) return false;

    valorCampo = String(valorCampo).toLowerCase();
    const valorComp = String(valor || '').toLowerCase();

    switch (operador) {
      case 'igual':      return valorCampo === valorComp;
      case 'contiene':   return valorCampo.includes(valorComp);
      case 'empieza':    return valorCampo.startsWith(valorComp);
      case 'no_contiene':return !valorCampo.includes(valorComp);
      case 'existe':     return Boolean(valorCampo);
      default:           return false;
    }
  });
}

function obtenerValorCampo(campo, conversacion, contacto, mensaje) {
  switch (campo) {
    case 'mensaje':         return mensaje?.contenido || '';
    case 'telefono':        return contacto?.telefono || '';
    case 'nombre_contacto': return contacto?.nombre || '';
    case 'pais':            return contacto?.pais || '';
    case 'etiqueta':        return (contacto?.etiquetas || []).join(',');
    case 'estado':          return conversacion?.estado || '';
    case 'tiene_cliente':   return contacto?.cliente_id ? 'si' : 'no';
    default:                return null;
  }
}

async function ejecutarAccion(regla, conversacion, contacto) {
  const config = regla.configuracion || {};

  try {
    switch (regla.accion) {
      case 'asignar_agente':
        if (config.agente_id) {
          await query(`UPDATE conversaciones SET agente_id=$1 WHERE id=$2`, [config.agente_id, conversacion.id]);
        }
        break;

      case 'etiqueta':
        if (config.etiqueta) {
          await query(`
            UPDATE conversaciones
            SET etiquetas = array_append(COALESCE(etiquetas,'{}'), $1)
            WHERE id=$2 AND NOT ($1=ANY(COALESCE(etiquetas,'{}')))
          `, [config.etiqueta, conversacion.id]);
        }
        break;

      case 'respuesta_automatica':
        if (config.mensaje && contacto?.telefono) {
          const waService = require('./whatsappService');
          await waService.enviarTexto(contacto.telefono, config.mensaje, conversacion.id, null).catch(() => {});
        }
        break;

      case 'chatbot':
        if (config.chatbot_id) {
          const chatbotService = require('./chatbotService');
          const sesion = await chatbotService.iniciarSesion(config.chatbot_id, contacto.id, conversacion.id);
          if (sesion) {
            const waService = require('./whatsappService');
            await chatbotService.ejecutarNodoInicio(sesion, waService).catch(() => {});
          }
        }
        break;
    }
  } catch (err) {
    logger.error(`ejecutarAccion regla ${regla.id}: ${err.message}`);
  }
}

module.exports = { aplicarReglas };
