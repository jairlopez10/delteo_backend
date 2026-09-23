// Pruebas del helper de Wompi. Ejecutar con: npm run probar:wompi
// No toca la red ni el Sheet: solo valida firma, verificacion de eventos y utilidades.
import crypto from 'crypto'
process.env.WOMPI_ENV = 'sandbox'
process.env.WOMPI_PUBLIC_KEY = 'pub_test_ejemplo'
process.env.WOMPI_PRIVATE_KEY = 'prv_test_ejemplo'
process.env.WOMPI_INTEGRITY_SECRET = 'prod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6'
process.env.WOMPI_EVENTS_SECRET = 'prod_events_OcHnIzeBl5socpwByQ4hA52Em3USQ93Z'

const m = await import('../helpers/wompi.js')
const sha = t => crypto.createHash('sha256').update(t, 'utf8').digest('hex')

let fallos = 0
const revisar = (nombre, real, esperado) => {
  const ok = real === esperado
  if (!ok) fallos++
  console.log(`  ${ok ? 'OK  ' : 'FALLO'} ${nombre}`)
  if (!ok) { console.log(`        obtenido: ${real}`); console.log(`        esperado: ${esperado}`) }
}

console.log('--- Firma de integridad: vector exacto de la documentacion ---')
revisar('sin expiracion',
  m.firmaintegridad({ referencia: 'sk8-438k4-xmxm392-sn2m', montoencentavos: 2490000, moneda: 'COP' }),
  '37c8407747e595535433ef8f6a811d853cd943046624a0ec04662b17bbf33bf5')
revisar('con expiracion (cadena documentada)',
  m.firmaintegridad({ referencia: 'sk8-438k4-xmxm392-sn2m', montoencentavos: 2490000, moneda: 'COP', expiracion: '2023-06-09T20:28:50.000Z' }),
  sha('sk8-438k4-xmxm392-sn2m2490000COP2023-06-09T20:28:50.000Zprod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6'))

console.log('--- Verificacion de evento ---')
console.log('  (el checksum de ejemplo de la doc esta desactualizado; se valida contra')
console.log('   la CADENA que la doc especifica construir, que es el contrato real)')

const evento = {
  event: 'transaction.updated',
  data: { transaction: { id: '1234-1610641025-49201', status: 'APPROVED', amount_in_cents: 4490000, reference: 'MZQ3X2DE2SMX' } },
  environment: 'prod',
  signature: { properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'], checksum: null },
  timestamp: 1530291411
}
// Cadena escrita a mano siguiendo los pasos 1-3 de la guia oficial
const cadenaDoc = '1234-1610641025-49201' + 'APPROVED' + '4490000' + '1530291411' + 'prod_events_OcHnIzeBl5socpwByQ4hA52Em3USQ93Z'
evento.signature.checksum = sha(cadenaDoc).toUpperCase()

revisar('acepta evento con checksum correcto', m.verificarevento(evento).valido, true)
revisar('acepta checksum en minusculas', m.verificarevento({ ...evento, signature: { ...evento.signature, checksum: sha(cadenaDoc) } }).valido, true)
revisar('acepta checksum desde la cabecera X-Event-Checksum', m.verificarevento({ ...evento, signature: { ...evento.signature, checksum: null } }, sha(cadenaDoc)).valido, true)

const clonar = () => JSON.parse(JSON.stringify(evento))
const alterado = clonar(); alterado.data.transaction.amount_in_cents = 100
revisar('rechaza monto alterado', m.verificarevento(alterado).valido, false)
const estadofalso = clonar(); estadofalso.data.transaction.status = 'APPROVED '
revisar('rechaza status alterado', m.verificarevento(estadofalso).valido, false)
const tsfalso = clonar(); tsfalso.timestamp = 1530291412
revisar('rechaza timestamp alterado', m.verificarevento(tsfalso).valido, false)
const sinprops = clonar(); delete sinprops.signature.properties
revisar('rechaza evento sin properties', m.verificarevento(sinprops).valido, false)
const propsotras = clonar(); propsotras.signature.properties = ['transaction.reference']
revisar('rechaza properties manipuladas', m.verificarevento(propsotras).valido, false)
const propinexistente = clonar(); propinexistente.signature.properties = ['transaction.noexiste']
revisar('rechaza property inexistente', m.verificarevento(propinexistente).valido, false)
revisar('rechaza checksum arbitrario', m.verificarevento(clonar(), 'deadbeef').valido, false)

console.log('--- properties dinamicas (la doc pide no asumirlas fijas) ---')
const otroorden = {
  data: { transaction: { id: 'X-1', status: 'DECLINED', amount_in_cents: 500, reference: 'REF9' } },
  signature: { properties: ['transaction.reference', 'transaction.amount_in_cents', 'transaction.status'] },
  timestamp: 1700000000
}
otroorden.signature.checksum = sha('REF9' + '500' + 'DECLINED' + '1700000000' + 'prod_events_OcHnIzeBl5socpwByQ4hA52Em3USQ93Z')
revisar('respeta el orden y el set de properties del evento', m.verificarevento(otroorden).valido, true)

console.log('--- Utilidades ---')
revisar('pesos a centavos', m.pesosacentavos(165700), 16570000)
revisar('estado final APPROVED', m.esestadofinal('APPROVED'), true)
revisar('PENDING no es final', m.esestadofinal('PENDING'), false)
revisar('referencias no se repiten', m.generarreferencia(12, 1) !== m.generarreferencia(12, 1), true)

console.log('--- Coherencia ambiente/llaves ---')
console.log(`  INFO ambiente detectado: ${m.configpublica().ambiente}, llave publica expuesta: ${m.configpublica().llavepublica.slice(0,9)}...`)
revisar('configpublica NO expone secretos', Object.keys(m.configpublica()).sort().join(','), 'ambiente,llavepublica,urlcheckout')

console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} FALLO(S)`)
process.exit(fallos === 0 ? 0 : 1)
