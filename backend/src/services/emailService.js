// src/services/emailService.js
const { Resend } = require('resend');
const logger = require('../utils/logger');

// Inicialización lazy para evitar crash si no hay API key configurada
let _resend = null;
function getResend() {
  if (!_resend && process.env.RESEND_API_KEY) {
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}
const FROM   = `${process.env.EMAIL_FROM_NAME||'CorpEase'} <${process.env.EMAIL_FROM||'noreply@corpease.com'}>`;

async function _send({ to, subject, html }) {
  try {
    if (!process.env.RESEND_API_KEY || process.env.RESEND_API_KEY === 're_tu_api_key' || !process.env.RESEND_API_KEY.startsWith('re_')) {
      logger.warn(`[EMAIL SIMULADO] Para: ${to} | Asunto: ${subject}`);
      return { id: 'simulated' };
    }
    const resend = getResend();
    const r = await resend.emails.send({ from: FROM, to, subject, html });
    logger.info(`Email enviado → ${to}: ${subject}`);
    return r;
  } catch (err) {
    logger.error(`Email error → ${to}: ${err.message}`);
    throw err;
  }
}

// Acceso al portal para el cliente
async function enviarAccesPortal(cliente, passwordTemporal) {
  return _send({
    to: cliente.email,
    subject: '🔑 Acceso a tu portal — CorpEase',
    html: `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
  <div style="background:#0F2340;padding:24px;border-radius:12px 12px 0 0;text-align:center">
    <h1 style="color:white;margin:0;font-size:22px">CorpEase</h1>
  </div>
  <div style="background:white;padding:32px;border:1px solid #e2e8f0">
    <h2 style="color:#0F2340">¡Bienvenido/a, ${cliente.nombre}!</h2>
    <p style="color:#64748b">Ya puedes acceder a tu portal personalizado donde podrás ver el estado de tus servicios, documentos y pagos.</p>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin:20px 0">
      <p style="margin:0 0 8px;font-size:13px;color:#64748b"><strong>Email:</strong> ${cliente.email}</p>
      <p style="margin:0;font-size:13px;color:#64748b"><strong>Contraseña temporal:</strong> <code style="background:#e2e8f0;padding:2px 6px;border-radius:4px">${passwordTemporal}</code></p>
    </div>
    <p style="color:#64748b;font-size:13px">Por seguridad, te recomendamos cambiar tu contraseña al iniciar sesión por primera vez.</p>
  </div>
</div>`,
  });
}

// Recordatorio de pago
async function enviarRecordatorioPago({ pago, diasRestantes }) {
  const urgencia = diasRestantes < 0 ? '🚨 Pago VENCIDO' : diasRestantes <= 7 ? `⚠️ Vence en ${diasRestantes} días` : `📅 Vence en ${diasRestantes} días`;
  return _send({
    to: pago.email,
    subject: `${diasRestantes < 0 ? '🚨' : '📅'} Recordatorio de pago — CorpEase`,
    html: `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
  <div style="background:#0F2340;padding:24px;border-radius:12px 12px 0 0;text-align:center">
    <h1 style="color:white;margin:0">CorpEase</h1>
  </div>
  <div style="background:white;padding:32px;border:1px solid #e2e8f0">
    <p style="color:#64748b">Estimado/a <strong style="color:#0F2340">${pago.nombre} ${pago.apellido||''}</strong>,</p>
    <div style="background:${diasRestantes < 0 ? '#fee2e2' : '#fff8e1'};border-radius:8px;padding:16px;margin:16px 0">
      <p style="margin:0;font-weight:600;color:${diasRestantes < 0 ? '#b91c1c' : '#92400e'}">${urgencia}</p>
    </div>
    <table style="width:100%;border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:10px;border:1px solid #e2e8f0;color:#64748b">Servicio</td><td style="padding:10px;border:1px solid #e2e8f0;font-weight:600">${pago.servicio_nombre||pago.descripcion||'CorpEase'}</td></tr>
      <tr><td style="padding:10px;border:1px solid #e2e8f0;background:#f8fafc;color:#64748b">Monto</td><td style="padding:10px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:600">$${pago.monto} ${pago.moneda||'USD'}</td></tr>
      ${pago.fecha_vencimiento ? `<tr><td style="padding:10px;border:1px solid #e2e8f0;color:#64748b">Fecha límite</td><td style="padding:10px;border:1px solid #e2e8f0;font-weight:600">${new Date(pago.fecha_vencimiento).toLocaleDateString('es')}</td></tr>` : ''}
    </table>
    ${pago.link_pago ? `<div style="text-align:center;margin:20px 0"><a href="${pago.link_pago}" style="background:#2563EB;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700">💳 Pagar ahora</a></div>` : ''}
  </div>
</div>`,
  });
}

// Solicitud de documento
async function enviarSolicitudArchivo({ cliente, solicitud }) {
  return _send({
    to: cliente.email,
    subject: `📄 Documento solicitado — ${solicitud.titulo}`,
    html: `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
  <div style="background:#0F2340;padding:24px;border-radius:12px 12px 0 0;text-align:center">
    <h1 style="color:white;margin:0">CorpEase</h1>
  </div>
  <div style="background:white;padding:32px;border:1px solid #e2e8f0">
    <p>Hola <strong>${cliente.nombre}</strong>,</p>
    <p style="color:#64748b">Para continuar con su proceso necesitamos el siguiente documento:</p>
    <div style="background:#eff6ff;border-left:4px solid #2563EB;padding:16px;border-radius:0 8px 8px 0;margin:16px 0">
      <p style="margin:0;font-weight:700;color:#0F2340">📋 ${solicitud.titulo}</p>
      ${solicitud.descripcion ? `<p style="margin:8px 0 0;color:#64748b;font-size:14px">${solicitud.descripcion}</p>` : ''}
      ${solicitud.fecha_limite ? `<p style="margin:8px 0 0;color:#64748b;font-size:13px">⏰ Fecha límite: ${new Date(solicitud.fecha_limite).toLocaleDateString('es')}</p>` : ''}
    </div>
    <p style="color:#64748b;font-size:14px">Puede enviar el documento directamente por WhatsApp y quedará registrado automáticamente en su expediente.</p>
  </div>
</div>`,
  });
}

// Factura
async function enviarFactura(pago) {
  return _send({
    to: pago.email,
    subject: `🧾 Factura — ${pago.servicio_nombre||'CorpEase'}`,
    html: `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
  <div style="background:#0F2340;padding:24px;border-radius:12px 12px 0 0;text-align:center">
    <h1 style="color:white;margin:0">CorpEase — Factura</h1>
  </div>
  <div style="background:white;padding:32px;border:1px solid #e2e8f0">
    <p>Estimado/a <strong>${pago.nombre}</strong>,</p>
    <p>Adjuntamos su comprobante de pago:</p>
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="padding:10px;border:1px solid #e2e8f0">Servicio</td><td style="padding:10px;border:1px solid #e2e8f0;font-weight:600">${pago.servicio_nombre||pago.descripcion}</td></tr>
      <tr><td style="padding:10px;border:1px solid #e2e8f0;background:#f8fafc">Total</td><td style="padding:10px;border:1px solid #e2e8f0;background:#f8fafc;font-weight:700;color:#0F2340">$${pago.monto} ${pago.moneda||'USD'}</td></tr>
      <tr><td style="padding:10px;border:1px solid #e2e8f0">Estado</td><td style="padding:10px;border:1px solid #e2e8f0;color:#065f46;font-weight:600">✓ Pagado</td></tr>
    </table>
    ${pago.url_factura ? `<p style="margin-top:20px"><a href="${pago.url_factura}" style="color:#2563EB;font-weight:600">📄 Ver / Descargar Factura</a></p>` : ''}
  </div>
</div>`,
  });
}

// Bienvenida para nuevo cliente
async function enviarBienvenida(cliente) {
  return _send({
    to: cliente.email,
    subject: `¡Bienvenido/a a CorpEase, ${cliente.nombre}!`,
    html: `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
  <div style="background:#0F2340;padding:24px;border-radius:12px 12px 0 0;text-align:center">
    <h1 style="color:white;margin:0">CorpEase</h1>
  </div>
  <div style="background:white;padding:32px;border:1px solid #e2e8f0">
    <h2 style="color:#0F2340">¡Bienvenido/a, ${cliente.nombre}! 👋</h2>
    <p style="color:#64748b;line-height:1.7">Hemos recibido su solicitud. Un miembro de nuestro equipo se pondrá en contacto a la brevedad para iniciar el proceso.</p>
    <p style="color:#64748b;line-height:1.7">Puede enviarnos sus documentos directamente por WhatsApp y los registraremos automáticamente en su expediente.</p>
  </div>
</div>`,
  });
}

module.exports = { enviarAccesPortal, enviarRecordatorioPago, enviarSolicitudArchivo, enviarFactura, enviarBienvenida };
