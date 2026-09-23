/*
Prueba de integracion del flujo de pago contra el servidor local.
Ejecutar con el servidor arriba:  npm run probar:integracion

ATENCION: escribe filas reales en las pestañas Pagos y Orders del Sheet.
Todo lo que crea queda marcado como "ZZ PRUEBA" para poder borrarlo despues.
*/
import crypto from 'crypto';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import obtenerauth from '../helpers/googleauth.js';

dotenv.config();

const BASE = `http://localhost:${process.env.PORT || 4009}`;
const ORIGEN = process.env.FRONTEND_URL;
const SECRETO_EVENTOS = process.env.WOMPI_EVENTS_SECRET;

let fallos = 0;
const revisar = (nombre, condicion, detalle) => {
    if (!condicion) fallos++;
    console.log(`  ${condicion ? 'OK  ' : 'FALLO'} ${nombre}`);
    if (!condicion && detalle !== undefined) console.log(`        ${JSON.stringify(detalle)}`);
};

const pedir = async (ruta, opciones = {}) => {
    const res = await fetch(`${BASE}${ruta}`, {
        ...opciones,
        headers: { 'Content-Type': 'application/json', Origin: ORIGEN, ...(opciones.headers || {}) },
        signal: AbortSignal.timeout(30000)
    });
    let cuerpo = null;
    try { cuerpo = await res.json(); } catch { cuerpo = null; }
    return { status: res.status, cuerpo };
};

const clienteValido = {
    nombre: 'ZZ PRUEBA Claude',
    telefono: '3001234567',
    cedula: '1020304050',
    ciudad: 'Bogota, Cundinamarca',
    region: 'Cundinamarca',
    direccion: 'Calle 23 # 23-11 PRUEBA',
    zona: 'bogota'
};

const M416 = { id: 376, nombre: 'M416 Hidrogel Recargable con Luz y Humo' };
const ORVIS = { id: 362, nombre: 'Orvis Hidrogel X 10.000 Unds' };

// Firma un evento igual que lo hace Wompi
const firmarevento = (transaccion, timestamp = Math.floor(Date.now() / 1000)) => {
    const properties = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'];
    const cadena = `${transaccion.id}${transaccion.status}${transaccion.amount_in_cents}${timestamp}${SECRETO_EVENTOS}`;
    return {
        event: 'transaction.updated',
        data: { transaction: transaccion },
        environment: 'test',
        signature: { properties, checksum: crypto.createHash('sha256').update(cadena, 'utf8').digest('hex').toUpperCase() },
        timestamp,
        sent_at: new Date().toISOString()
    };
};

const contarfilas = async (pestana) => {
    const auth = await obtenerauth();
    const sheets = google.sheets({ version: 'v4', auth });
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SHEET_ID, range: `${pestana}!A:A` });
    return (r.data.values || []).length;
};

const leerpago = async (referencia) => {
    const auth = await obtenerauth();
    const sheets = google.sheets({ version: 'v4', auth });
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SHEET_ID, range: 'Pagos!A:M' });
    const filas = r.data.values || [];
    const fila = filas.find(f => f[0] === referencia);
    return fila ? { referencia: fila[0], ordenid: fila[1], estado: fila[2], monto: Number(fila[3]), tx: fila[4], metodo: fila[5], email: fila[6], ordenescrita: fila[9] } : null;
};

