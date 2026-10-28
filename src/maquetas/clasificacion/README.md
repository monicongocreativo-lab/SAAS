# Maqueta · clasificación manual

## Identidad visual en revisión

La comparación de marca y sus muestras en cabecera/contexto están en [`identidad-propuesta.html`](./identidad-propuesta.html). El símbolo `transagro-propuesta.svg` es un recurso provisional para esta maqueta; el archivo oficial `../recogidas/assets/transagro.png` se conserva intacto. La maqueta muestra las tres marcas con símbolos contenidos en placas claras, también en modo oscuro. Los acentos de identidad se limitan a logotipos y elementos de marca; no sustituyen la paleta funcional de estados y acciones.

Propuesta navegable para revisión del flujo de Bodega/clasificación. La demostración de esta carpeta sigue aislada y no se conecta al servidor. Desde DEV-010E el build la copia a `/maquetas/clasificacion/`; la pantalla conectada, independiente de este JavaScript de ejemplo, está en `/experimental/classification/`. Su controlador está en `src/classification/` y reutiliza la hoja de estilos de esta maqueta. Evidencia y límites en `plans/DEV-010E-clasificacion-conectada.md` (raíz del proyecto). Abrir `index.html` con un servidor estático desde `src/maquetas/`, por ejemplo `python3 -m http.server 8766 --bind 127.0.0.1 --directory src/maquetas`, y visitar `/clasificacion/`.

Tamago usa su símbolo original y La Paulina el símbolo vertical de Recogidas. Transagro usa el SVG provisional de sol, hojas y surcos que acompaña esta propuesta; el archivo original de Recogidas no se reemplaza. Las proporciones se limitan en las placas de marca y se conserva un fondo claro para cada símbolo en ambos temas.

## Recorrido y acciones

- **Origen:** elegir fecha de recogida y seleccionar una o varias entradas recibidas del mismo origen empresa/sede/lote/galpón/fecha. Cada tarjeta resume transferencia y cantidades sent/received/available. No se ofrece un selector de empresa o perfil que conceda permisos.
- **Cantidad:** ingresar huevos a procesar por traslado, sin superar su disponibilidad. Se admiten sesiones parciales y se muestra la fecha de clasificación por separado.
- **Resultados:** añadir/quitar líneas manuales; cada línea tiene cantidad entera positiva, tipología, condición y destino del catálogo v1. PIPO fija Descarte. La maqueta no calcula clase por peso ni ajusta cantidades.
- **Balance y revisión:** suma seleccionada, suma distribuida y diferencia visible. La revisión se habilita solo con cantidades enteras válidas, fecha ordenada, total positivo y ambos totales iguales. La confirmación es solamente una demostración efímera, no hace una petición ni crea un acuse.
- **Consulta:** pestaña “Sesión de ejemplo” muestra un registro ficticio de 30 huevos (20 + 10 de dos entradas), revisión pendiente y 58 disponibles después de esa sesión.
- **Escenarios:** selector plegado bajo “Escenarios de revisión de la maqueta”. Cambia entre entrada vacía, disponible con incidencia abierta, desbalance, revisión, disponibilidad cambiada, falta de permiso, desconexión, resultado incierto/reintento exacto y sesión de ejemplo.

## Correspondencia con la API existente

Base de rutas: `/v1/companies/{company_id}`. Permiso y alcance vienen de Auth/servidor; la pantalla final no debe inferirlos del nombre del usuario ni de un selector local.

