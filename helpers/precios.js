import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/*
Recalcula el precio de una orden usando SIEMPRE el catalogo del backend.

El navegador manda unicamente id, nombre y cantidad. Cualquier precio que venga
en la peticion se ignora: si el cliente edita el localStorage no cambia lo que cobra.

El par (id, nombre) es lo que identifica un item, porque el carrito guarda el id de la
variante y varios ids de variante se repiten entre productos distintos (por ejemplo el 386).
*/

const aqui = path.dirname(fileURLToPath(import.meta.url));
const RUTA_CATALOGO = path.join(aqui, '..', 'data', 'catalogo.json');

const CANTIDAD_MAXIMA = 20;

let catalogocache;

const catalogo = () => {
    if (!catalogocache) {
        const crudo = JSON.parse(fs.readFileSync(RUTA_CATALOGO, 'utf8'));
        const porclave = new Map();
        crudo.items.forEach(item => porclave.set(`${item.id}|${item.nombre}`, item));
        catalogocache = { ...crudo, porclave };
    }
    return catalogocache;
};

export const reglas = () => catalogo().reglas;

const normalizartexto = (valor) => String(valor ?? '').trim();

/*
Devuelve { ok, items, subtotal, total, errores }.
Los montos van en pesos enteros: el peso colombiano no usa decimales.
*/
export const calcularorden = (itemscarrito) => {
    const { porclave, reglas: r } = catalogo();
    const errores = [];

    if (!Array.isArray(itemscarrito) || itemscarrito.length === 0) {
        return { ok: false, items: [], subtotal: 0, total: 0, errores: ['El carrito esta vacio.'] };
    }

    if (itemscarrito.length > 50) {
        return { ok: false, items: [], subtotal: 0, total: 0, errores: ['El carrito tiene demasiados productos.'] };
    }

    // Primero se resuelve cada item contra el catalogo
    const resueltos = [];
    const idspresentes = new Set();

    itemscarrito.forEach((entrada, indice) => {
        const id = Number(entrada?.id);
        const nombre = normalizartexto(entrada?.nombre);
        const cantidad = Number(entrada?.cantidad);

        if (!Number.isInteger(id)) {
            errores.push(`El producto #${indice + 1} no tiene un id valido.`);
            return;
        }
        if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > CANTIDAD_MAXIMA) {
            errores.push(`La cantidad de "${nombre || id}" no es valida (1 a ${CANTIDAD_MAXIMA}).`);
            return;
        }

        const item = porclave.get(`${id}|${nombre}`);
        if (!item) {
            errores.push(`No reconocemos el producto "${nombre || id}". Quitalo del carrito y vuelve a agregarlo.`);
            return;
        }
        if (item.status !== 'disponible') {
            errores.push(`"${item.nombre}" ya no esta disponible. Quitalo del carrito para continuar.`);
            return;
        }

        idspresentes.add(id);
        resueltos.push({ item, cantidad });
    });

    if (errores.length) {
        return { ok: false, items: [], subtotal: 0, total: 0, errores };
    }

    /*
    Regla del order bump: el Orvis vale menos cuando acompaña a una lanzadora de hidrogel.
    La decide el backend mirando el resto del carrito, nunca el navegador, porque si no
    bastaria con decir "es un bump" para pagar menos.
    */
    const hayLanzadora = r.bump.requierealgunid.some(id => idspresentes.has(id));

    const items = resueltos.map(({ item, cantidad }) => {
        const esbump = item.id === r.bump.id && item.nombre === r.bump.nombre;
        const preciounitario = (esbump && hayLanzadora) ? r.bump.preciobump : item.precio;

        return {
            id: item.id,
            nombre: item.nombre,
            cantidad,
            preciounitario,
            subtotal: preciounitario * cantidad
        };
    });

    const subtotal = items.reduce((suma, item) => suma + item.subtotal, 0);
    const descuento = 0;               // hoy siempre 0, igual que en el checkout actual
    const total = subtotal - descuento;

    if (subtotal < r.pedidominimo) {
        errores.push(`El pedido minimo es de $${r.pedidominimo.toLocaleString('es-CO')}.`);
    }

    return { ok: errores.length === 0, items, subtotal, descuento, total, errores };
};
