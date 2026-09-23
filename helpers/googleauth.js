import { google } from 'googleapis';

const scopes = ['https://www.googleapis.com/auth/spreadsheets'];

/*
Las credenciales del service account llegan por variable de entorno (el JSON en base64),
para que el archivo secrets.json no tenga que estar en el repositorio ni en el disco del servidor.

Si GOOGLE_CREDENTIALS_BASE64 no esta definida se usa el mecanismo anterior
(GOOGLE_APPLICATION_CREDENTIALS apuntando a un archivo), para no romper entornos ya configurados.
*/
const leercredenciales = () => {
    const base64 = process.env.GOOGLE_CREDENTIALS_BASE64;
    if (!base64) return null;

    let credenciales;
    try {
        credenciales = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
    } catch (error) {
        throw new Error('GOOGLE_CREDENTIALS_BASE64 no contiene un JSON valido codificado en base64');
    }

    if (!credenciales.client_email || !credenciales.private_key) {
        throw new Error('GOOGLE_CREDENTIALS_BASE64 no tiene client_email o private_key');
    }

    return credenciales;
}

let clientecache;

const obtenerauth = async () => {
    if (clientecache) return clientecache;

    const credentials = leercredenciales();
    const auth = credentials
        ? new google.auth.GoogleAuth({ credentials, scopes })
        : new google.auth.GoogleAuth({ scopes });

    clientecache = await auth.getClient();
    return clientecache;
}

export default obtenerauth;
