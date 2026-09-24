import enviarpedidoinfo from "../helpers/enviarpedidoinfo.js"
import { calcularorden } from "../helpers/precios.js"
import { conbloqueo } from "../helpers/pagossheet.js"
import { atribuciondelrequest, enviarpurchase, eventidpurchase } from "../helpers/metacapi.js"

/*
Pedido contra entrega.

El checkout genera un pedidoid por intento de compra y lo repite en cada reintento.
Sirve para dos cosas:
 - Si el primer envio se escribio pero la respuesta no llego, el reintento no
   vuelve a escribir la fila (mientras el servidor siga vivo).
 - Es el event_id del Purchase: el Pixel del navegador y CAPI mandan el mismo,
   y Meta los deduplica.
*/

const PEDIDOID = /^[A-Za-z0-9-]{8,64}$/
const RECIENTES_MAX = 500

// pedidoid ya escritos en Orders por este proceso
const escritos = new Set()

const recordar = (pedidoid) => {
    escritos.add(pedidoid)
    if (escritos.size > RECIENTES_MAX) escritos.delete(escritos.values().next().value)
}

// Items y total para Meta. Si el catalogo del backend no reconoce el carrito se usa
// lo que mando el navegador, que es lo mismo que queda en el Sheet.
const datosparameta = (pedidoinfo) => {
    const productos = Array.isArray(pedidoinfo.productos) ? pedidoinfo.productos : []
    const calculo = calcularorden(productos.map(({ id, nombre, cantidad }) => ({ id, nombre, cantidad: Number(cantidad) })))
    if (calculo.ok) return { total: calculo.total, items: calculo.items }

    return {
        total: Number(pedidoinfo.total) || 0,
        items: productos.map(item => ({
            idproducto: item.idproducto ?? item.id,
            cantidad: Number(item.cantidad) || 1,
            preciounitario: Number(item.precio) || 0
        }))
    }
}

const enviarpedido = async (req, res) => {

    const { pedidoid: pedidoidcrudo, atribucion, ...pedidoinfo } = req.body || {}
    const pedidoid = PEDIDOID.test(String(pedidoidcrudo ?? '')) ? String(pedidoidcrudo) : null

    try {
        // Sin pedidoid (una version vieja del frontend en cache) funciona como antes, sin CAPI
        if (!pedidoid) {
            await enviarpedidoinfo(pedidoinfo);
            return res.json({ msg: 'Pedido agregado al Sheet' })
        }

        const duplicado = await conbloqueo(`contraentrega:${pedidoid}`, async () => {
            if (escritos.has(pedidoid)) return true
            await enviarpedidoinfo(pedidoinfo);
            recordar(pedidoid)
            return false
        })

        if (duplicado) {
            console.log(`[pedidos] ${pedidoid}: reintento de un pedido ya escrito, no se duplica`)
        } else {
            // Sin await: Meta no debe demorar la confirmacion del pedido
            const { total, items } = datosparameta(pedidoinfo)
            enviarpurchase({
                eventid: eventidpurchase(pedidoid),
                total,
                items,
                atribucion: atribuciondelrequest(req, atribucion)
            })
        }

        res.json({ msg: 'Pedido agregado al Sheet', pedidoid })

    } catch (error) {
        console.log(error);
        // Antes no se respondia y el navegador quedaba esperando
        res.status(500).json({ msg: 'No pudimos registrar el pedido' })
    }

}

export {
    enviarpedido
}
