// src/controllers/citasController.js
const { query, withTransaction } = require('../models/db');
const logger = require('../utils/logger');

// Timezone Miami = America/New_York (ET)
// Todos los timestamps se almacenan en UTC, el frontend muestra en ET

// ── GET /api/citas — Listar citas en rango ───────────────────────────────────
async function listarCitas(req, res) {
  const { fecha_inicio, fecha_fin, agente_id, cliente_id } = req.query;
  try {
    const conds = [];
    const vals  = [];
    let   i     = 1;

    if (fecha_inicio) { conds.push(`c.fecha_inicio >= $${i++}`); vals.push(fecha_inicio); }
    if (fecha_fin)    { conds.push(`c.fecha_inicio <= $${i++}`); vals.push(fecha_fin); }
    if (agente_id)    { conds.push(`c.agente_id = $${i++}`);     vals.push(agente_id); }
    if (cliente_id)   { conds.push(`c.cliente_id = $${i++}`);    vals.push(cliente_id); }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows } = await query(`
      SELECT c.*,
        ag.nombre  AS agente_nombre,
        cl.nombre  AS cliente_nombre,
        cl.apellido AS cliente_apellido,
        cl.email   AS cliente_email,
        cl.telefono AS cliente_telefono,
        s.nombre   AS servicio_nombre,
        s.color    AS servicio_color,
        s.duracion_minutos AS servicio_duracion
      FROM citas c
      LEFT JOIN agentes ag         ON ag.id = c.agente_id
      LEFT JOIN clientes cl        ON cl.id = c.cliente_id
      LEFT JOIN agenda_servicios s ON s.id  = c.servicio_id
      ${where}
      ORDER BY c.fecha_inicio ASC
    `, vals);

    res.json(rows);
  } catch (err) {
    logger.error('listarCitas:', err.message);
    res.status(500).json({ message: err.message });
  }
}

// ── GET /api/citas/:id ────────────────────────────────────────────────────────
async function obtenerCita(req, res) {
  try {
    const { rows } = await query(`
      SELECT c.*,
        ag.nombre  AS agente_nombre,
        cl.nombre  AS cliente_nombre,
        cl.apellido AS cliente_apellido,
        cl.email   AS cliente_email,
        cl.telefono AS cliente_telefono,
        s.nombre   AS servicio_nombre,
        s.color    AS servicio_color,
        s.duracion_minutos AS servicio_duracion
      FROM citas c
      LEFT JOIN agentes ag         ON ag.id = c.agente_id
      LEFT JOIN clientes cl        ON cl.id = c.cliente_id
      LEFT JOIN agenda_servicios s ON s.id  = c.servicio_id
      WHERE c.id = $1
    `, [req.params.id]);

    if (!rows.length) return res.status(404).json({ message: 'Cita no encontrada' });
    res.json(rows[0]);
  } catch (err) {
    logger.error('obtenerCita:', err.message);
    res.status(500).json({ message: err.message });
  }
}

// ── POST /api/citas — Crear cita ─────────────────────────────────────────────
async function crearCita(req, res) {
  const { cliente_id, agente_id, servicio_id, titulo, fecha_inicio, fecha_fin,
          estado = 'confirmada', notas, notas_internas, color, tipo = 'cita' } = req.body;

  if (!fecha_inicio || !fecha_fin) return res.status(400).json({ message: 'fecha_inicio y fecha_fin son requeridos' });

  try {
    // Verificar solapamiento
    const overlap = await query(`
      SELECT id FROM citas
      WHERE agente_id = $1
        AND estado NOT IN ('cancelada')
        AND tsrange(fecha_inicio, fecha_fin) && tsrange($2::timestamp, $3::timestamp)
    `, [agente_id, fecha_inicio, fecha_fin]);

    if (overlap.rows.length) {
      return res.status(409).json({ message: 'Ya existe una cita en ese horario para este agente' });
    }

    const { rows } = await query(`
      INSERT INTO citas (cliente_id, agente_id, servicio_id, titulo, fecha_inicio, fecha_fin,
                         estado, notas, notas_internas, color, tipo, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [cliente_id||null, agente_id||null, servicio_id||null,
        titulo||null, fecha_inicio, fecha_fin,
        estado, notas||null, notas_internas||null,
        color||null, tipo, req.user.id]);

    // Registrar en actividad del cliente
    if (cliente_id) {
      await query(
        `INSERT INTO actividad (agente_id, cliente_id, accion, detalles) VALUES ($1,$2,'cita.creada',$3)`,
        [req.user.id, cliente_id, JSON.stringify({ cita_id: rows[0].id, fecha: fecha_inicio })]
      ).catch(() => {});
    }

    logger.info(`Cita creada: ${rows[0].id} → ${fecha_inicio}`);
    res.status(201).json(rows[0]);
  } catch (err) {
    logger.error('crearCita:', err.message);
    res.status(500).json({ message: err.message });
  }
}

// ── PUT /api/citas/:id ────────────────────────────────────────────────────────
async function actualizarCita(req, res) {
  const { id } = req.params;
  const { cliente_id, agente_id, servicio_id, titulo, fecha_inicio, fecha_fin,
          estado, notas, notas_internas, color, tipo } = req.body;

  try {
    const campos = [];
    const vals   = [];
    let   i      = 1;

    const set = (col, val) => { if (val !== undefined) { campos.push(`${col}=$${i++}`); vals.push(val); } };

    set('cliente_id',     cliente_id);
    set('agente_id',      agente_id);
    set('servicio_id',    servicio_id);
    set('titulo',         titulo);
    set('fecha_inicio',   fecha_inicio);
    set('fecha_fin',      fecha_fin);
    set('estado',         estado);
    set('notas',          notas);
    set('notas_internas', notas_internas);
    set('color',          color);
    set('tipo',           tipo);
    campos.push(`updated_at=NOW()`);

    if (campos.length === 1) return res.status(400).json({ message: 'Nada que actualizar' });

    vals.push(id);
    const { rows } = await query(
      `UPDATE citas SET ${campos.join(',')} WHERE id=$${i} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ message: 'Cita no encontrada' });

    if (estado && rows[0].cliente_id) {
      await query(
        `INSERT INTO actividad (agente_id, cliente_id, accion, detalles) VALUES ($1,$2,$3,$4)`,
        [req.user.id, rows[0].cliente_id, `cita.${estado}`, JSON.stringify({ cita_id: id })]
      ).catch(() => {});
    }

    res.json(rows[0]);
  } catch (err) {
    logger.error('actualizarCita:', err.message);
    res.status(500).json({ message: err.message });
  }
}

