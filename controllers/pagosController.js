import crypto from 'crypto';
import enviarpedidoinfo from '../helpers/enviarpedidoinfo.js';
import { calcularorden } from '../helpers/precios.js';
import {
    ESTADOS, actualizarpago, buscarporreferencia, conbloqueo,
    crearpago, esfinaldelteo, estadodesdewompi
} from '../helpers/pagossheet.js';
import {
    config, configpublica, consultartransaccion, firmaintegridad,
    generarreferencia, MONEDA, pesosacentavos, verificarevento
} from '../helpers/wompi.js';

/*
Flujo de pago con Wompi.

Principios:
- El total lo calcula el backend con su propio catalogo. Nunca se usa el del navegador.
- La firma de integridad se genera aqui, con el secreto que solo vive en el servidor.
- Un pedido solo pasa a PAGADO por el webhook o por una consulta autenticada al API.
  Volver a la pagina de resultado no aprueba nada por si mismo.
- Todo cambio de estado es idempotente: el mismo evento dos veces no duplica el pedido.
*/

const soloDigitos = (texto) => String(texto ?? '').replace(/\D/g, '');
const limpiar = (texto, maximo = 200) => String(texto ?? '').trim().slice(0, maximo);

// Las mismas reglas que valida el checkout en el navegador, repetidas en el servidor
const validarcliente = (cliente) => {
    const errores = [];
    const telefono = soloDigitos(cliente?.telefono);
    const cedula = soloDigitos(cliente?.cedula);
    const nombre = limpiar(cliente?.nombre, 120);
    const direccion = limpiar(cliente?.direccion, 250);
    const ciudad = limpiar(cliente?.ciudad, 120);

    if (!/^3\d{9}$/.test(telefono)) errores.push('El celular debe tener 10 digitos y empezar por 3.');
    if (nombre.split(/\s+/).filter(Boolean).length < 2) errores.push('Escribe tu nombre y apellido.');
    if (!ciudad) errores.push('Elige tu ciudad o municipio.');
    if (direccion.length < 8 || !/\d/.test(direccion)) errores.push('Escribe la direccion completa.');
    if (!/^\d{6,10}$/.test(cedula)) errores.push('La cedula debe tener entre 6 y 10 digitos.');

    return {
        errores,
        cliente: {
            nombre, telefono, cedula, ciudad, direccion,
            region: limpiar(cliente?.region, 120) || ciudad,
            zona: limpiar(cliente?.zona, 40)
        }
    };
};

const fechadehoy = () => {
    const hoy = new Date();
    return `${hoy.getMonth() + 1}/${hoy.getDate()}/${hoy.getFullYear()}`;
};

const nuevoordenid = () =>
    `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`.toUpperCase();

// ------------------------------------------------------ POST /api/ordenes

const crearorden = async (req, res) => {
    try {
        const { items, cliente } = req.body || {};

        const calculo = calcularorden(items);
        const revisioncliente = validarcliente(cliente);
        const errores = [...revisioncliente.errores, ...calculo.errores];

        if (errores.length) {
            // Se devuelve tambien el calculo del servidor para que el checkout
            // pueda mostrar el total correcto si el del navegador quedo desactualizado
            return res.status(400).json({
                ok: false,
                errores,
                items: calculo.items,
                subtotal: calculo.subtotal,
                total: calculo.total
            });
        }

        const ordenid = nuevoordenid();
        const intento = 1;
        const referencia = generarreferencia(ordenid, intento);
        const montoencentavos = pesosacentavos(calculo.total);

        await crearpago({
            referencia,
            ordenid,
            montoencentavos,
            cliente: revisioncliente.cliente,
            items: calculo.items
        });

        const { llavepublica, urlcheckout } = configpublica();
        const firma = firmaintegridad({ referencia, montoencentavos, moneda: MONEDA });
        const urlredireccion = `${process.env.FRONTEND_URL}/pago/resultado`;

        const datos = revisioncliente.cliente;

        // Nombres de parametro exactamente como los documenta Wompi para el Web Checkout
        const campos = {
            'public-key': llavepublica,
            currency: MONEDA,
            'amount-in-cents': String(montoencentavos),
            reference: referencia,
            'signature:integrity': firma,
            'redirect-url': urlredireccion,
            'customer-data:full-name': datos.nombre,
            'customer-data:phone-number': datos.telefono,
            'customer-data:phone-number-prefix': '+57',
            'customer-data:legal-id': datos.cedula,
            'customer-data:legal-id-type': 'CC',
            'shipping-address:address-line-1': datos.direccion,
            'shipping-address:country': 'CO',
            'shipping-address:city': datos.ciudad,
            'shipping-address:region': datos.region,
            'shipping-address:phone-number': datos.telefono,
            'shipping-address:name': datos.nombre
        };

        const parametros = new URLSearchParams(campos);

        console.log(`[pagos] orden ${ordenid} creada | ref ${referencia} | ${montoencentavos} centavos | ${calculo.items.length} items`);

        res.json({
            ok: true,
            referencia,
            ordenid,
            montoencentavos,
            total: calculo.total,
            subtotal: calculo.subtotal,
            items: calculo.items,
            // Listo para redirigir. Se devuelven tambien los campos sueltos por si
            // en el futuro se quiere usar un formulario o el widget.
            urlpago: `${urlcheckout}?${parametros.toString()}`,
            campos
        });

    } catch (error) {
        console.error('[pagos] error creando la orden:', error.message);
        res.status(500).json({ ok: false, errores: ['No pudimos preparar el pago. Intenta de nuevo.'] });
    }
};