const main = async () => {
    console.log(`Servidor: ${BASE}\n`);

    console.log('--- Crear orden ---');
    const creada = await pedir('/api/ordenes', {
        method: 'POST',
        body: JSON.stringify({ items: [{ ...M416, cantidad: 1 }, { ...ORVIS, cantidad: 2 }], cliente: clienteValido })
    });
    revisar('responde 200', creada.status === 200, creada);
    revisar('trae referencia', Boolean(creada.cuerpo?.referencia), creada.cuerpo);
    revisar('total calculado en el servidor = 165.700', creada.cuerpo?.total === 165700, creada.cuerpo?.total);
    revisar('monto en centavos = 16.570.000', creada.cuerpo?.montoencentavos === 16570000, creada.cuerpo?.montoencentavos);
    revisar('aplico el precio de bump al Orvis', creada.cuerpo?.items?.find(i => i.id === 362)?.preciounitario === 7900);
    revisar('urlpago apunta al checkout de Wompi', String(creada.cuerpo?.urlpago || '').startsWith('https://checkout.wompi.co/p/?'));
    revisar('urlpago lleva la llave publica de sandbox', String(creada.cuerpo?.urlpago || '').includes('public-key=pub_test_'));
    revisar('urlpago lleva la firma de integridad', /signature%3Aintegrity=[a-f0-9]{64}/.test(String(creada.cuerpo?.urlpago || '')));
    revisar('NO expone la llave privada', !JSON.stringify(creada.cuerpo).includes('prv_'));
    revisar('NO expone el secreto de integridad', !JSON.stringify(creada.cuerpo).includes('integrity_'));
    revisar('NO expone el secreto de eventos', !JSON.stringify(creada.cuerpo).includes('events_'));

    const referencia = creada.cuerpo.referencia;

    console.log('--- La fila quedo en la pestaña Pagos ---');
    const pago = await leerpago(referencia);
    revisar('existe la fila', Boolean(pago), pago);
    revisar('estado inicial PENDIENTE_PAGO', pago?.estado === 'PENDIENTE_PAGO', pago?.estado);
    revisar('monto guardado', pago?.monto === 16570000, pago?.monto);
    revisar('ordenescrita = NO', pago?.ordenescrita === 'NO', pago?.ordenescrita);

    console.log('--- El precio del navegador se ignora ---');
    const manipulada = await pedir('/api/ordenes', {
        method: 'POST',
        body: JSON.stringify({
            items: [{ ...M416, cantidad: 1, precio: 100 }, { ...ORVIS, cantidad: 2, precio: 1 }],
            cliente: clienteValido,
            total: 101
        })
    });
    revisar('sigue cobrando 165.700', manipulada.cuerpo?.total === 165700, manipulada.cuerpo?.total);

    console.log('--- Validaciones ---');
    const sincliente = await pedir('/api/ordenes', { method: 'POST', body: JSON.stringify({ items: [{ ...M416, cantidad: 1 }], cliente: { nombre: 'X' } }) });
    revisar('datos de cliente invalidos -> 400', sincliente.status === 400, sincliente.status);
    const bajominimo = await pedir('/api/ordenes', { method: 'POST', body: JSON.stringify({ items: [{ ...ORVIS, cantidad: 1 }], cliente: clienteValido }) });
    revisar('bajo el pedido minimo -> 400', bajominimo.status === 400, bajominimo.status);
    const inventado = await pedir('/api/ordenes', { method: 'POST', body: JSON.stringify({ items: [{ id: 99999, nombre: 'Inventado', cantidad: 1 }], cliente: clienteValido }) });
    revisar('producto inexistente -> 400', inventado.status === 400, inventado.status);

    console.log('--- Webhook: firma ---');
    const txid = `ZZTEST-${Date.now()}`;
    const eventoAprobado = firmarevento({
        id: txid, status: 'APPROVED', amount_in_cents: 16570000, reference: referencia,
        customer_email: 'prueba@delteo.test', payment_method_type: 'CARD', currency: 'COP'
    });

    const malafirma = await pedir('/api/wompi/webhook', {
        method: 'POST',
        body: JSON.stringify({ ...eventoAprobado, signature: { ...eventoAprobado.signature, checksum: 'a'.repeat(64) } })
    });
    revisar('checksum invalido -> 401', malafirma.status === 401, malafirma.status);

    const alterado = JSON.parse(JSON.stringify(eventoAprobado));
    alterado.data.transaction.amount_in_cents = 100;
    const conalteracion = await pedir('/api/wompi/webhook', { method: 'POST', body: JSON.stringify(alterado) });
    revisar('monto alterado (rompe la firma) -> 401', conalteracion.status === 401, conalteracion.status);

    console.log('--- Webhook: sin header Origin (como lo manda Wompi) ---');
    const sinorigen = await fetch(`${BASE}/api/wompi/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventoAprobado),
        signal: AbortSignal.timeout(30000)
    });
    revisar('el CORS no bloquea el webhook -> 200', sinorigen.status === 200, sinorigen.status);

    console.log('--- El pago quedo aprobado y el pedido escrito ---');
    const pagado = await leerpago(referencia);
    revisar('estado PAGADO', pagado?.estado === 'PAGADO', pagado?.estado);
    revisar('guardo el id de transaccion', pagado?.tx === txid, pagado?.tx);
    revisar('guardo el metodo de pago', pagado?.metodo === 'CARD', pagado?.metodo);
    revisar('guardo el email que aporta Wompi', pagado?.email === 'prueba@delteo.test', pagado?.email);
    revisar('ordenescrita = SI', pagado?.ordenescrita === 'SI', pagado?.ordenescrita);

    console.log('--- Idempotencia: el mismo evento 3 veces ---');
    const ordenesAntes = await contarfilas('Orders');
    await pedir('/api/wompi/webhook', { method: 'POST', body: JSON.stringify(eventoAprobado) });
    await pedir('/api/wompi/webhook', { method: 'POST', body: JSON.stringify(eventoAprobado) });
    const repetido = await pedir('/api/wompi/webhook', { method: 'POST', body: JSON.stringify(eventoAprobado) });
    const ordenesDespues = await contarfilas('Orders');
    revisar('responde 200 al repetirse', repetido.status === 200, repetido.status);
    revisar('NO se agregaron pedidos duplicados', ordenesAntes === ordenesDespues, { antes: ordenesAntes, despues: ordenesDespues });

    console.log('--- Idempotencia: 5 webhooks simultaneos ---');
    const antesConc = await contarfilas('Orders');
    await Promise.all(Array.from({ length: 5 }, () =>
        pedir('/api/wompi/webhook', { method: 'POST', body: JSON.stringify(eventoAprobado) })));
    const despuesConc = await contarfilas('Orders');
    revisar('concurrencia no duplica el pedido', antesConc === despuesConc, { antes: antesConc, despues: despuesConc });

    console.log('--- No se degrada un estado final ---');
    const rechazoTardio = firmarevento({ id: txid, status: 'DECLINED', amount_in_cents: 16570000, reference: referencia, payment_method_type: 'CARD' });
    await pedir('/api/wompi/webhook', { method: 'POST', body: JSON.stringify(rechazoTardio) });
    const trasRechazo = await leerpago(referencia);
    revisar('sigue PAGADO tras un DECLINED tardio', trasRechazo?.estado === 'PAGADO', trasRechazo?.estado);

    console.log('--- Referencia desconocida ---');
    const desconocida = firmarevento({ id: 'ZZ-NOEXISTE', status: 'APPROVED', amount_in_cents: 1000, reference: 'DELTEO-NOEXISTE-1-AAAAAA' });
    const resDesc = await pedir('/api/wompi/webhook', { method: 'POST', body: JSON.stringify(desconocida) });
    revisar('responde 200 y no reintenta en vano', resDesc.status === 200, resDesc.status);

    console.log('--- Consulta de estado contra el API de Wompi ---');
    const consulta = await pedir('/api/pagos/01-0000000000-00000');
    revisar('transaccion inexistente -> 404 limpio', consulta.status === 404, { status: consulta.status, cuerpo: consulta.cuerpo });
    revisar('la respuesta no filtra secretos', !JSON.stringify(consulta.cuerpo || {}).includes('prv_'));

    console.log(`\nReferencia de prueba creada: ${referencia}`);
    console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} FALLO(S)`);
    process.exit(fallos === 0 ? 0 : 1);
};

main().catch(e => { console.error('\nError inesperado:', e.message); process.exit(1); });