// ── DELETE /api/citas/:id ─────────────────────────────────────────────────────
async function eliminarCita(req, res) {
  try {
    const { rows } = await query(`DELETE FROM citas WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Cita no encontrada' });
    res.json({ success: true });
  } catch (err) {
    logger.error('eliminarCita:', err.message);
    res.status(500).json({ message: err.message });
  }
}

// ── GET /api/citas/slots — Slots disponibles para una fecha ──────────────────
async function obtenerSlots(req, res) {
  const { fecha, agente_id, servicio_id } = req.query;
  if (!fecha || !agente_id) return res.status(400).json({ message: 'fecha y agente_id son requeridos' });

  try {
    // Obtener duración del servicio
    let duracion = 60;
    let intervalo = 30;
    if (servicio_id) {
      const { rows: svc } = await query(
        `SELECT duracion_minutos, intervalo_minutos FROM agenda_servicios WHERE id=$1`, [servicio_id]
      );
      if (svc.length) { duracion = svc[0].duracion_minutos; intervalo = svc[0].intervalo_minutos; }
    }

    // Día de la semana (0=domingo...6=sábado) en fecha dada
    const d = new Date(fecha + 'T00:00:00');
    const diaSemana = d.getDay();

    // Disponibilidad del agente ese día
    const { rows: disp } = await query(
      `SELECT hora_inicio, hora_fin FROM agenda_disponibilidad
       WHERE agente_id=$1 AND dia_semana=$2 AND activo=true`,
      [agente_id, diaSemana]
    );
    if (!disp.length) return res.json({ slots: [], mensaje: 'No hay disponibilidad ese día' });

    const horaIni = disp[0].hora_inicio.substring(0, 5); // "08:00"
    const horaFin = disp[0].hora_fin.substring(0, 5);    // "17:00"

    // Citas existentes ese día
    const { rows: citasExist } = await query(`
      SELECT fecha_inicio, fecha_fin FROM citas
      WHERE agente_id=$1
        AND estado NOT IN ('cancelada')
        AND fecha_inicio::date = $2::date
    `, [agente_id, fecha]);

    // Bloqueos ese día
    const { rows: bloqueos } = await query(`
      SELECT fecha_inicio, fecha_fin FROM agenda_bloqueos
      WHERE agente_id=$1
        AND fecha_inicio::date <= $2::date
        AND fecha_fin::date >= $2::date
    `, [agente_id, fecha]);

    // Generar slots
    const slots = [];
    const [hIni, mIni] = horaIni.split(':').map(Number);
    const [hFin, mFin] = horaFin.split(':').map(Number);

    let cur = hIni * 60 + mIni;
    const end = hFin * 60 + mFin;

    while (cur + duracion <= end) {
      const slotIni = `${fecha}T${String(Math.floor(cur/60)).padStart(2,'0')}:${String(cur%60).padStart(2,'0')}:00`;
      const slotFin = `${fecha}T${String(Math.floor((cur+duracion)/60)).padStart(2,'0')}:${String((cur+duracion)%60).padStart(2,'0')}:00`;

      // Verificar si está ocupado
      const ocupado = citasExist.some(c => {
        const ci = new Date(c.fecha_inicio).getTime();
        const cf = new Date(c.fecha_fin).getTime();
        const si = new Date(slotIni).getTime();
        const sf = new Date(slotFin).getTime();
        return si < cf && sf > ci;
      });

      const bloqueado = bloqueos.some(b => {
        const bi = new Date(b.fecha_inicio).getTime();
        const bf = new Date(b.fecha_fin).getTime();
        const si = new Date(slotIni).getTime();
        const sf = new Date(slotFin).getTime();
        return si < bf && sf > bi;
      });

      slots.push({
        inicio:     slotIni,
        fin:        slotFin,
        hora:       `${String(Math.floor(cur/60)).padStart(2,'0')}:${String(cur%60).padStart(2,'0')}`,
        disponible: !ocupado && !bloqueado,
      });

      cur += intervalo;
    }

    res.json({ slots, duracion, intervalo });
  } catch (err) {
    logger.error('obtenerSlots:', err.message);
    res.status(500).json({ message: err.message });
  }
}

// ── SERVICIOS ─────────────────────────────────────────────────────────────────
async function listarServicios(req, res) {
  try {
    const { rows } = await query(`SELECT * FROM agenda_servicios WHERE activo=true ORDER BY nombre`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function crearServicio(req, res) {
  const { nombre, duracion_minutos = 60, intervalo_minutos = 30, color = '#7C5CFC', descripcion, precio = 0 } = req.body;
  if (!nombre) return res.status(400).json({ message: 'nombre es requerido' });
  try {
    const { rows } = await query(
      `INSERT INTO agenda_servicios (nombre, duracion_minutos, intervalo_minutos, color, descripcion, precio)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [nombre, duracion_minutos, intervalo_minutos, color, descripcion||null, precio]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function actualizarServicio(req, res) {
  const { nombre, duracion_minutos, intervalo_minutos, color, descripcion, precio, activo } = req.body;
  try {
    const campos = []; const vals = []; let i = 1;
    const set = (c,v) => { if (v !== undefined) { campos.push(`${c}=$${i++}`); vals.push(v); } };
    set('nombre', nombre); set('duracion_minutos', duracion_minutos);
    set('intervalo_minutos', intervalo_minutos); set('color', color);
    set('descripcion', descripcion); set('precio', precio); set('activo', activo);
    if (!campos.length) return res.status(400).json({ message: 'Nada que actualizar' });
    vals.push(req.params.id);
    const { rows } = await query(`UPDATE agenda_servicios SET ${campos.join(',')} WHERE id=$${i} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ message: 'Servicio no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function eliminarServicio(req, res) {
  try {
    await query(`UPDATE agenda_servicios SET activo=false WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// ── DISPONIBILIDAD ────────────────────────────────────────────────────────────
async function obtenerDisponibilidad(req, res) {
  const agente_id = req.query.agente_id || req.user.id;
  try {
    const { rows } = await query(
      `SELECT * FROM agenda_disponibilidad WHERE agente_id=$1 ORDER BY dia_semana`,
      [agente_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function guardarDisponibilidad(req, res) {
  const { horarios } = req.body; // [{ dia_semana, hora_inicio, hora_fin, activo }]
  if (!Array.isArray(horarios)) return res.status(400).json({ message: 'horarios debe ser array' });
  try {
    for (const h of horarios) {
      await query(`
        INSERT INTO agenda_disponibilidad (agente_id, dia_semana, hora_inicio, hora_fin, activo)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (agente_id, dia_semana)
        DO UPDATE SET hora_inicio=$3, hora_fin=$4, activo=$5
      `, [req.user.id, h.dia_semana, h.hora_inicio, h.hora_fin, h.activo !== false]);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// ── BLOQUEOS ──────────────────────────────────────────────────────────────────
async function listarBloqueos(req, res) {
  try {
    const { rows } = await query(
      `SELECT * FROM agenda_bloqueos WHERE agente_id=$1 ORDER BY fecha_inicio`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function crearBloqueo(req, res) {
  const { fecha_inicio, fecha_fin, motivo } = req.body;
  if (!fecha_inicio || !fecha_fin) return res.status(400).json({ message: 'fecha_inicio y fecha_fin requeridos' });
  try {
    const { rows } = await query(
      `INSERT INTO agenda_bloqueos (agente_id, fecha_inicio, fecha_fin, motivo) VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.user.id, fecha_inicio, fecha_fin, motivo||null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function eliminarBloqueo(req, res) {
  try {
    await query(`DELETE FROM agenda_bloqueos WHERE id=$1 AND agente_id=$2`, [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

module.exports = {
  listarCitas, obtenerCita, crearCita, actualizarCita, eliminarCita,
  obtenerSlots,
  listarServicios, crearServicio, actualizarServicio, eliminarServicio,
  obtenerDisponibilidad, guardarDisponibilidad,
  listarBloqueos, crearBloqueo, eliminarBloqueo,
};
