/*
Genera data/catalogo.json a partir del catalogo del frontend (Productosdb.jsx).

El backend necesita su propia copia de los precios porque es el que calcula el total
de una orden: nunca se confia en el precio que manda el navegador.

Uso:   npm run sync:catalogo
       npm run sync:catalogo -- ../ruta/alternativa/Productosdb.jsx

IMPORTANTE: cada vez que cambies un precio en el frontend hay que volver a correr esto.
*/
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';

// Mismas reglas que usa el frontend al agregar al carrito (src/paginas/Producto.jsx)
const ENVIO_PEQUENO = 10000;
const ENVIO_GRANDE = 20000;
const UMBRAL_ENVIO_GRANDE = 20000;
const PEDIDO_MINIMO = 44900;          // src/paginas/Checkout.jsx
const ID_ORVIS = 362;                 // order bump
const IDS_LANZADORAS_HIDROGEL = [376, 395, 401, 375];

const rutapordefecto = '../frontend/src/components/Productosdb.jsx';

const precioconenvio = (precio) =>
    precio >= UMBRAL_ENVIO_GRANDE ? precio + ENVIO_GRANDE : precio + ENVIO_PEQUENO;

// El archivo del frontend es JS plano con extension .jsx, asi que se importa
// desde una copia temporal .mjs en vez de intentar parsearlo con expresiones regulares.
const cargarproductos = async (ruta) => {
    const contenido = fs.readFileSync(ruta, 'utf8');
    const temporal = path.join(os.tmpdir(), `delteo-catalogo-${Date.now()}.mjs`);
    fs.writeFileSync(temporal, contenido, 'utf8');
    try {
        const modulo = await import(pathToFileURL(temporal).href);
        return modulo.default;
    } finally {
        fs.unlinkSync(temporal);
    }
}

const construiritems = (productos) => {
    const items = [];

    productos.forEach(producto => {
        const precio = precioconenvio(producto.precio);
        const variantes = Array.isArray(producto.colores) ? producto.colores : null;

        if (variantes) {
            // El carrito guarda el id de la variante y el nombre "Titulo (Texto)"
            variantes.forEach(opcion => {
                items.push({
                    id: opcion.id,
                    nombre: `${producto.titulo} (${opcion.texto})`,
                    precio,
                    preciobase: producto.precio,
                    status: producto.status,
                    idpadre: producto.id
                })
            })
        } else {
            items.push({
                id: producto.id,
                nombre: producto.titulo,
                precio,
                preciobase: producto.precio,
                status: producto.status,
                idpadre: null
            })
        }
    })

    return items;
}

const main = async () => {
    const rutarelativa = process.argv[2] || rutapordefecto;
    const ruta = path.resolve(process.cwd(), rutarelativa);

    if (!fs.existsSync(ruta)) {
        console.error(`No se encontro el catalogo del frontend en: ${ruta}`);
        console.error('Pasa la ruta como argumento: npm run sync:catalogo -- <ruta>');
        process.exit(1);
    }

    const productos = await cargarproductos(ruta);
    if (!Array.isArray(productos) || productos.length === 0) {
        console.error('El archivo no exporto un arreglo de productos');
        process.exit(1);
    }

    const items = construiritems(productos);

    // La clave "id|nombre" desambigua los ids de variante repetidos (por ejemplo el 386,
    // que es a la vez producto y variante de otros dos productos distintos).
    // Gana la PRIMERA aparicion, igual que el frontend: Producto.jsx resuelve el producto
    // con productosdb.find(...), que devuelve la primera coincidencia. Si el backend
    // eligiera otra, el total calculado no cuadraria con el que ve el cliente.
    const claves = new Map();
    const conflictos = [];
    const unicos = [];
    items.forEach(item => {
        const clave = `${item.id}|${item.nombre}`;
        const previo = claves.get(clave);
        if (previo) {
            if (previo.precio !== item.precio) {
                conflictos.push({ clave, usado: previo.precio, descartado: item.precio });
            }
            return;
        }
        claves.set(clave, item);
        unicos.push(item);
    })

    const orvis = items.find(item => item.id === ID_ORVIS && item.idpadre === null);
    if (!orvis) {
        console.error(`No se encontro el producto ${ID_ORVIS} (Orvis) para la regla del order bump`);
        process.exit(1);
    }

    const catalogo = {
        generado: new Date().toISOString(),
        origen: path.relative(process.cwd(), ruta).split(path.sep).join('/'),
        reglas: {
            enviopequeno: ENVIO_PEQUENO,
            enviogrande: ENVIO_GRANDE,
            umbralenviogrande: UMBRAL_ENVIO_GRANDE,
            pedidominimo: PEDIDO_MINIMO,
            // El Orvis vale menos cuando entra como order bump junto a una lanzadora.
            // Es el backend quien decide cual precio aplica, mirando el resto del carrito.
            bump: {
                id: ID_ORVIS,
                nombre: orvis.nombre,
                preciobump: orvis.preciobase,
                preciosuelto: orvis.precio,
                requierealgunid: IDS_LANZADORAS_HIDROGEL
            }
        },
        items: unicos.sort((a, b) => a.id - b.id)
    };

    fs.writeFileSync('data/catalogo.json', JSON.stringify(catalogo, null, 2) + '\n', 'utf8');

    console.log(`Catalogo generado: data/catalogo.json`);
    console.log(`  productos leidos : ${productos.length}`);
    console.log(`  items comprables : ${unicos.length}`);
    console.log(`  disponibles      : ${unicos.filter(i => i.status === 'disponible').length}`);
    if (conflictos.length) {
        console.log('');
        console.log(`  AVISO: ${conflictos.length} producto(s) duplicado(s) con PRECIOS DISTINTOS.`);
        console.log('  Se usa el primero (igual que el frontend). Corrige el duplicado en Productosdb.jsx:');
        conflictos.forEach(c => {
            console.log(`    - ${c.clave}`);
            console.log(`        se usa: $${c.usado.toLocaleString('es-CO')}   se descarta: $${c.descartado.toLocaleString('es-CO')}`);
        })
    }
}

main().catch(error => {
    console.error('Fallo la sincronizacion:', error.message);
    process.exit(1);
})
