/*
Meta Conversions API (CAPI). SOLO se usa para Purchase.

Por que solo Purchase: es el unico evento que el servidor conoce con certeza y que
el navegador puede perder (pago de Wompi aprobado por webhook cuando el cliente
nunca volvio a la pagina, bloqueadores, navegador de Instagram). Los eventos de
navegacion (PageView, ViewContent, AddToCart, InitiateCheckout) los manda el Pixel.

Deduplicacion: el Pixel del navegador manda el mismo Purchase con el mismo eventID.
Meta junta los dos si coinciden event_name + event_id.

Datos del usuario: solo fbp, fbc, IP y user agent, que sirven para atribuir la compra
al navegador y al clic del anuncio. Nunca nombre, celular, cedula, direccion ni email.

Sin META_PIXEL_ID o META_CAPI_TOKEN no se envia nada. Un fallo de Meta nunca
rompe un pedido: todo error se registra en el log y ya.
*/

const VERSION_API = () => process.env.META_API_VERSION || 'v23.0';
const RECIENTES_MAX = 500;

// event_id ya enviados en este proceso: evita un segundo envio si un reintento
// llega mientras el servidor sigue vivo. Meta igual deduplica por event_id.
const enviados = new Set();

const recordar = (eventid) => {
    enviados.add(eventid);
    if (enviados.size > RECIENTES_MAX) enviados.delete(enviados.values().next().value);
};

export const capiactiva = () => Boolean(process.env.META_PIXEL_ID && process.env.META_CAPI_TOKEN);

export const eventidpurchase = (idpedido) => `purchase_${idpedido}`;

// ------------------------------------------------ datos del navegador

// Formato de las cookies del Pixel: fb.<subdominio>.<timestamp>.<valor>
const COOKIE_FB = /^fb\.\d\.\d{10,13}\.[\w-]{1,500}$/;

const limpiarcookie = (valor) => {
    const texto = String(valor ?? '').trim();
    return COOKIE_FB.test(texto) ? texto : undefined;
};

const ipdelrequest = (req) => {
    // Render pone la IP real del cliente de primera en x-forwarded-for
    const reenviada = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
    const ip = reenviada || req.socket?.remoteAddress || '';
    return ip.replace(/^::ffff:/, '') || undefined;
};

// URL de la pagina sin query ni hash: no se manda nada que pueda traer datos del cliente
const limpiarurl = (valor) => {
    try {
        const url = new URL(String(valor));
        if (!/^https?:$/.test(url.protocol)) return undefined;
        return `${url.origin}${url.pathname}`;
    } catch {
        return undefined;
    }
};

/*
Lo que se guarda de la visita para atribuir la compra despues (por ejemplo desde el
webhook de Wompi, que no trae datos del navegador). El frontend manda fbp, fbc y la URL;
la IP y el user agent salen del propio request.
*/
export const atribuciondelrequest = (req, delnavegador = {}) => {
    const atribucion = {
        fbp: limpiarcookie(delnavegador?.fbp),
        fbc: limpiarcookie(delnavegador?.fbc),
        url: limpiarurl(delnavegador?.url),
        ip: ipdelrequest(req),
        ua: String(req.get('user-agent') || '').slice(0, 400) || undefined
    };
    return Object.fromEntries(Object.entries(atribucion).filter(([, valor]) => valor));
};

// ---------------------------------------------------------- payload

/*
items: [{ idproducto, cantidad, preciounitario }] ya calculados por el backend.
El id que se manda es el del producto (no el de la variante), el mismo que usa el Pixel.
*/
export const construirpurchase = ({ eventid, total, items, atribucion = {}, momento = Date.now() }) => {
    const contents = items.map(item => ({
        id: String(item.idproducto),
        quantity: Number(item.cantidad),
        item_price: Number(item.preciounitario)
    }));

    const userdata = {
        client_ip_address: atribucion.ip,
        client_user_agent: atribucion.ua,
        fbp: atribucion.fbp,
        fbc: atribucion.fbc
    };

    return {
        event_name: 'Purchase',
        event_time: Math.floor(momento / 1000),
        event_id: eventid,
        action_source: 'website',
        event_source_url: atribucion.url,
        user_data: Object.fromEntries(Object.entries(userdata).filter(([, valor]) => valor)),
        custom_data: {
            currency: 'COP',
            value: Number(total),
            content_type: 'product',
            content_ids: [...new Set(contents.map(item => item.id))],
            contents,
            num_items: contents.reduce((suma, item) => suma + item.quantity, 0)
        }
    };
};

// ------------------------------------------------------------- envio

/*
Envia el Purchase a Meta. Nunca lanza: devuelve { enviado, motivo }.
Se puede inyectar fetch para las pruebas.
*/
export const enviarpurchase = async (datos, { fetchimpl = fetch } = {}) => {
    const { eventid } = datos;

    if (!capiactiva()) return { enviado: false, motivo: 'CAPI sin configurar' };
    if (!eventid) return { enviado: false, motivo: 'falta event_id' };
    if (enviados.has(eventid)) return { enviado: false, motivo: 'ya enviado' };

    const evento = construirpurchase(datos);

    // Meta exige al menos IP + user agent para eventos "website"
    if (!evento.user_data.client_user_agent) {
        console.warn(`[capi] ${eventid}: sin user agent, no se envia`);
        return { enviado: false, motivo: 'sin user agent' };
    }

    recordar(eventid);

    const cuerpo = { data: [evento] };
    if (process.env.META_TEST_EVENT_CODE) cuerpo.test_event_code = process.env.META_TEST_EVENT_CODE;

    const url = `https://graph.facebook.com/${VERSION_API()}/${process.env.META_PIXEL_ID}/events` +
        `?access_token=${encodeURIComponent(process.env.META_CAPI_TOKEN)}`;

    try {
        const respuesta = await fetchimpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(cuerpo),
            signal: AbortSignal.timeout(10000)
        });

        if (!respuesta.ok) {
            const texto = await respuesta.text();
            // Se olvida para que un reintento posterior (webhook de Wompi) pueda enviarlo
            enviados.delete(eventid);
            console.error(`[capi] ${eventid}: Meta respondio ${respuesta.status}: ${texto.slice(0, 300)}`);
            return { enviado: false, motivo: `Meta ${respuesta.status}` };
        }

        console.log(`[capi] ${eventid}: Purchase enviado (${evento.custom_data.value} COP)`);
        return { enviado: true };

    } catch (error) {
        enviados.delete(eventid);
        console.error(`[capi] ${eventid}: error enviando a Meta: ${error.message}`);
        return { enviado: false, motivo: error.message };
    }
};

// Solo para las pruebas
export const _olvidarenviados = () => enviados.clear();
