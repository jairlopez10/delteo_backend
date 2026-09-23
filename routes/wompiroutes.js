import express from 'express';
import { webhook } from '../controllers/pagosController.js';

const router = express.Router();

/*
URL de eventos de Wompi.

Se monta ANTES del middleware de CORS a proposito: la peticion viene del servidor de
Wompi y no trae header Origin, y el CORS actual rechaza cualquier origen que no este
en la lista (indexOf(undefined) da -1). CORS es una proteccion del navegador y no
aplica a una llamada servidor-a-servidor; la autenticidad del evento se valida con
el checksum firmado, que es el mecanismo que define Wompi.
*/
router.post('/webhook', webhook);

export default router;
