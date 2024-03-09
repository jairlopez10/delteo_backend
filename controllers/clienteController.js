import enviarpedidoinfo from "../helpers/enviarpedidoinfo.js"

const enviarpedido = async (req, res) => {

    const pedidoinfo = req.body

    try {
        await enviarpedidoinfo(pedidoinfo);
        res.json({msg: 'Pedido agregado al Sheet'})
    } catch (error) {
        console.log(error);
    }

}

export {
    enviarpedido
}