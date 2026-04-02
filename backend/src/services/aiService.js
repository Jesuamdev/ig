// src/services/aiService.js
// Servicios de IA: detección de intención, traducción automática, respuesta IA
const { query } = require('../models/db');
const logger = require('../utils/logger');
const axios = require('axios');

// ── Modo demo (sin API key real) ──────────────────────────────────────────────
async function llamarMock(prompt) {
  await new Promise(r => setTimeout(r, 400)); // simula latencia
  if (prompt.includes('JSON') && prompt.includes('intencion')) {
    return JSON.stringify({ intencion: 'consulta_servicio', confianza: 85, idioma: 'es' });
  }
  if (prompt.includes('Traduce')) {
    const match = prompt.match(/:\n\n(.+)$/s);
    return match ? `[traducido] ${match[1].trim()}` : '[traducido]';
  }
  return '¡Hola! Soy el asistente de demostración. Actualmente estoy en modo prueba sin API key real. Configura ANTHROPIC_API_KEY en el archivo .env para activar Claude AI.';
}

let _config = null;

async function obtenerConfig() {
  if (_config && (Date.now() - _config._cacheTime < 60000)) return _config;
  try {
    const { rows } = await query(`SELECT * FROM ia_configuracion WHERE activo=TRUE LIMIT 1`);
    if (rows[0]) {
      _config = rows[0];
      _config._cacheTime = Date.now();
      return _config;
    }
  } catch { /* tabla puede no existir aún */ }

  // Fallback a variables de entorno
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey    = process.env.OPENAI_API_KEY;
  if (anthropicKey && !anthropicKey.startsWith('sk-ant-aqui')) {
    _config = {
      tipo: 'anthropic', api_key: anthropicKey,
      modelo: 'claude-haiku-4-5-20251001',
      funciones: { deteccion_intencion: true, traduccion: true, respuesta_automatica: true },
      _cacheTime: Date.now(),
    };
    return _config;
  }
  if (openaiKey && !openaiKey.startsWith('sk-aqui')) {
    _config = {
      tipo: 'openai', api_key: openaiKey,
      modelo: 'gpt-4o-mini',
      funciones: { deteccion_intencion: true, traduccion: true, respuesta_automatica: true },
      _cacheTime: Date.now(),
    };
    return _config;
  }
  return null;
}

/**
 * Detectar intención de un mensaje
 * Retorna: { intencion, confianza, idioma }
 */
async function detectarIntencion(texto) {
  try {
    const config = await obtenerConfig();
    if (!config?.funciones?.deteccion_intencion) return null;

    const intenciones = [
      'consulta_precio', 'consulta_servicio', 'agendar_cita', 'queja', 'saludo',
      'despedida', 'pago', 'soporte_tecnico', 'informacion_general', 'otro'
    ];

    const prompt = `Analiza el siguiente mensaje y responde SOLO con un JSON con este formato:
{"intencion": "<una de: ${intenciones.join('|')}>", "confianza": <0-100>, "idioma": "<codigo ISO>"}

Mensaje: "${texto}"`;

    const resultado = await llamarOpenAI(config, prompt, 0.1);
    if (!resultado) return null;

    return JSON.parse(resultado);
  } catch (err) {
    logger.error('aiService.detectarIntencion:', err.message);
    return null;
  }
}

/**
 * Traducir un mensaje al idioma destino
 */
async function traducir(texto, idiomaDestino = 'es') {
  try {
    const config = await obtenerConfig();
    if (!config?.funciones?.traduccion) return texto;

    const prompt = `Traduce el siguiente texto al idioma "${idiomaDestino}". Responde SOLO con el texto traducido, sin explicaciones:\n\n${texto}`;

    const resultado = await llamarOpenAI(config, prompt, 0.3);
    return resultado || texto;
  } catch (err) {
    logger.error('aiService.traducir:', err.message);
    return texto;
  }
}

/**
 * Generar respuesta automática basada en la base de conocimiento
 */
async function generarRespuesta(pregunta, contexto = '') {
  try {
    const config = await obtenerConfig();
    // En modo demo (sin config) igual responde con el mock
    if (config && !config?.funciones?.respuesta_automatica) return null;

    // Buscar en base de conocimiento
    const { rows: docs } = await query(`
      SELECT titulo, contenido FROM base_conocimiento
      WHERE activo=TRUE AND (
        titulo ILIKE $1 OR contenido ILIKE $1
      )
      LIMIT 5
    `, [`%${pregunta.substring(0, 50)}%`]);

    const contextoBC = docs.map(d => `${d.titulo}: ${d.contenido}`).join('\n\n');
    const contextoTotal = [contexto, contextoBC].filter(Boolean).join('\n\n');

    const prompt = `Eres un asistente de servicio al cliente. Responde la pregunta del usuario basándote en la siguiente información:

${contextoTotal || 'No hay información específica disponible.'}

Pregunta del cliente: ${pregunta}

Responde de forma amigable y concisa en el mismo idioma del cliente. Si no tienes información suficiente, indica que un agente le ayudará pronto.`;

    return await llamarOpenAI(config, prompt, 0.7);
  } catch (err) {
    logger.error('aiService.generarRespuesta:', err.message);
    return null;
  }
}

async function llamarOpenAI(config, prompt, temperatura = 0.7) {
  if (!config?.api_key) return llamarMock(prompt);

  const headers = { Authorization: `Bearer ${config.api_key}`, 'Content-Type': 'application/json' };
  const modelo = config.modelo || 'gpt-4o-mini';

  // Soporte para Anthropic
  if (config.tipo === 'anthropic') {
    const res = await axios.post('https://api.anthropic.com/v1/messages', {
      model: modelo,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }, {
      headers: { ...headers, 'anthropic-version': '2023-06-01', 'x-api-key': config.api_key },
      timeout: 15000,
    });
    return res.data.content?.[0]?.text || null;
  }

  // OpenAI compatible
  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: modelo,
    temperature: temperatura,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  }, { headers, timeout: 15000 });

  return res.data.choices?.[0]?.message?.content?.trim() || null;
}

module.exports = { detectarIntencion, traducir, generarRespuesta };
