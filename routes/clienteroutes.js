import express from 'express';
import { enviarpedido } from '../controllers/clienteController.js';

const router = express.Router();

router.post('/', enviarpedido)


export default router;