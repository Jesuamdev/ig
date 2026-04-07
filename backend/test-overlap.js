// test-overlap.js — Prueba de detección de solapamiento de citas
// Uso: node test-overlap.js <API_URL> <TOKEN>
// Ejemplo: node test-overlap.js http://localhost:3000 eyJhbGci...

const API   = process.argv[2] || 'http://localhost:3000';
const TOKEN = process.argv[3] || '';

if (!TOKEN) {
  console.error('❌ Debes pasar el JWT token como segundo argumento');
  console.error('   node test-overlap.js https://tu-api.railway.app eyJhbGci...');
  process.exit(1);
}

const headers = {
  'Content-Type':  'application/json',
  'Authorization': `Bearer ${TOKEN}`,
};

async function req(method, path, body) {
  const r = await fetch(`${API}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

async function run() {
  console.log(`\n🔗 API: ${API}\n`);

  // 1. Obtener agentes disponibles
  const { data: agentes } = await req('GET', '/agentes');
  const lista = Array.isArray(agentes) ? agentes : (agentes.agentes || []);
  if (!lista.length) {
    console.error('❌ No hay agentes. Crea uno primero.');
    process.exit(1);
  }
  const agente = lista[0];
  console.log(`👤 Usando agente: ${agente.nombre} (${agente.id})`);

  const fechaBase = new Date();
  fechaBase.setDate(fechaBase.getDate() + 1); // mañana
  fechaBase.setHours(10, 0, 0, 0);
  const inicio = fechaBase.toISOString();
  const fin    = new Date(fechaBase.getTime() + 60 * 60 * 1000).toISOString(); // +1 hora

  console.log(`\n📅 Horario de prueba: ${inicio} → ${fin}\n`);

  // 2. Crear primera cita
  console.log('1️⃣  Creando primera cita...');
  const r1 = await req('POST', '/citas', {
    agente_id:   agente.id,
    fecha_inicio: inicio,
    fecha_fin:    fin,
    titulo:      'Cita de prueba #1',
    estado:      'confirmada',
    tipo:        'cita',
  });

  if (r1.status === 201) {
    console.log(`   ✅ Creada — ID: ${r1.data.id}`);
  } else {
    console.error(`   ❌ Error ${r1.status}:`, r1.data.message);
    process.exit(1);
  }

  // 3. Intentar crear segunda cita en el mismo horario
  console.log('\n2️⃣  Intentando crear segunda cita en el MISMO horario...');
  const r2 = await req('POST', '/citas', {
    agente_id:   agente.id,
    fecha_inicio: inicio,
    fecha_fin:    fin,
    titulo:      'Cita de prueba #2 (debe fallar)',
    estado:      'confirmada',
    tipo:        'cita',
  });

  if (r2.status === 409) {
    console.log(`   ✅ CORRECTO — Backend devolvió 409: "${r2.data.message}"`);
    console.log(`   ✅ Código: ${r2.data.code}`);
  } else if (r2.status === 201) {
    console.error(`   ❌ PROBLEMA — La segunda cita fue creada (no debería). ID: ${r2.data.id}`);
  } else {
    console.error(`   ❌ Error inesperado ${r2.status}:`, r2.data.message);
  }

  // 4. Prueba solapamiento parcial (+30 min — superpone)
  const iniParcial = new Date(fechaBase.getTime() + 30 * 60 * 1000).toISOString();
  const finParcial = new Date(fechaBase.getTime() + 90 * 60 * 1000).toISOString();
  console.log('\n3️⃣  Solapamiento parcial (+30min hasta +90min)...');
  const r3 = await req('POST', '/citas', {
    agente_id:   agente.id,
    fecha_inicio: iniParcial,
    fecha_fin:    finParcial,
    titulo:      'Cita parcial (debe fallar)',
    estado:      'confirmada',
    tipo:        'cita',
  });
  console.log(r3.status === 409
    ? `   ✅ CORRECTO — Solapamiento parcial detectado: "${r3.data.message}"`
    : `   ❌ PROBLEMA — Solapamiento parcial no detectado (status ${r3.status})`);

  // 5. Prueba sin solapamiento (+2 horas — no superpone)
  const iniLibre = new Date(fechaBase.getTime() + 2 * 60 * 60 * 1000).toISOString();
  const finLibre = new Date(fechaBase.getTime() + 3 * 60 * 60 * 1000).toISOString();
  console.log('\n4️⃣  Sin solapamiento (+2h hasta +3h — debe crearse)...');
  const r4 = await req('POST', '/citas', {
    agente_id:   agente.id,
    fecha_inicio: iniLibre,
    fecha_fin:    finLibre,
    titulo:      'Cita libre (debe crearse)',
    estado:      'confirmada',
    tipo:        'cita',
  });
  console.log(r4.status === 201
    ? `   ✅ CORRECTO — Cita creada en horario libre: ${r4.data.id}`
    : `   ❌ PROBLEMA — No se pudo crear en horario libre (status ${r4.status}: ${r4.data.message})`);

  // 6. Limpiar citas de prueba
  console.log('\n🧹 Limpiando citas de prueba...');
  for (const r of [r1, r4]) {
    if (r.data?.id) {
      const del = await req('DELETE', `/citas/${r.data.id}`);
      console.log(`   ${del.status === 200 ? '✅' : '⚠️'} Eliminada ${r.data.id}`);
    }
  }

  console.log('\n✅ Prueba completada\n');
}

run().catch(err => { console.error('Error:', err.message); process.exit(1); });
