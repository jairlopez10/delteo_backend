import { google } from 'googleapis';

const enviarpedidoinfo = async (datos) => {

    const { cliente, origen, fecha, productostext, productos, ciudad, direccion, telefono, total, cedula } = datos


    

    const auth = await google.auth.getClient({
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    })

    const sheets = google.sheets({version: 'v4', auth});

    const rangenextrow = 'Settings!A2:B2';

    const responseget = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SHEET_ID,
        range: rangenextrow,
    })

    const nextrowtoprintorders = +responseget.data.values[0][0]
    const nextrowtoprintdetaild = +responseget.data.values[0][1]

    const range = `Orders!B${nextrowtoprintorders}`;
    const rangedetaild = `Orders_DB_detailed!B${nextrowtoprintdetaild}`

    let orderdetaildprint = [];

    productos.forEach((prod) => {
        orderdetaildprint.push([nextrowtoprintorders-1, prod.id, prod.cantidad])
    })

    console.log(datos);

    const response = await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SHEET_ID,
        range,
        valueInputOption: 'USER_ENTERED',
        resource: {
            values: [[cliente, origen, fecha, productostext, ciudad, direccion, telefono, cedula, total]]
        }
    })

    const responsedetailed = await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SHEET_ID_ORDERDETAILD,
        range: rangedetaild,
        valueInputOption: 'USER_ENTERED',
        resource: {
            values: orderdetaildprint
        }
    })



}

export default enviarpedidoinfo;