/*
Genera una orden de prueba y muestra la URL de pago de Wompi, para abrirla a mano
en el navegador y verificar el checkout real.

Uso:
  npm run orden:prueba                 -> M416 ($149.900)
  npm run orden:prueba -- barato       -> pedido cerca del minimo
  npm run orden:prueba -- bump         -> lanzadora + Orvis, para ver la regla del bump
  npm run orden:prueba -- --solo-webhook
                                       -> sin redirect-url: Wompi no te devuelve a Delteo,
                                          asi que el pedido SOLO se puede registrar por el
                                          webhook. Simula al cliente que cierra el navegador.

El servidor tiene que estar corriendo (npm run dev).
*/
import dotenv from 'dotenv';
dotenv.config();

const PUERTO = process.env.PORT || 4009;
const ORIGEN = process.env.FRONTEND_URL;

const CARRITOS = {
    normal: [{ id: 376, nombre: 'M416 Hidrogel Recargable con Luz y Humo', cantidad: 1 }],
    bump: [
        { id: 376, nombre: 'M416 Hidrogel Recargable con Luz y Humo', cantidad: 1 },
        { id: 362, nombre: 'Orvis Hidrogel X 10.000 Unds', cantidad: 2 }
    ],
    barato: [{ id: 362, nombre: 'Orvis Hidrogel X 10.000 Unds', cantidad: 3 }]
};

const cliente = {
    nombre: 'ZZ Prueba Sandbox',
    telefono: '3001234567',
    cedula: '1020304050',
    ciudad: 'Bogota, Cundinamarca',
    region: 'Cundinamarca',
    direccion: 'Calle 23 # 23-11 PRUEBA',
    zona: 'bogota'
};

const argumentos = process.argv.slice(2);
const soloWebhook = argumentos.includes('--solo-webhook');
const cual = argumentos.find(a => !a.startsWith('--')) || 'normal';
const items = CARRITOS[cual];

if (!items) {
    console.error(`Carrito desconocido: "${cual}". Usa: ${Object.keys(CARRITOS).join(', ')}`);
    process.exit(1);
}

try {
    const respuesta = await fetch(`http://localhost:${PUERTO}/api/ordenes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGEN },
        body: JSON.stringify({ items, cliente }),
        signal: AbortSignal.timeout(30000)
    });

    const datos = await respuesta.json();

    if (!respuesta.ok) {
        console.error('El backend rechazo la orden:');
        (datos.errores || []).forEach(e => console.error(`  - ${e}`));
        process.exit(1);
    }

    // La firma de integridad solo cubre referencia, monto y moneda, asi que quitar
    // redirect-url no la invalida: es un parametro opcional de Wompi.
    let urlpago = datos.urlpago;
    if (soloWebhook) {
        const url = new URL(urlpago);
        url.searchParams.delete('redirect-url');
        urlpago = url.toString();
    }

    console.log('');
    console.log(`  Carrito     : ${cual}`);
    console.log(`  Referencia  : ${datos.referencia}`);
    console.log(`  Total       : $${datos.total.toLocaleString('es-CO')}`);
    console.log(soloWebhook
        ? '  Redirige a  : (ninguna) -> solo el webhook puede registrar este pedido'
        : `  Redirige a  : ${process.env.FRONTEND_URL}/pago/resultado`);
    console.log('');
    console.log('  Abre esta URL en tu navegador:');
    console.log('');
    console.log(urlpago);
    console.log('');
    console.log('  Tarjetas de sandbox:');
    console.log('    4242 4242 4242 4242  -> APROBADA');
    console.log('    4111 1111 1111 1111  -> RECHAZADA');
    console.log('    (cualquier fecha futura y CVC de 3 digitos)');
    console.log('');

} catch (error) {
    console.error('No se pudo contactar el backend:', error.message);
    console.error(`Verifica que este corriendo en http://localhost:${PUERTO} (npm run dev)`);
    process.exit(1);
}