// ------------------------------------------- sincronizacion idempotente

/*
Aplica el estado de una transaccion de Wompi sobre su fila de Pagos.
Es el unico punto que marca un pedido como PAGADO, y lo hace de forma idempotente:
 - se serializa por referencia con un candado
 - se relee la fila dentro del candado
 - el pedido se escribe en Orders una sola vez, protegido por la bandera ordenescrita
*/
const sincronizar = async (transaccion, fuente) => {
    const referencia = transaccion?.reference;
    if (!referencia) return { ok: false, motivo: 'la transaccion no trae referencia' };

    return conbloqueo(referencia, async () => {
        const encontrado = await buscarporreferencia(referencia);
        if (!encontrado) {
            console.warn(`[pagos] ${fuente}: referencia desconocida ${referencia}`);
            return { ok: false, motivo: 'referencia desconocida' };
        }

        const { fila, numerofila } = encontrado;
        const estadowompi = transaccion.status;
        const montoevento = Number(transaccion.amount_in_cents);
        const resumen = `${fuente} ${estadowompi} tx=${transaccion.id || 's/id'}`;

        // El monto del evento debe coincidir con el que se firmo al crear la orden
        if (montoevento !== fila.montoencentavos) {
            console.error(`[pagos] ${referencia}: monto no coincide (evento ${montoevento}, orden ${fila.montoencentavos}). No se aprueba.`);
            await actualizarpago(numerofila, fila, {
                ultimoevento: `${resumen} MONTO_NO_COINCIDE ${montoevento}`
            });
            return { ok: false, motivo: 'el monto no coincide', fila };
        }

        // Ya estaba en un estado final: no se degrada ni se reprocesa
        if (esfinaldelteo(fila.estado)) {
            if (fila.estado === ESTADOS.PAGADO && !fila.ordenescrita) {
                // Recuperacion: quedo pagado pero el pedido no llego a Orders
                await escribirorden(fila, transaccion);
                const recuperada = await actualizarpago(numerofila, fila, {
                    ordenescrita: true,
                    ultimoevento: `${resumen} ORDEN_RECUPERADA`
                });
                console.log(`[pagos] ${referencia}: orden recuperada y escrita en Orders`);
                return { ok: true, fila: recuperada, duplicado: false };
            }
            console.log(`[pagos] ${referencia}: ${resumen} ignorado, ya estaba en ${fila.estado}`);
            return { ok: true, fila, duplicado: true };
        }

        const nuevoestado = estadodesdewompi(estadowompi);
        let ordenescrita = fila.ordenescrita;

        if (nuevoestado === ESTADOS.PAGADO && !ordenescrita) {
            await escribirorden(fila, transaccion);
            ordenescrita = true;
            console.log(`[pagos] ${referencia}: pago aprobado por ${fuente}, pedido agregado a Orders`);
        }

        const actualizada = await actualizarpago(numerofila, fila, {
            estado: nuevoestado,
            transaccionid: transaccion.id || fila.transaccionid,
            metodopago: transaccion.payment_method_type || fila.metodopago,
            email: transaccion.customer_email || fila.email,
            ordenescrita,
            ultimoevento: resumen
        });

        // Traza de todo cambio de estado, no solo de los aprobados, para poder depurar en Render
        if (nuevoestado !== ESTADOS.PAGADO) {
            console.log(`[pagos] ${referencia}: ${resumen} -> ${nuevoestado}`);
        }

        return { ok: true, fila: actualizada, duplicado: false };
    });
};

