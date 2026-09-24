/*
Pruebas del Purchase por Meta CAPI (helpers/metacapi.js).
No llama a Meta ni escribe en el Sheet: fetch se reemplaza por uno falso.

Ejecutar:  npm run probar:capi
*/
import { idproducto } from '../helpers/precios.js';
import {
    _olvidarenviados, atribuciondelrequest, construirpurchase, enviarpurchase, eventidpurchase
} from '../helpers/metacapi.js';

let fallos = 0;
const revisar = (nombre, condicion, detalle) => {
    if (!condicion) fallos++;
    console.log(`  ${condicion ? 'OK  ' : 'FALLO'} ${nombre}`);
    if (!condicion && detalle !== undefined) console.log(`        ${JSON.stringify(detalle)}`);
};

// Request de Express falso
const requestfalso = (cabeceras = {}) => ({
    get: (nombre) => cabeceras[nombre.toLowerCase()],
    socket: { remoteAddress: '::ffff:10.0.0.1' }
});

// fetch falso que registra lo que se le manda
const crearfetch = (status = 200) => {
    const llamadas = [];
    const fetchimpl = async (url, opciones) => {
        llamadas.push({ url, cuerpo: JSON.parse(opciones.body) });
        return { ok: status < 400, status, text: async () => '{"error":"prueba"}' };
    };
    return { llamadas, fetchimpl };
};

const cliente = {
    nombre: 'Laura Gomez', telefono: '3001234567', cedula: '1020304050',
    direccion: 'Calle 23 # 23-11', ciudad: 'Cali, Valle del Cauca'
};

const atribucion = atribuciondelrequest(
    requestfalso({
        'x-forwarded-for': '181.50.1.2, 10.0.0.1',
        'user-agent': 'Mozilla/5.0 (iPhone) Instagram'
    }),
    {
        fbp: 'fb.1.1726000000000.123456789',
        fbc: 'fb.1.1726000000000.IwAR-abc_123',
        url: 'https://delteocol.com/checkout?telefono=3001234567#x'
    }
);

// Items como los guarda la pestaña Pagos (el 386 "Princesas" es variante del producto 381)
const items = [
    { id: 386, nombre: 'Computador con Pantalla y Mousee (Princesas)', cantidad: 1, preciounitario: 79900 },
    { id: 362, nombre: 'Orvis Hidrogel X 10.000 Unds', cantidad: 2, preciounitario: 7900 }
].map(item => ({ ...item, idproducto: idproducto(item.id, item.nombre) }));

console.log('\nAtribucion');
revisar('IP real desde x-forwarded-for', atribucion.ip === '181.50.1.2', atribucion);
revisar('URL sin query ni hash', atribucion.url === 'https://delteocol.com/checkout', atribucion.url);
revisar('fbp y fbc validos se conservan', atribucion.fbp && atribucion.fbc, atribucion);
const basura = atribuciondelrequest(requestfalso({}), { fbp: 'no-es-cookie', fbc: '<script>', url: 'javascript:alert(1)' });
revisar('cookies y URL invalidas se descartan', !basura.fbp && !basura.fbc && !basura.url, basura);
revisar('sin x-forwarded-for usa la IP del socket', basura.ip === '10.0.0.1', basura);

console.log('\nPayload');
const evento = construirpurchase({ eventid: eventidpurchase('ABC123'), total: 95700, items, atribucion });
revisar('event_name Purchase', evento.event_name === 'Purchase');
revisar('event_id = purchase_<id del pedido>', evento.event_id === 'purchase_ABC123', evento.event_id);
revisar('action_source website', evento.action_source === 'website');
revisar('content_ids con el id del producto (no la variante)', JSON.stringify(evento.custom_data.content_ids) === '["381","362"]', evento.custom_data.content_ids);
revisar('num_items suma cantidades', evento.custom_data.num_items === 3, evento.custom_data.num_items);
revisar('value y currency', evento.custom_data.value === 95700 && evento.custom_data.currency === 'COP');

const clavesusuario = Object.keys(evento.user_data).sort().join(',');
revisar('user_data solo tiene fbp, fbc, IP y user agent', clavesusuario === 'client_ip_address,client_user_agent,fbc,fbp', clavesusuario);
const texto = JSON.stringify(evento);
const pii = [cliente.nombre, 'Laura', cliente.telefono, cliente.cedula, 'Calle 23', 'Cali'].filter(dato => texto.includes(dato));
revisar('el payload no contiene nombre, celular, cedula, direccion ni ciudad', pii.length === 0, pii);

console.log('\nEnvio');
delete process.env.META_PIXEL_ID;
delete process.env.META_CAPI_TOKEN;
let falso = crearfetch();
let resultado = await enviarpurchase({ eventid: 'purchase_SINCONFIG', total: 1, items, atribucion }, falso);
revisar('sin variables de entorno no se envia nada', !resultado.enviado && falso.llamadas.length === 0, resultado);

process.env.META_PIXEL_ID = '1001204391946867';
process.env.META_CAPI_TOKEN = 'token-de-prueba';
delete process.env.META_TEST_EVENT_CODE;
_olvidarenviados();

falso = crearfetch();
resultado = await enviarpurchase({ eventid: 'purchase_P1', total: 95700, items, atribucion }, falso);
revisar('con configuracion se envia una vez', resultado.enviado && falso.llamadas.length === 1, resultado);
revisar('va al pixel correcto', falso.llamadas[0]?.url.includes('/1001204391946867/events'));
revisar('manda un solo evento', falso.llamadas[0]?.cuerpo.data.length === 1);

resultado = await enviarpurchase({ eventid: 'purchase_P1', total: 95700, items, atribucion }, falso);
revisar('el mismo event_id no se envia dos veces', !resultado.enviado && falso.llamadas.length === 1, resultado);

const fallido = crearfetch(500);
resultado = await enviarpurchase({ eventid: 'purchase_P2', total: 95700, items, atribucion }, fallido);
revisar('si Meta falla no lanza error', !resultado.enviado, resultado);
const reintento = crearfetch();
resultado = await enviarpurchase({ eventid: 'purchase_P2', total: 95700, items, atribucion }, reintento);
revisar('tras un fallo, un reintento si se envia', resultado.enviado && reintento.llamadas.length === 1, resultado);

const sinua = crearfetch();
resultado = await enviarpurchase({ eventid: 'purchase_P3', total: 1, items, atribucion: { fbp: atribucion.fbp } }, sinua);
revisar('sin user agent no se envia (Meta lo exige)', !resultado.enviado && sinua.llamadas.length === 0, resultado);

process.env.META_TEST_EVENT_CODE = 'TEST123';
const conprueba = crearfetch();
await enviarpurchase({ eventid: 'purchase_P4', total: 1, items, atribucion }, conprueba);
revisar('META_TEST_EVENT_CODE se agrega al cuerpo', conprueba.llamadas[0]?.cuerpo.test_event_code === 'TEST123');

console.log(fallos ? `\n${fallos} prueba(s) fallaron\n` : '\nTodas las pruebas pasaron\n');
process.exit(fallos ? 1 : 0);
