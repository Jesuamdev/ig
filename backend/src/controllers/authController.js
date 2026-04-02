// src/controllers/authController.js
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { query } = require('../models/db');
const logger = require('../utils/logger');

function generarToken(id, tipo, rol) {
  return jwt.sign(
    { id, tipo, rol },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// POST /api/auth/login  — agentes del panel
async function loginAgente(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: 'Email y contraseña requeridos' });

    const { rows } = await query(
      `SELECT id, nombre, email, password, rol, estado, avatar_url FROM agentes WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    const agente = rows[0];

    if (!agente || agente.estado !== 'activo')
      return res.status(401).json({ message: 'Credenciales inválidas' });

    const ok = await bcrypt.compare(password, agente.password);
    if (!ok) return res.status(401).json({ message: 'Credenciales inválidas' });

    const token = generarToken(agente.id, 'agente', agente.rol);
    logger.info(`Login agente: ${agente.email}`);

    res.json({
      token,
      usuario: { id: agente.id, nombre: agente.nombre, email: agente.email, rol: agente.rol, avatar_url: agente.avatar_url },
    });
  } catch (err) {
    logger.error('loginAgente:', err.message);
    res.status(500).json({ message: 'Error del servidor' });
  }
}

// POST /api/auth/cliente/login  — clientes del portal
async function loginCliente(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ message: 'Email y contraseña requeridos' });

    const { rows } = await query(
      `SELECT id, nombre, apellido, email, password, estado, portal_activo FROM clientes WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    const cliente = rows[0];

    if (!cliente || cliente.estado !== 'activo')
      return res.status(401).json({ message: 'Credenciales inválidas' });

    if (!cliente.portal_activo)
      return res.status(403).json({ message: 'Tu acceso al portal no está activado. Contacta a tu asesor.' });

    if (!cliente.password)
      return res.status(401).json({ message: 'No tienes contraseña configurada. Contacta a tu asesor.' });

    const ok = await bcrypt.compare(password, cliente.password);
    if (!ok) return res.status(401).json({ message: 'Credenciales inválidas' });

    // Registrar primer login
    await query(
      `UPDATE clientes SET primer_login = COALESCE(primer_login, NOW()) WHERE id = $1`,
      [cliente.id]
    );

    const token = generarToken(cliente.id, 'cliente', 'cliente');
    logger.info(`Login cliente: ${cliente.email}`);

    res.json({
      token,
      usuario: { id: cliente.id, nombre: cliente.nombre, apellido: cliente.apellido, email: cliente.email, tipo: 'cliente' },
    });
  } catch (err) {
    logger.error('loginCliente:', err.message);
    res.status(500).json({ message: 'Error del servidor' });
  }
}

// GET /api/auth/perfil
async function perfil(req, res) {
  res.json({ usuario: req.user });
}

// PUT /api/auth/cambiar-password
async function cambiarPassword(req, res) {
  try {
    const { password_actual, password_nuevo } = req.body;
    if (!password_actual || !password_nuevo)
      return res.status(400).json({ message: 'Faltan campos' });

    const tabla = req.esCliente ? 'clientes' : 'agentes';
    const { rows } = await query(`SELECT password FROM ${tabla} WHERE id = $1`, [req.user.id]);

    const ok = await bcrypt.compare(password_actual, rows[0]?.password || '');
    if (!ok) return res.status(400).json({ message: 'Contraseña actual incorrecta' });

    const hash = await bcrypt.hash(password_nuevo, 12);
    await query(`UPDATE ${tabla} SET password = $1 WHERE id = $2`, [hash, req.user.id]);

    res.json({ message: 'Contraseña actualizada' });
  } catch (err) {
    logger.error('cambiarPassword:', err.message);
    res.status(500).json({ message: 'Error del servidor' });
  }
}

// POST /api/auth/forgot-password
async function forgotPassword(req, res) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email requerido' });

    // Buscar en agentes primero, luego en clientes
    let user = null;
    let tabla = null;

    const { rows: agentes } = await query(`SELECT id, nombre, email FROM agentes WHERE email=$1 AND estado='activo'`, [email.toLowerCase().trim()]);
    if (agentes.length) { user = agentes[0]; tabla = 'agentes'; }

    if (!user) {
      const { rows: clientes } = await query(`SELECT id, nombre, email FROM clientes WHERE email=$1 AND estado='activo'`, [email.toLowerCase().trim()]);
      if (clientes.length) { user = clientes[0]; tabla = 'clientes'; }
    }

    // Siempre responder OK (no revelar si existe el email)
    if (!user) return res.json({ message: 'Si el email existe, recibirás un código de recuperación' });

    // Generar código de 6 dígitos
    const codigo = Math.floor(100000 + Math.random() * 900000).toString();
    const expira = new Date(Date.now() + 30 * 60 * 1000); // 30 minutos

    await query(`
      INSERT INTO password_resets (email, tabla, codigo, expira_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (email) DO UPDATE SET codigo=$3, expira_at=$4, usado=FALSE, created_at=NOW()
    `, [user.email, tabla, codigo, expira]);

    logger.info(`🔑 Código de recuperación para ${user.email}: ${codigo}`);
    // En producción aquí se enviaría el email. Por ahora lo logueamos.
    res.json({ message: 'Si el email existe, recibirás un código de recuperación', __dev_codigo: process.env.NODE_ENV !== 'production' ? codigo : undefined });
  } catch (err) {
    logger.error('forgotPassword:', err.message);
    res.status(500).json({ message: 'Error del servidor' });
  }
}

// POST /api/auth/reset-password
async function resetPassword(req, res) {
  try {
    const { email, codigo, password_nuevo } = req.body;
    if (!email || !codigo || !password_nuevo)
      return res.status(400).json({ message: 'Email, código y nueva contraseña son requeridos' });
    if (password_nuevo.length < 6)
      return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });

    const { rows } = await query(`
      SELECT * FROM password_resets
      WHERE email=$1 AND codigo=$2 AND usado=FALSE AND expira_at > NOW()
    `, [email.toLowerCase().trim(), codigo]);

    if (!rows.length)
      return res.status(400).json({ message: 'Código inválido o expirado' });

    const reset = rows[0];
    const hash = await bcrypt.hash(password_nuevo, 12);
    await query(`UPDATE ${reset.tabla} SET password=$1 WHERE email=$2`, [hash, reset.email]);
    await query(`UPDATE password_resets SET usado=TRUE WHERE email=$1`, [reset.email]);

    logger.info(`🔑 Contraseña restablecida para ${reset.email}`);
    res.json({ message: 'Contraseña restablecida exitosamente' });
  } catch (err) {
    logger.error('resetPassword:', err.message);
    res.status(500).json({ message: 'Error del servidor' });
  }
}

module.exports = { loginAgente, loginCliente, perfil, cambiarPassword, forgotPassword, resetPassword };
