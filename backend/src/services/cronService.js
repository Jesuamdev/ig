// src/services/cronService.js
// Recordatorios automáticos — se ejecuta diariamente
const cron = require('node-cron');
const { query } = require('../models/db');
const emailService = require('./emailService');
const waService    = require('./whatsappService');
const logger       = require('../utils/logger');

function iniciarCron() {
  // Recordatorios de pago — diario 8:00 AM
  cron.schedule('0 8 * * *', async () => {
    logger.info('⏰ Cron: procesando recordatorios de pago...');
    await procesarRecordatorios();
  });

  // Secuencias de seguimiento — cada 15 minutos
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { procesarSecuencias } = require('./secuenciaService');
      await procesarSecuencias();
    } catch (err) { logger.error('Cron secuencias:', err.message); }
  });

  // Campañas programadas — cada 5 minutos
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { procesarCampanasProgramadas } = require('./campanaService');
      await procesarCampanasProgramadas();
    } catch (err) { logger.error('Cron campañas:', err.message); }
  });

  // Recordatorios de citas — diario 7:00 AM (un día antes y el mismo día)
  cron.schedule('0 7 * * *', async () => {
    logger.info('⏰ Cron: procesando recordatorios de citas...');
    await procesarRecordatoriosCitas();
  });

  logger.info('✅ Crons activos: recordatorios (8AM), citas (7AM), secuencias (c/15min), campañas (c/5min)');
}

async function procesarRecordatorios() {
  try {
    const hoy   = new Date();
    const en30d = new Date(hoy); en30d.setDate(en30d.getDate() + 30);

    // Buscar pagos pendientes que venzan en 30, 7 o 1 día
    const { rows: pagos } = await query(`
      SELECT p.*, c.nombre, c.apellido, c.email, c.telefono,
             s.nombre AS servicio_nombre
      FROM pagos p
      JOIN clientes c ON p.cliente_id = c.id
      LEFT JOIN servicios s ON p.servicio_id = s.id
      WHERE p.estado IN ('pendiente','enviado')
        AND p.fecha_vencimiento BETWEEN $1 AND $2
        AND p.recordatorio_enviado = FALSE
    `, [hoy, en30d]);

    let enviados = 0;

    for (const pago of pagos) {
      const dias = Math.ceil((new Date(pago.fecha_vencimiento) - hoy) / 86400000);

      // Solo enviar en días clave
      if (![30, 7, 1].includes(dias)) continue;

      try {
        // Email siempre que tenga email
        if (pago.email) {
          await emailService.enviarRecordatorioPago({ pago, diasRestantes: dias });
        }

        // WhatsApp solo en 7 y 1 día
        if (pago.telefono && dias <= 7) {
          const tel = pago.telefono.replace(/\D/g, '');
          const msg = `⏰ *Recordatorio — CorpEase*\n\nHola ${pago.nombre}, su pago de *$${pago.monto} ${pago.moneda||'USD'}* por _${pago.servicio_nombre||pago.descripcion||'servicios'}_ vence ${dias === 1 ? 'MAÑANA' : `en ${dias} días`}.${pago.link_pago ? `\n\n💳 *Pagar:* ${pago.link_pago}` : ''}\n\nContáctenos si necesita asistencia. 🙏`;
          await waService.enviarTexto(tel, msg);
        }

        // Registrar notificación
        await query(`
          INSERT INTO notificaciones (cliente_id,tipo,titulo,mensaje,canal,enviada)
          VALUES ($1,'pago_recordatorio',$2,$3,'todos',TRUE)
        `, [pago.cliente_id,
            `Recordatorio: pago vence en ${dias} día(s)`,
            `$${pago.monto} ${pago.moneda||'USD'} — ${pago.servicio_nombre||'Servicios'}`]);

        enviados++;
      } catch (e) {
        logger.error(`Error recordatorio pago ${pago.id}: ${e.message}`);
      }
    }

    // Detectar pagos vencidos y actualizar estado
    await query(`
      UPDATE pagos SET estado = 'vencido'
      WHERE estado IN ('pendiente','enviado')
        AND fecha_vencimiento < NOW()
        AND fecha_vencimiento IS NOT NULL
    `);

    // Detectar servicios recurrentes próximos a renovar
    const { rows: recurrentes } = await query(`
      SELECT s.*, c.nombre, c.apellido, c.email, c.telefono
      FROM servicios s
      JOIN clientes c ON s.cliente_id = c.id
      WHERE s.es_recurrente = TRUE
        AND s.estado = 'recurrente'
        AND s.proxima_renovacion BETWEEN $1 AND $2
    `, [hoy, en30d]);

    for (const svc of recurrentes) {
      const dias = Math.ceil((new Date(svc.proxima_renovacion) - hoy) / 86400000);
      if (![30, 14, 7].includes(dias)) continue;
      try {
        if (svc.email) {
          await emailService._send?.({
            to: svc.email,
            subject: `🔄 Renovación próxima — ${svc.nombre}`,
            html: `<p>Hola ${svc.nombre}, su servicio <strong>${svc.nombre}</strong> vence en <strong>${dias} días</strong>. Por favor coordine con nosotros la renovación.</p>`,
          });
        }
      } catch (e) { /* continuar */ }
    }

    logger.info(`✅ Cron: ${enviados} recordatorios enviados`);
  } catch (err) {
    logger.error('Error en cron de recordatorios:', err.message);
  }
}

