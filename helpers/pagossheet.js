import { google } from 'googleapis';
import obtenerauth from './googleauth.js';

/*
Almacen de ordenes e intentos de pago, sobre una pestaña "Pagos" del mismo Sheet.

No hay base de datos, asi que la idempotencia del webhook se consigue con tres capas:
  1. Un candado en memoria por referencia (Render corre una sola instancia).
  2. Relectura de la fila dentro del candado antes de escribir.
  3. La bandera ordenescrita, que garantiza que el pedido se agregue a Orders una sola vez.

OJO: el candado en memoria deja de servir si algun dia se corre mas de una instancia.
*/

export const PESTANA = 'Pagos';

const COLUMNAS = [
    'referencia', 'ordenid', 'estado', 'montoencentavos', 'transaccionid',
    'metodopago', 'email', 'creado', 'actualizado', 'ordenescrita',
    'cliente', 'items', 'ultimoevento'
];

export const ESTADOS = {
    PENDIENTE: 'PENDIENTE_PAGO',
    EN_PROCESO: 'PAGO_EN_PROCESO',
    PAGADO: 'PAGADO',
    RECHAZADO: 'PAGO_RECHAZADO',
    ANULADO: 'PAGO_ANULADO',
    ERROR: 'PAGO_ERROR'
};

// Un estado de Wompi se traduce a un estado de pedido de Delteo
export const estadodesdewompi = (estadowompi) => ({
    PENDING: ESTADOS.EN_PROCESO,
    APPROVED: ESTADOS.PAGADO,
    DECLINED: ESTADOS.RECHAZADO,
    VOIDED: ESTADOS.ANULADO,
    ERROR: ESTADOS.ERROR
})[estadowompi] || ESTADOS.EN_PROCESO;

export const esfinaldelteo = (estado) =>
    [ESTADOS.PAGADO, ESTADOS.RECHAZADO, ESTADOS.ANULADO, ESTADOS.ERROR].includes(estado);

const hojaid = () => process.env.SHEET_ID;

const obtenersheets = async () => {
    const auth = await obtenerauth();
    return google.sheets({ version: 'v4', auth });
};

// ---------------------------------------------------------------- candado

const candados = new Map();

/*
Serializa las operaciones sobre una misma referencia: dos webhooks de la misma
transaccion no pueden leer y escribir a la vez.
*/
export const conbloqueo = async (referencia, tarea) => {
    const anterior = candados.get(referencia) || Promise.resolve();

    let liberar;
    const actual = new Promise(resolve => { liberar = resolve; });
    const cadena = anterior.then(() => actual);
    candados.set(referencia, cadena);

    await anterior.catch(() => {});

    try {
        return await tarea();
    } finally {
        liberar();
        // Solo se limpia si nadie mas se encadeno detras
        if (candados.get(referencia) === cadena) candados.delete(referencia);
    }
};

// ------------------------------------------------------------- estructura

let pestanalista = false;

/*
Crea la pestaña Pagos con sus encabezados si todavia no existe.
Es aditivo: no toca Orders, Orders_DB_detailed ni Settings.
*/
export const asegurarpestana = async () => {
    if (pestanalista) return;

    const sheets = await obtenersheets();
    const libro = await sheets.spreadsheets.get({ spreadsheetId: hojaid() });
    const existe = libro.data.sheets.some(hoja => hoja.properties.title === PESTANA);

    if (!existe) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: hojaid(),
            resource: { requests: [{ addSheet: { properties: { title: PESTANA } } }] }
        });
        await sheets.spreadsheets.values.update({
            spreadsheetId: hojaid(),
            range: `${PESTANA}!A1:M1`,
            valueInputOption: 'RAW',
            resource: { values: [COLUMNAS] }
        });
        console.log(`[pagos] pestaña "${PESTANA}" creada con sus encabezados`);
    }

    pestanalista = true;
};

// --------------------------------------------------------------- lectura

const afila = (valores) => {
    if (!valores) return null;

    const fila = {};
    COLUMNAS.forEach((columna, i) => { fila[columna] = valores[i] ?? ''; });

    fila.montoencentavos = Number(fila.montoencentavos) || 0;
    fila.ordenescrita = fila.ordenescrita === 'SI';

    try {
        fila.cliente = fila.cliente ? JSON.parse(fila.cliente) : null;
    } catch { fila.cliente = null; }
    try {
        fila.items = fila.items ? JSON.parse(fila.items) : [];
    } catch { fila.items = []; }

    return fila;
};

const leertodas = async () => {
    await asegurarpestana();
    const sheets = await obtenersheets();
    const respuesta = await sheets.spreadsheets.values.get({
        spreadsheetId: hojaid(),
        range: `${PESTANA}!A:M`
    });
    return respuesta.data.values || [];
};

/*
Devuelve { fila, numerofila } o null.
numerofila es la fila real del Sheet (1-indexada) para poder actualizarla despues.
*/
const buscarpor = (filas, indicecolumna, valor) => {
    for (let i = 1; i < filas.length; i++) {
        if (filas[i][indicecolumna] === valor) {
            return { fila: afila(filas[i]), numerofila: i + 1 };
        }
    }
    return null;
};

export const buscarporreferencia = async (referencia) =>
    buscarpor(await leertodas(), 0, referencia);

export const buscarportransaccion = async (transaccionid) =>
    buscarpor(await leertodas(), 4, transaccionid);

// -------------------------------------------------------------- escritura

export const crearpago = async ({ referencia, ordenid, montoencentavos, cliente, items }) => {
    await asegurarpestana();
    const sheets = await obtenersheets();
    const ahora = new Date().toISOString();

    const valores = [
        referencia,
        ordenid,
        ESTADOS.PENDIENTE,
        montoencentavos,
        '',                              // transaccionid: todavia no existe
        '',                              // metodopago: lo aporta Wompi
        '',                              // email: lo aporta Wompi
        ahora,
        ahora,
        'NO',                            // ordenescrita
        JSON.stringify(cliente),
        JSON.stringify(items),
        ''
    ];

    // append es atomico del lado de Google y no depende del contador de Settings
    await sheets.spreadsheets.values.append({
        spreadsheetId: hojaid(),
        range: `${PESTANA}!A:M`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: { values: [valores] }
    });

    return { referencia, ordenid, estado: ESTADOS.PENDIENTE, montoencentavos, cliente, items, ordenescrita: false };
};

export const actualizarpago = async (numerofila, filaactual, cambios) => {
    const sheets = await obtenersheets();

    const fusionada = { ...filaactual, ...cambios, actualizado: new Date().toISOString() };

    const valores = COLUMNAS.map(columna => {
        const valor = fusionada[columna];
        if (columna === 'ordenescrita') return valor ? 'SI' : 'NO';
        if (columna === 'cliente') return JSON.stringify(valor ?? null);
        if (columna === 'items') return JSON.stringify(valor ?? []);
        return valor ?? '';
    });

    await sheets.spreadsheets.values.update({
        spreadsheetId: hojaid(),
        range: `${PESTANA}!A${numerofila}:M${numerofila}`,
        valueInputOption: 'RAW',
        resource: { values: [valores] }
    });

    return fusionada;
};
