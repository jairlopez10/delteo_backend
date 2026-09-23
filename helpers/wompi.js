import crypto from 'crypto';

/*
Todo lo que toca a Wompi vive aqui.

Reglas de seguridad:
- La llave privada y los secretos de integridad y eventos NUNCA salen del backend.
- La firma de integridad se calcula aqui, nunca en el navegador.
- El estado real de una transaccion se consulta contra el API con la llave privada.

Cambiar de Sandbox a Produccion es solo cambiar las variables de entorno.
*/

const URLS = {
    sandbox: 'https://sandbox.wompi.co/v1',
    production: 'https://production.wompi.co/v1'
}

// La URL del checkout es la misma en ambos ambientes: el ambiente lo determina
// el prefijo de la llave publica (pub_test_ vs pub_prod_).
const URL_CHECKOUT = 'https://checkout.wompi.co/p/';

export const MONEDA = 'COP';

// Estados finales segun la documentacion de Wompi
export const ESTADOS_FINALES = ['APPROVED', 'DECLINED', 'VOIDED', 'ERROR'];

export const esestadofinal = (estado) => ESTADOS_FINALES.includes(estado);

const leerconfig = () => {
    const ambiente = (process.env.WOMPI_ENV || 'sandbox').toLowerCase();

    if (!URLS[ambiente]) {
        throw new Error(`WOMPI_ENV invalido: "${ambiente}". Usa "sandbox" o "production".`);
    }

    const config = {
        ambiente,
        apiurl: process.env.WOMPI_API_URL || URLS[ambiente],
        urlcheckout: URL_CHECKOUT,
        llavepublica: process.env.WOMPI_PUBLIC_KEY,
        llaveprivada: process.env.WOMPI_PRIVATE_KEY,
        secretointegridad: process.env.WOMPI_INTEGRITY_SECRET,
        secretoeventos: process.env.WOMPI_EVENTS_SECRET
    };

    const faltantes = ['llavepublica', 'llaveprivada', 'secretointegridad', 'secretoeventos']
        .filter(clave => !config[clave]);

    if (faltantes.length) {
        throw new Error(
            'Faltan variables de entorno de Wompi: ' +
            faltantes.map(f => ({
                llavepublica: 'WOMPI_PUBLIC_KEY',
                llaveprivada: 'WOMPI_PRIVATE_KEY',
                secretointegridad: 'WOMPI_INTEGRITY_SECRET',
                secretoeventos: 'WOMPI_EVENTS_SECRET'
            })[f]).join(', ')
        );
    }

    // Aviso temprano si las llaves no corresponden al ambiente declarado
    const prefijo = ambiente === 'production' ? 'prod' : 'test';
    if (!config.llavepublica.startsWith(`pub_${prefijo}_`)) {
        throw new Error(`WOMPI_PUBLIC_KEY no corresponde a WOMPI_ENV=${ambiente} (se esperaba pub_${prefijo}_)`);
    }
    if (!config.llaveprivada.startsWith(`prv_${prefijo}_`)) {
        throw new Error(`WOMPI_PRIVATE_KEY no corresponde a WOMPI_ENV=${ambiente} (se esperaba prv_${prefijo}_)`);
    }

    return config;
}

// Se valida la primera vez que se usa, no al arrancar, para que el flujo de
// contraentrega siga funcionando aunque Wompi no este configurado todavia.
let configcache;
export const config = () => {
    if (!configcache) configcache = leerconfig();
    return configcache;
}

// Solo lo que es seguro mandar al navegador
export const configpublica = () => {
    const { llavepublica, ambiente, urlcheckout } = config();
    return { llavepublica, ambiente, urlcheckout };
}

const sha256 = (texto) => crypto.createHash('sha256').update(texto, 'utf8').digest('hex');

/*
Firma de integridad.
Concatenacion segun la documentacion (el orden importa):
  <Referencia><Monto><Moneda><SecretoIntegridad>
y si se usa expiracion:
  <Referencia><Monto><Moneda><FechaExpiracion><SecretoIntegridad>
*/
export const firmaintegridad = ({ referencia, montoencentavos, moneda = MONEDA, expiracion }) => {
    const { secretointegridad } = config();
    const cadena = expiracion
        ? `${referencia}${montoencentavos}${moneda}${expiracion}${secretointegridad}`
        : `${referencia}${montoencentavos}${moneda}${secretointegridad}`;
    return sha256(cadena);
}

// Lee una propiedad tipo "transaction.status" dentro del objeto data del evento
const leerpropiedad = (objeto, ruta) =>
    ruta.split('.').reduce((actual, parte) => (actual == null ? actual : actual[parte]), objeto);

/*
Verifica que un evento venga realmente de Wompi.
Concatena los valores de signature.properties (en su orden), luego timestamp,
luego el secreto de eventos, y compara el SHA256 contra el checksum recibido.

Las properties NO se asumen fijas: siempre se leen del evento, como pide la documentacion.
*/
export const verificarevento = (evento, checksumcabecera) => {
    const { secretoeventos } = config();

    const propiedades = evento?.signature?.properties;
    const checksumevento = evento?.signature?.checksum;
    const checksumesperado = checksumcabecera || checksumevento;

    if (!Array.isArray(propiedades) || !propiedades.length) return { valido: false, motivo: 'evento sin signature.properties' };
    if (!checksumesperado) return { valido: false, motivo: 'evento sin checksum' };
    if (evento.timestamp === undefined || evento.timestamp === null) return { valido: false, motivo: 'evento sin timestamp' };

    let cadena = '';
    for (const propiedad of propiedades) {
        const valor = leerpropiedad(evento.data, propiedad);
        if (valor === undefined || valor === null) {
            return { valido: false, motivo: `la propiedad "${propiedad}" no existe en data` };
        }
        cadena += valor;
    }
    cadena += evento.timestamp;
    cadena += secretoeventos;

    const calculado = sha256(cadena);
    const recibido = String(checksumesperado).toLowerCase();

    // Comparacion en tiempo constante para no filtrar informacion por el tiempo de respuesta
    const a = Buffer.from(calculado, 'utf8');
    const b = Buffer.from(recibido, 'utf8');
    const valido = a.length === b.length && crypto.timingSafeEqual(a, b);

    return valido ? { valido: true } : { valido: false, motivo: 'checksum no coincide' };
}

/*
Consulta el estado real de una transaccion.
La documentacion es explicita: desde esta version solo funciona con llave privada
desde el servidor. Con llave publica o sin autenticacion responde 404.
*/
export const consultartransaccion = async (idtransaccion) => {
    const { apiurl, llaveprivada } = config();

    const respuesta = await fetch(`${apiurl}/transactions/${encodeURIComponent(idtransaccion)}`, {
        headers: { Authorization: `Bearer ${llaveprivada}` },
        signal: AbortSignal.timeout(15000)
    });

    if (respuesta.status === 404) return null;

    if (!respuesta.ok) {
        const cuerpo = await respuesta.text();
        throw new Error(`Wompi respondio ${respuesta.status} al consultar la transaccion: ${cuerpo.slice(0, 300)}`);
    }

    const json = await respuesta.json();
    return json?.data || null;
}

// Referencia unica de pago. Nunca se reutiliza: cada intento genera una nueva.
export const generarreferencia = (ordenid, intento) =>
    `DELTEO-${ordenid}-${intento}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

export const pesosacentavos = (pesos) => Math.round(Number(pesos) * 100);