// Escribe el pedido en la pestaña Orders reutilizando el helper que ya existia
const escribirorden = async (fila, transaccion) => {
    const productostext = fila.items.map(item => `${item.cantidad} - ${item.nombre} || `).join('');
    const total = fila.montoencentavos / 100;

    await enviarpedidoinfo({
        cliente: fila.cliente?.nombre || '',
        origen: `Wompi ${transaccion.payment_method_type || ''}`.trim(),
        fecha: fechadehoy(),
        productos: fila.items,
        productostext,
        ciudad: fila.cliente?.ciudad || '',
        direccion: fila.cliente?.direccion || '',
        telefono: fila.cliente?.telefono || '',
        cedula: fila.cliente?.cedula || '',
        total
    });
};

// ----------------------------------------------- POST /api/wompi/webhook

const webhook = async (req, res) => {
    const evento = req.body;

    try {
        // La verificacion usa el secreto de eventos y las properties del propio evento
        const revision = verificarevento(evento, req.get('X-Event-Checksum'));

        if (!revision.valido) {
            console.warn(`[webhook] evento rechazado: ${revision.motivo}`);
            return res.status(401).json({ ok: false });
        }

        if (evento.event !== 'transaction.updated') {
            console.log(`[webhook] evento ignorado: ${evento.event}`);
            return res.status(200).json({ ok: true });
        }

        const transaccion = evento.data?.transaction;
        const ambienteesperado = config().ambiente === 'production' ? 'prod' : 'test';
        if (evento.environment && evento.environment !== ambienteesperado) {
            console.warn(`[webhook] ambiente del evento (${evento.environment}) no coincide con ${ambienteesperado}`);
            return res.status(200).json({ ok: true });
        }

        const resultado = await sincronizar(transaccion, 'webhook');

        /*
        Se responde 200 tambien cuando la referencia es desconocida o el monto no cuadra:
        reintentar no lo va a arreglar y Wompi solo reintenta 3 veces. El caso queda
        registrado en el log y en la columna ultimoevento para revisarlo.
        */
        if (!resultado.ok) console.warn(`[webhook] ${transaccion?.reference}: ${resultado.motivo}`);

        res.status(200).json({ ok: true });

    } catch (error) {
        // Un 500 hace que Wompi reintente (30 min, 3 h, 24 h), que es lo que queremos
        // ante un fallo transitorio del Sheet o de la red
        console.error('[webhook] fallo procesando el evento:', error.message);
        res.status(500).json({ ok: false });
    }
};

// ------------------------------------------------ GET /api/pagos/:idtx

/*
La pagina de resultado usa esto para mostrarle al cliente como quedo su pago.
Consulta el estado REAL contra el API de Wompi con la llave privada y aplica
la misma sincronizacion idempotente que el webhook. Sirve ademas de red de
seguridad cuando el webhook se pierde o llega tarde por un arranque en frio.
*/
const consultarpago = async (req, res) => {
    try {
        const idtransaccion = limpiar(req.params.idtransaccion, 100);
        if (!idtransaccion) return res.status(400).json({ ok: false, error: 'falta el id de transaccion' });

        const transaccion = await consultartransaccion(idtransaccion);
        if (!transaccion) {
            return res.status(404).json({ ok: false, estado: 'DESCONOCIDO', error: 'transaccion no encontrada' });
        }

        const resultado = await sincronizar(transaccion, 'consulta');
        const fila = resultado.fila;

        res.json({
            ok: true,
            estadowompi: transaccion.status,
            estado: fila?.estado || estadodesdewompi(transaccion.status),
            referencia: transaccion.reference,
            metodopago: transaccion.payment_method_type || null,
            total: fila ? fila.montoencentavos / 100 : Number(transaccion.amount_in_cents) / 100,
            items: fila?.items || [],
            nombre: fila?.cliente?.nombre || null,
            ciudad: fila?.cliente?.ciudad || null,
            zona: fila?.cliente?.zona || null,
            registrado: Boolean(fila?.ordenescrita)
        });

    } catch (error) {
        console.error('[pagos] error consultando la transaccion:', error.message);
        res.status(502).json({ ok: false, error: 'no pudimos consultar el estado del pago' });
    }
};

export { crearorden, webhook, consultarpago };