async function procesarRecordatoriosCitas() {
  try {
    const ahora = new Date();

    // Citas de hoy y de mañana sin recordatorio enviado
    const { rows: citas } = await query(`
      SELECT ct.*,
             cl.nombre AS cliente_nombre, cl.apellido AS cliente_apellido,
             cl.telefono AS cliente_telefono, cl.email AS cliente_email,
             a.nombre AS agente_nombre,
             s.nombre AS servicio_nombre
      FROM citas ct
      LEFT JOIN clientes cl        ON cl.id = ct.cliente_id
      LEFT JOIN agentes a          ON a.id  = ct.agente_id
      LEFT JOIN agenda_servicios s ON s.id  = ct.servicio_id
      WHERE ct.estado IN ('pendiente','confirmada')
        AND ct.cliente_id IS NOT NULL
        AND cl.telefono IS NOT NULL
        AND ct.fecha_inicio BETWEEN NOW() AND NOW() + INTERVAL '25 hours'
    `);

    let enviados = 0;

    for (const cita of citas) {
      try {
        const tel    = cita.cliente_telefono.replace(/\D/g, '');
        const fecha  = new Date(cita.fecha_inicio);
        const esHoy  = fecha.toDateString() === ahora.toDateString();
        const titulo = cita.titulo || cita.servicio_nombre || 'Cita';
        const hora   = fecha.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', hour12: true });
        const diaTxt = esHoy ? 'hoy' : 'mañana';

        const msg = `📅 *Recordatorio de cita — IG Accounting*\n\nHola ${cita.cliente_nombre}, le recordamos que tiene una cita programada para *${diaTxt}*:\n\n🗓 *${titulo}*\n🕐 *${hora}*${cita.agente_nombre ? `\n👤 Asesor: ${cita.agente_nombre}` : ''}\n\nSi necesita reprogramar, contáctenos. ¡Le esperamos! 😊`;

        await waService.enviarTexto(tel, msg);
        enviados++;

        // Notificación en sistema
        await query(`
          INSERT INTO notificaciones (cliente_id, tipo, titulo, mensaje, canal, enviada)
          VALUES ($1, 'recordatorio_cita', $2, $3, 'whatsapp', TRUE)
        `, [cita.cliente_id,
            `Recordatorio: cita ${diaTxt}`,
            `${titulo} — ${hora}`]).catch(() => {});

      } catch (e) {
        logger.error(`Error recordatorio cita ${cita.id}: ${e.message}`);
      }
    }

    logger.info(`✅ Cron citas: ${enviados} recordatorios enviados`);
  } catch (err) {
    logger.error('Error en cron de citas:', err.message);
  }
}

// Permite ejecución manual desde /api/admin/run-reminders
module.exports = { iniciarCron, procesarRecordatorios, procesarRecordatoriosCitas };
