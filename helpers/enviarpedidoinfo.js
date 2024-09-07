import { google } from 'googleapis';

const enviarpedidoinfo = async (datos) => {

    const { cliente, origen, fecha, productostext, productos, ciudad, direccion, telefono, total, cedula } = datos

    const auth = await google.auth.getClient({
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
    })

    const sheets = google.sheets({version: 'v4', auth});

    const rangenextrow = 'Settings!A2';

    const responseget = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SHEET_ID,
        range: rangenextrow,
    })

    const nextrowtoprint = +responseget.data.values[0][0]

    const range = `Orders!B${nextrowtoprint}`;

    const response = await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.SHEET_ID,
        range,
        valueInputOption: 'USER_ENTERED',
        resource: {
            values: [[cliente, origen, fecha, productostext, ciudad, direccion, telefono, cedula, total]]
        }
    })

}

export default enviarpedidoinfo;