| Elemento de interfaz | Fuente/campo del contrato | Uso previsto al integrar |
|---|---|---|
| Fecha de recogida | Query `business_date=AAAA-MM-DD` | Fecha de origen consultada en `GET /manual-classification-inputs`; no es la fecha de registro |
| Contexto empresa, sede, lote, galpón | `company_id`, `site_id`, `lot_id`, `house_id`; respuesta de entrada incluye `lot_code`, `house_name` | Mantener un único origen dentro de la sesión |
| Tarjeta y línea de entrada | `transfer_id` (identificador interno, mostrar referencia corta); `quantity_sent`; `received_quantity`; `quantity_classified`; `quantity_available`; `incident_id`; `incident_status` | Mostrar recibidos, ya clasificados y disponibles; incluir entradas recibidas con custodia abierta |
| Cantidad a procesar | `inputs[{transfer_id, quantity_eggs}]` | Una cantidad positiva entera por entrada seleccionada; 1–50 entradas únicas |
| Fecha de clasificación | `classified_at` | Instante UTC canónico con milisegundos, cronológicamente igual o posterior al origen; el control visible usa fecha operativa local y la integración definirá hora exacta |
| Referencia de máquina | `machine_configuration_reference` | Opcional, 1–200 caracteres si se proporciona; declarada y no verificada |
| Observaciones | `notes` | Opcional, máximo 2.000 caracteres |
| Línea de resultado | `lines[{line_id, quantity_eggs, typology, condition, destination}]` | 1–100 líneas únicas; cada huevo una vez; suma igual a entradas |
| Tipología | `PIPO`, `C`, `B`, `A`, `AA`, `AAA`, `YUMBO`, `UNKNOWN` | Etiquetas copiadas del catálogo `manual-classification-catalog.v1.json` |
| Condición | `NORMAL`, `DIRTY`, `BROKEN`, `YOLK` | Una condición por línea; no se multiplica el conteo |
| Destino | `PENDING`, `DISCARD` | Vocabulario cerrado; PIPO obliga a `DISCARD`; no hay destino comercial |
| Identidad de sesión | `session_id`, `schema_version: 1`, `company_id`, `origin_business_date` | Crear una identidad de solicitud estable. Ante incertidumbre, investigar y reintentar el mismo payload/IDs |
| Acuse | `review_status: pending`, `configuration_status: declared_unverified`, `duplicate`, `recorded_at`, `processed_quantity`, `recorded_by` | Mostrar solo tras acuse validado; pendiente no es aprobado, stock, ni cierre |

Rutas de referencia: `GET /manual-classification-catalog`, `GET /manual-classification-inputs?business_date=…&offset=…`, `POST /manual-classifications`, `GET /manual-classifications/{session_id}` y `GET /manual-classifications?business_date=…&offset=…`. Las listas devuelven hasta 25 elementos por página y `next_offset`. Un `authorized: false` o 403 no habilita el registro.

## Estados representados

| Estado | Comportamiento visual de la maqueta |
|---|---|
| Sin entradas | Mensaje vacío; selección y revisión bloqueadas |
| Entradas disponibles | Cantidades y misma ruta de origen visibles |
| Selección parcial | El usuario procesa menos del total recibido disponible |
| Líneas incompletas/desbalance | Diferencia explícita; revisión bloqueada |
| Revisión previa | Origen, fechas, entradas, líneas y total repetidos antes de la acción demo |
| Disponibilidad cambió | Alerta y línea por encima del saldo; revisar bloqueado hasta ajustar y cuadrar |
| Falta de permiso | Alerta explícita; campos/acciones de escritura bloqueados |
| Sin conexión | Aviso “no hay cola offline”; campos/acciones de escritura bloqueados |
| Respuesta incierta | Conserva un payload de demo solo en memoria mientras esta página esté abierta; botón repite la misma referencia demo y no hace una solicitud |
| Sesión de ejemplo | Detalle ficticio rotulado revisión pendiente; nunca se consulta el servidor |

## Lo simulado y pendiente

**Simulado:** entradas, referencias cortas, incidencias, sesión y datos; fecha de ejemplo; totales en memoria; selección y líneas; estados del selector; confirmación/reintento ilustrativos. No se guarda ni se envía nada.

**Pendiente de integración:** obtener sesión/empresa/catálogo y permisos reales; listar entradas paginadas autorizadas según fecha; IDs UUID generados una sola vez por intención; petición POST validada y acuse; detalle/listado de sesiones; recarga ante 409; consulta por `session_id` y reintento exacto ante resultado incierto; zona/instante Colombia para `classified_at`; recuperación durable explícita antes de prometer persistencia. La clasificación aún no tiene cola offline. También quedan fuera rangos de máquina aprobados, stock comercial, ajustes, pérdidas, transformaciones de sucios y cierre de jornada.

## Comprobación visual/accesibilidad

Revisión en Chrome local, viewport de escritorio 1440 px y móvil 390 px: sin desbordamiento horizontal, sin errores JavaScript, etiquetas presentes en todos los campos, IDs únicos; se recorrieron los estados de desbalance, origen vacío, saldo cambiado, permiso, conexión, reintento y sesión de ejemplo. La revisión se bloquea con entradas/líneas desbalanceadas, cantidades decimales, fecha cronológicamente inválida, saldo excedido, falta de permiso o sin conexión. Se verificaron foco visible por teclado, PIPO → Descarte, temas claro/oscuro y carga de los tres recursos de marca sobre placas blancas. No se hizo auditoría WCAG completa ni prueba con lector de pantalla/dispositivo físico.

Capturas verificadas: `../../../evidence/maqueta-clasificacion-escritorio.png`, `../../../evidence/maqueta-clasificacion-movil.png`, `../../../evidence/maqueta-clasificacion-desbalance.png`, `../../../evidence/maqueta-clasificacion-sesion-ejemplo.png` y `../../../evidence/maqueta-clasificacion-oscuro.png`.
