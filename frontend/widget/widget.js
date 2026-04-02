/**
 * WhatsApp Widget — 33Solutions
 * Incluir con: <script src="/widget/widget.js" async></script>
 * Configurar: window.WA_WIDGET_CONFIG = { id, telefono, mensaje, color, posicion }
 */
(function () {
  'use strict';

  var config = window.WA_WIDGET_CONFIG || {};
  var telefono = config.telefono || '';
  var mensaje  = config.mensaje  || '¡Hola! ¿En qué podemos ayudarte?';
  var color    = config.color    || '#25D366';
  var posicion = config.posicion || 'derecha';
  var widgetId = config.id       || '';

  if (!telefono) return;

  // Evitar doble inicialización
  if (document.getElementById('wa-widget-btn')) return;

  // Estilos
  var style = document.createElement('style');
  style.textContent = [
    '#wa-widget-btn {',
    '  position: fixed;',
    '  bottom: 20px;',
    '  ' + (posicion === 'izquierda' ? 'left' : 'right') + ': 20px;',
    '  z-index: 9999;',
    '  cursor: pointer;',
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
    '}',
    '#wa-widget-bubble {',
    '  width: 60px;',
    '  height: 60px;',
    '  border-radius: 50%;',
    '  background: ' + color + ';',
    '  box-shadow: 0 4px 20px rgba(0,0,0,0.25);',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: center;',
    '  transition: transform 0.2s, box-shadow 0.2s;',
    '}',
    '#wa-widget-bubble:hover {',
    '  transform: scale(1.1);',
    '  box-shadow: 0 6px 28px rgba(0,0,0,0.35);',
    '}',
    '#wa-widget-tooltip {',
    '  position: absolute;',
    '  bottom: 70px;',
    '  ' + (posicion === 'izquierda' ? 'left' : 'right') + ': 0;',
    '  background: white;',
    '  border-radius: 12px;',
    '  padding: 14px 18px;',
    '  max-width: 260px;',
    '  min-width: 180px;',
    '  box-shadow: 0 4px 24px rgba(0,0,0,0.15);',
    '  font-size: 14px;',
    '  color: #1a1a1a;',
    '  line-height: 1.4;',
    '  opacity: 0;',
    '  transform: translateY(8px);',
    '  transition: opacity 0.2s, transform 0.2s;',
    '  pointer-events: none;',
    '}',
    '#wa-widget-tooltip.visible {',
    '  opacity: 1;',
    '  transform: translateY(0);',
    '  pointer-events: auto;',
    '}',
    '#wa-widget-tooltip::after {',
    '  content: "";',
    '  position: absolute;',
    '  bottom: -8px;',
    '  ' + (posicion === 'izquierda' ? 'left' : 'right') + ': 18px;',
    '  border: 8px solid transparent;',
    '  border-bottom: none;',
    '  border-top-color: white;',
    '}',
    '#wa-widget-close {',
    '  float: right;',
    '  background: none;',
    '  border: none;',
    '  cursor: pointer;',
    '  font-size: 18px;',
    '  color: #888;',
    '  line-height: 1;',
    '  padding: 0;',
    '  margin-left: 8px;',
    '}',
    '#wa-widget-open-link {',
    '  display: inline-block;',
    '  margin-top: 10px;',
    '  background: ' + color + ';',
    '  color: white;',
    '  padding: 8px 14px;',
    '  border-radius: 20px;',
    '  text-decoration: none;',
    '  font-size: 13px;',
    '  font-weight: 600;',
    '}',
    '#wa-widget-pulse {',
    '  position: absolute;',
    '  top: -4px;',
    '  right: -4px;',
    '  width: 16px;',
    '  height: 16px;',
    '  background: #ef4444;',
    '  border-radius: 50%;',
    '  border: 2px solid white;',
    '  animation: wa-pulse 2s infinite;',
    '}',
    '@keyframes wa-pulse {',
    '  0%   { transform: scale(1); opacity: 1; }',
    '  50%  { transform: scale(1.3); opacity: 0.7; }',
    '  100% { transform: scale(1); opacity: 1; }',
    '}',
  ].join('\n');
  document.head.appendChild(style);

  // WhatsApp SVG icon
  var svgIcon = '<svg width="32" height="32" viewBox="0 0 32 32" fill="white" xmlns="http://www.w3.org/2000/svg"><path d="M16 2C8.268 2 2 8.268 2 16c0 2.493.651 4.833 1.79 6.866L2 30l7.39-1.76A13.926 13.926 0 0016 30c7.732 0 14-6.268 14-14S23.732 2 16 2zm0 25.5a11.44 11.44 0 01-5.84-1.604l-.42-.249-4.386 1.044 1.07-4.27-.273-.44A11.44 11.44 0 014.5 16C4.5 9.649 9.649 4.5 16 4.5S27.5 9.649 27.5 16 22.351 27.5 16 27.5zm6.29-8.47c-.344-.172-2.034-1.004-2.35-1.118-.315-.115-.545-.172-.774.172-.23.344-.888 1.118-1.088 1.348-.2.229-.4.258-.744.086-.344-.172-1.454-.536-2.77-1.71-1.024-.912-1.714-2.037-1.914-2.381-.2-.344-.021-.53.15-.702.155-.154.344-.4.516-.6.172-.2.229-.344.344-.573.115-.23.057-.43-.029-.602-.086-.172-.774-1.866-1.06-2.554-.28-.672-.563-.58-.774-.591l-.66-.011a1.27 1.27 0 00-.917.43c-.315.344-1.203 1.175-1.203 2.869s1.232 3.327 1.403 3.556c.172.23 2.422 3.698 5.872 5.187.82.354 1.46.566 1.96.724.824.262 1.574.225 2.167.137.66-.099 2.034-.832 2.32-1.635.287-.802.287-1.49.2-1.635-.086-.143-.315-.23-.66-.4z"/></svg>';

  // Crear contenedor
  var container = document.createElement('div');
  container.id = 'wa-widget-btn';

  var tooltip = document.createElement('div');
  tooltip.id = 'wa-widget-tooltip';
  tooltip.innerHTML = '<button id="wa-widget-close" aria-label="Cerrar">×</button>'
    + '<div style="clear:both;padding-top:2px">' + mensaje + '</div>'
    + '<a id="wa-widget-open-link" href="' + buildWaLink() + '" target="_blank" rel="noopener">Abrir WhatsApp</a>';

  var bubble = document.createElement('div');
  bubble.id = 'wa-widget-bubble';
  bubble.innerHTML = svgIcon + '<div id="wa-widget-pulse"></div>';
  bubble.setAttribute('aria-label', 'Abrir WhatsApp');
  bubble.setAttribute('role', 'button');
  bubble.setAttribute('tabindex', '0');

  container.appendChild(tooltip);
  container.appendChild(bubble);
  document.body.appendChild(container);

  // Auto-show tooltip after 3s
  setTimeout(function () {
    tooltip.classList.add('visible');
  }, 3000);

  // Click en burbuja
  bubble.addEventListener('click', function () {
    if (tooltip.classList.contains('visible')) {
      registrarClic();
      window.open(buildWaLink(), '_blank', 'noopener');
    } else {
      tooltip.classList.add('visible');
    }
  });

  // Cerrar tooltip
  document.getElementById('wa-widget-close').addEventListener('click', function (e) {
    e.stopPropagation();
    tooltip.classList.remove('visible');
  });

  // Clic en enlace
  document.getElementById('wa-widget-open-link').addEventListener('click', function () {
    registrarClic();
  });

  function buildWaLink() {
    var tel = telefono.replace(/\D/g, '');
    var txt = encodeURIComponent(mensaje);
    return 'https://wa.me/' + tel + '?text=' + txt;
  }

  function registrarClic() {
    if (!widgetId) return;
    // Registrar clic en el servidor (analytics)
    var apiBase = (window.WA_WIDGET_CONFIG && window.WA_WIDGET_CONFIG.api_url) || '';
    if (!apiBase) return;
    fetch(apiBase + '/api/widget/' + widgetId + '/clic', { method: 'POST' }).catch(function () {});
  }

})();
