import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors'
import clienteroutes from './routes/clienteroutes.js';
import wompiroutes from './routes/wompiroutes.js';
import pagosroutes from './routes/pagosroutes.js';


const app = express();
app.use(express.json());

dotenv.config();

/*
El webhook de Wompi va ANTES del CORS: llega desde los servidores de Wompi, sin
header Origin, y el filtro de abajo rechazaria la peticion. Su autenticidad se
valida con el checksum firmado del evento, no con CORS.
*/
app.use("/api/wompi", wompiroutes)

const dominiospermitidos = [process.env.FRONTEND_URL];

const coroptions = {
    origin: function(origin, callback) {
        if(dominiospermitidos.indexOf(origin) !== -1){
            //El origen del request esta permitido
            callback(null, true);
        } else {
            callback(new Error('No permitido por CORS'))
        }
    }
}

app.use(cors(coroptions))

app.use("/api/clientes", clienteroutes)
app.use("/api", pagosroutes)

const PORT = process.env.PORT || 4009

app.listen(PORT, () => {
    console.log(`Servidor funcionando en el puerto ${PORT}`)
})
