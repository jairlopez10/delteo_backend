// Pruebas del calculo de precios del servidor. Ejecutar con: npm run probar:precios
// No toca la red ni el Sheet.
import { calcularorden, reglas } from '../helpers/precios.js';

let fallos = 0;
const revisar = (nombre, real, esperado) => {
    const ok = JSON.stringify(real) === JSON.stringify(esperado);
    if (!ok) fallos++;
    console.log(`  ${ok ? 'OK  ' : 'FALLO'} ${nombre}`);
    if (!ok) {
        console.log(`        obtenido: ${JSON.stringify(real)}`);
        console.log(`        esperado: ${JSON.stringify(esperado)}`);
    }
};

const M416 = { id: 376, nombre: 'M416 Hidrogel Recargable con Luz y Humo' };
const ORVIS = { id: 362, nombre: 'Orvis Hidrogel X 10.000 Unds' };
const LEGO_AZUL = { id: 390, nombre: 'Lego de Minecraft y Luz de 239pcs (Azul)' };

console.log('--- Precios base ---');
let r = calcularorden([{ ...M416, cantidad: 1 }]);
revisar('M416 solo = 149.900', r.total, 149900);
revisar('M416 ok', r.ok, true);

r = calcularorden([{ ...LEGO_AZUL, cantidad: 2 }]);
revisar('variante hereda precio del padre (94.900 x2)', r.total, 189800);

console.log('--- Regla del order bump ---');
r = calcularorden([{ ...M416, cantidad: 1 }, { ...ORVIS, cantidad: 2 }]);
revisar('Orvis con lanzadora = precio bump 7.900', r.items.find(i => i.id === 362).preciounitario, 7900);
revisar('total con bump', r.total, 149900 + 7900 * 2);

r = calcularorden([{ ...ORVIS, cantidad: 6 }]);
revisar('Orvis sin lanzadora = precio suelto 17.900', r.items[0].preciounitario, 17900);
revisar('total sin bump', r.total, 17900 * 6);

console.log('--- El precio del navegador se ignora ---');
r = calcularorden([{ ...M416, cantidad: 1, precio: 1 }, { ...ORVIS, cantidad: 1, precio: 1, subtotal: 2 }]);
revisar('precio enviado por el cliente no afecta', r.total, 149900 + 7900);

console.log('--- Validaciones ---');
revisar('carrito vacio', calcularorden([]).ok, false);
revisar('no es arreglo', calcularorden(null).ok, false);
revisar('id inexistente', calcularorden([{ id: 999999, nombre: 'Inventado', cantidad: 1 }]).ok, false);
revisar('nombre que no corresponde al id', calcularorden([{ id: 376, nombre: 'Otro nombre', cantidad: 1 }]).ok, false);
revisar('cantidad 0', calcularorden([{ ...M416, cantidad: 0 }]).ok, false);
revisar('cantidad negativa', calcularorden([{ ...M416, cantidad: -3 }]).ok, false);
revisar('cantidad decimal', calcularorden([{ ...M416, cantidad: 1.5 }]).ok, false);
revisar('cantidad absurda', calcularorden([{ ...M416, cantidad: 9999 }]).ok, false);

console.log('--- Pedido minimo ---');
r = calcularorden([{ ...ORVIS, cantidad: 1 }]);
revisar(`por debajo del minimo (${reglas().pedidominimo}) se rechaza`, r.ok, false);
revisar('pero devuelve el total calculado', r.total, 17900);

console.log('--- Colision del id 386 (dos productos distintos) ---');
const p386a = calcularorden([{ id: 386, nombre: 'Computador con Pantalla y Mousee (Princesas)', cantidad: 1 }]);
const p386b = calcularorden([{ id: 386, nombre: 'Computador con Pantalla Interactivo (Rosado)', cantidad: 1 }]);
revisar('variante Princesas resuelve', p386a.total, 79900);
revisar('variante Rosado resuelve', p386b.total, 79900);
revisar('id 386 sin nombre valido se rechaza', calcularorden([{ id: 386, nombre: '', cantidad: 1 }]).ok, false);

console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
