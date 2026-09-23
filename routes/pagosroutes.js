import express from 'express';
import { crearorden, consultarpago } from '../controllers/pagosController.js';

const router = express.Router();

// Crea la orden, calcula el total en el servidor y devuelve la URL de pago de Wompi
router.post('/ordenes', crearorden);

// Estado real de un pago, consultado a Wompi con la llave privada
router.get('/pagos/:idtransaccion', consultarpago);

export default router;
