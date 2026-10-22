# DEV-002 · Base reproducible y captura offline recuperable

22/10/2026 · Elkin — Desarrollo virtual. Estado: implementado/probado localmente; dispositivos físicos pendientes.

## Alcance y criterios definidos antes de construir

Experimento con datos exclusivamente ficticios, separado de DEV-001 y localStorage v1. Contrato canónico JSON Schema, captura individual por origen diario, IndexedDB transaccional, pantalla precargada, exportación/restauración local. Sin servidor, autenticación, sincronización, aprobación, puente ni despliegue.

| Criterio observable | Verificación prevista |
|---|---|
| Pantalla preparada disponible sin red | Service worker con ámbito experimental; navegación offline en contexto temporal |
| Evento y cola juntos o ninguno | Transacción IndexedDB; abortar escritura y comprobar ambos almacenes |
| Confirmar solo persistencia completada | Fallo visible, formulario conservado, sin mensaje de guardado |
| Recuperar identidad, contenido y pendiente | Cerrar navegador y abrir perfil temporal persistente sin red |
| Doble pulsación/reintento no duplica | ID estable por intento; índice único por origen/ocurrencia; prueba concurrente |
| Exportar/restaurar sin pérdida | Validar mismo contrato, dos exportaciones iguales; restauración idempotente y conflicto rechazado |
| Compatibilidad | Guardados v1 byte a byte; migración aditiva DB 1→2 con pendientes |
| Reglas de recogida | Una a tres ocurrencias, cero explícito distinto de ausencia, fecha Colombia, provisional después de 24 h |
| Regresión DEV-001 | Node y los dos recorridos existentes de navegador |
| Interfaz | Revisión escritorio/móvil, teclado, errores y descarga; no acredita hardware |

Dependencias: Node fijado, navegador compatible con IndexedDB/Service Worker en contexto seguro, preparación inicial con red. Android e iPhone/iPad físicos pendientes. Las identidades de este corte son declaradas, no permisos efectivos; solo se admiten IDs sintéticos. Cambios incompatibles del contrato exigen otra versión y lector/migrador explícito sin descartar cola.

Recuperación: conservar el origen/puerto/perfil, reintentar el mismo evento sin editar su contenido, exportar respaldo validado, restaurar en el mismo experimento por ID. No borrar almacenamiento real para probar errores. No vaciar cola al exportar ni inventar acuse.

## Seguimiento remoto

Búsqueda previa vía GitHub API: `issues?state=all&per_page=100` devuelve `[]`. La configuración no accesible por conector se verificó en navegador: Pages solo main/raíz, sin webhooks ni GitHub Apps y único workflow de Pages. Creada y verificada la [issue #1](https://github.com/monicongocreativo-lab/SAAS/issues/1) por UI autorizada tras respuesta 403 del conector, sin duplicación. Debe seguir abierta hasta validación física.

Entrega: `DEV002.md`, `contracts/collection-export.v1.schema.json` y `EVIDENCIA_DEV002_20261022.md`. 25 casos Node y 5 recorridos de navegador pasan; no equivalen a validación en campo. Publicar solo rama de tarea/PR borrador, sin integrar main ni desplegar.

Resultado remoto: issue [#1](https://github.com/monicongocreativo-lab/SAAS/issues/1) abierta; rama [`dev/dev-002-offline`](https://github.com/monicongocreativo-lab/SAAS/tree/dev/dev-002-offline) publicada y PR [#2](https://github.com/monicongocreativo-lab/SAAS/pull/2) abierto como borrador. Verificados Pages solo main/raíz, ningún webhook ni GitHub App instalada y solo workflow de Pages; publicación de rama no inició Actions y `main` sigue intacta en `316072e`. Sin merge/despliegue. Pruebas físicas y revisión pendientes.
