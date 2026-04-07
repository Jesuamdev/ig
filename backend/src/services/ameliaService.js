// src/services/ameliaService.js
// Integración bidireccional con Amelia Booking (WordPress)
// Fuente de verdad de disponibilidad: CRM
const axios  = require('axios');
const { query } = require('../models/db');
const logger = require('../utils/logger');

// ── Leer configuración de Amelia desde la tabla integraciones ────────────────
async function getConfig() {
  const { rows } = await query(
    `SELECT configuracion FROM integraciones WHERE tipo='amelia' AND activa=true LIMIT 1`
  );
  if (!rows.length) return null;
  return rows[0].configuracion; // { wp_url, api_key, employee_map, service_map }
}

function ameliaClient(config) {
  return axios.create({
    baseURL: `${config.wp_url.replace(/\/$/, '')}/wp-json/amelia/v1`,
    headers: { 'Amelia-Api-Key': config.api_key, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
}

// ── CRM → Amelia: crear cita en Amelia ───────────────────────────────────────
async function crearEnAmelia(cita) {
  try {
    const config = await getConfig();
    if (!config) return null;

    const employeeMap = config.employee_map || {};
    const serviceMap  = config.service_map  || {};

    const providerId = cita.agente_id   ? (employeeMap[cita.agente_id]   || null) : null;
    const serviceId  = cita.servicio_id ? (serviceMap[cita.servicio_id]  || null) : null;

    if (!serviceId) {
      logger.warn(`Amelia sync: sin mapeo para servicio ${cita.servicio_id}`);
      return null;
    }

    const bookingStart = formatAmeliaDate(cita.fecha_inicio);
    const bookingEnd   = formatAmeliaDate(cita.fecha_fin);

    const payload = {
      bookingStart,
      bookingEnd,
      serviceId: parseInt(serviceId),
      ...(providerId && { providerId: parseInt(providerId) }),
      // Si el cliente tiene datos disponibles los añadimos
      ...(cita.cliente_email && {
        bookings: [{
          customer: {
            firstName: cita.cliente_nombre || 'Cliente',
            lastName:  cita.cliente_apellido || '',
            email:     cita.cliente_email,
            phone:     cita.cliente_telefono || '',
          },
          status: ameliaStatus(cita.estado),
        }],
      }),
      status: ameliaStatus(cita.estado),
      internalNotes: cita.notas_internas || cita.notas || '',
    };

    const client = ameliaClient(config);
    const res = await client.post('/appointments', payload);
    const ameliaId = res.data?.data?.appointment?.id;

    if (ameliaId) {
      await query(`UPDATE citas SET amelia_appointment_id=$1 WHERE id=$2`, [ameliaId, cita.id]);
      logger.info(`Amelia sync: cita ${cita.id} → Amelia appointment ${ameliaId}`);
    }
    return ameliaId;
  } catch (err) {
    logger.warn(`Amelia crearEnAmelia error: ${err.response?.data?.message || err.message}`);
    return null;
  }
}

// ── CRM → Amelia: actualizar cita en Amelia ──────────────────────────────────
async function actualizarEnAmelia(cita) {
  try {
    if (!cita.amelia_appointment_id) return;
    const config = await getConfig();
    if (!config) return;

    const employeeMap = config.employee_map || {};
    const serviceMap  = config.service_map  || {};
    const providerId  = cita.agente_id   ? (employeeMap[cita.agente_id]  || null) : null;
    const serviceId   = cita.servicio_id ? (serviceMap[cita.servicio_id] || null) : null;

    const payload = {
      bookingStart: formatAmeliaDate(cita.fecha_inicio),
      bookingEnd:   formatAmeliaDate(cita.fecha_fin),
      status:       ameliaStatus(cita.estado),
      internalNotes: cita.notas_internas || cita.notas || '',
      ...(serviceId  && { serviceId:  parseInt(serviceId) }),
      ...(providerId && { providerId: parseInt(providerId) }),
    };

    const client = ameliaClient(config);
    await client.put(`/appointments/${cita.amelia_appointment_id}`, payload);
    logger.info(`Amelia sync: cita ${cita.id} actualizada en Amelia ${cita.amelia_appointment_id}`);
  } catch (err) {
    logger.warn(`Amelia actualizarEnAmelia error: ${err.response?.data?.message || err.message}`);
  }
}

// ── CRM → Amelia: cancelar cita en Amelia ────────────────────────────────────
async function cancelarEnAmelia(ameliaId) {
  try {
    if (!ameliaId) return;
    const config = await getConfig();
    if (!config) return;
    const client = ameliaClient(config);
    await client.put(`/appointments/${ameliaId}`, { status: 'canceled' });
    logger.info(`Amelia sync: appointment ${ameliaId} cancelado`);
  } catch (err) {
    logger.warn(`Amelia cancelarEnAmelia error: ${err.response?.data?.message || err.message}`);
  }
}

// ── Amelia → CRM: procesar webhook ───────────────────────────────────────────
// event: bookingAdded | bookingUpdated | bookingCanceled | bookingRescheduled | appointmentStatusUpdated
async function procesarWebhook(event, payload, creadoPorAgenteId) {
  try {
    const appt = payload.appointment || payload;
    if (!appt) return { ok: false, message: 'Sin datos de cita' };

    const ameliaId    = appt.id;
    const serviceId   = appt.serviceId || appt.service?.id;
    const providerId  = appt.providerId || appt.provider?.id;
    const bookingStart= appt.bookingStart;
    const bookingEnd  = appt.bookingEnd;
    const status      = appt.status;
    const booking     = appt.bookings?.[0];

    const config = await getConfig();
    if (!config) return { ok: false, message: 'Amelia no configurada' };

    // Mapeo inverso: Amelia → CRM
    const employeeMap = config.employee_map || {};
    const serviceMap  = config.service_map  || {};
    const agenteId    = providerId ? invertMap(employeeMap)[String(providerId)] : null;
    const servicioId  = serviceId  ? invertMap(serviceMap)[String(serviceId)]   : null;

    // ¿Ya existe esta cita?
    const { rows: exist } = await query(
      `SELECT id, estado FROM citas WHERE amelia_appointment_id=$1`, [ameliaId]
    );

    const fechaIni = ameliaToISO(bookingStart);
    const fechaFin = ameliaToISO(bookingEnd);
    const estadoCRM = crmStatus(status);

    if (event === 'bookingCanceled' || (event === 'appointmentStatusUpdated' && status === 'canceled')) {
      if (exist.length) {
        await query(`UPDATE citas SET estado='cancelada', updated_at=NOW() WHERE amelia_appointment_id=$1`, [ameliaId]);
        logger.info(`Amelia webhook: cita Amelia ${ameliaId} → cancelada en CRM`);
      }
      return { ok: true, action: 'cancelada' };
    }

    if (event === 'bookingAdded' || (!exist.length && event !== 'bookingCanceled')) {
      if (exist.length) return { ok: true, action: 'ya_existe' }; // evitar duplicado

      // Buscar o crear cliente por email/teléfono del booking
      let clienteId = null;
      if (booking?.customer) {
        const cust = booking.customer;
        const email = cust.email;
        const tel   = cust.phone;
        if (email) {
          const { rows: cli } = await query(`SELECT id FROM clientes WHERE email=$1`, [email]);
          if (cli.length) clienteId = cli[0].id;
        }
        if (!clienteId && tel) {
          const telClean = tel.replace(/\D/g, '');
          const { rows: cli } = await query(
            `SELECT c.id FROM clientes c
             JOIN contactos co ON co.cliente_id=c.id
             WHERE REGEXP_REPLACE(co.telefono,'[^0-9]','','g') LIKE $1 LIMIT 1`,
            [`%${telClean.slice(-9)}`]
          ).catch(() => ({ rows: [] }));
          if (cli.length) clienteId = cli[0].id;
        }
      }

      const titulo = appt.service?.name || `Cita Amelia #${ameliaId}`;

      const { rows: nueva } = await query(`
        INSERT INTO citas (cliente_id, agente_id, servicio_id, titulo, fecha_inicio, fecha_fin,
                           estado, amelia_appointment_id, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
      `, [clienteId, agenteId||null, servicioId||null,
          titulo, fechaIni, fechaFin, estadoCRM, ameliaId,
          creadoPorAgenteId || null]);

      logger.info(`Amelia webhook: nueva cita CRM ${nueva[0].id} ← Amelia ${ameliaId}`);
      return { ok: true, action: 'creada', cita_id: nueva[0].id };
    }

    // bookingUpdated / bookingRescheduled — actualizar existente
    if (exist.length) {
      await query(`
        UPDATE citas SET fecha_inicio=$1, fecha_fin=$2, estado=$3,
          agente_id=COALESCE($4, agente_id),
          servicio_id=COALESCE($5, servicio_id),
          updated_at=NOW()
        WHERE amelia_appointment_id=$6
      `, [fechaIni, fechaFin, estadoCRM, agenteId||null, servicioId||null, ameliaId]);
      logger.info(`Amelia webhook: cita Amelia ${ameliaId} actualizada en CRM`);
      return { ok: true, action: 'actualizada' };
    }

    return { ok: true, action: 'sin_accion' };
  } catch (err) {
    logger.error(`Amelia procesarWebhook: ${err.message}`);
    return { ok: false, message: err.message };
  }
}

// ── Listar servicios y proveedores de Amelia (para configurar mapeo) ─────────
async function listarServiciosAmelia() {
  const config = await getConfig();
  if (!config) return { servicios: [], providers: [] };
  try {
    const client = ameliaClient(config);
    const [svcRes, provRes] = await Promise.all([
      client.get('/services'),
      client.get('/providers'),
    ]);
    return {
      servicios:  (svcRes.data?.data?.categories || []).flatMap(c => c.serviceList || []),
      providers:  provRes.data?.data?.providers || [],
    };
  } catch (err) {
    logger.warn(`Amelia listarServicios: ${err.message}`);
    return { servicios: [], providers: [] };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatAmeliaDate(iso) {
  // Amelia espera "YYYY-MM-DD HH:MM:SS"
  return new Date(iso).toISOString().replace('T', ' ').substring(0, 19);
}

function ameliaToISO(ameliaDate) {
  // "2024-04-10 10:00:00" → ISO
  return new Date(ameliaDate.replace(' ', 'T') + 'Z').toISOString();
}

function ameliaStatus(crmEstado) {
  const map = { confirmada: 'approved', pendiente: 'pending', cancelada: 'canceled', completada: 'approved', no_asistio: 'no-show' };
  return map[crmEstado] || 'pending';
}

function crmStatus(ameliaStatus) {
  const map = { approved: 'confirmada', pending: 'pendiente', canceled: 'cancelada', rejected: 'cancelada', 'no-show': 'no_asistio' };
  return map[ameliaStatus] || 'confirmada';
}

function invertMap(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [String(v), k]));
}

module.exports = {
  crearEnAmelia,
  actualizarEnAmelia,
  cancelarEnAmelia,
  procesarWebhook,
  listarServiciosAmelia,
};
