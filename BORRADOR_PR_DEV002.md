# DEV-002: demostrar captura offline recuperable con contrato versionado

**Texto preparado; PR no publicado por falta de canal Git con escritura.**

Refs #1

La captura del cuaderno v1 no garantiza abrir sin red ni guardar evento y cola atómicamente. Este incremento agrega un experimento aislado con IndexedDB/idb, pantalla precargada y contrato JSON Schema v1: después de guardar sin red se puede cerrar Chrome, reabrir y exportar/recuperar el mismo evento pendiente sin duplicarlo. Incluye Node/dependencias fijadas y Biome acotado al código nuevo; conserva DEV-001 como commit previo de código/pruebas.

Validación: instalación limpia desde lockfile y caché, `TAMAGO_BROWSER_CHANNEL=chrome pnpm check`; Biome 15 archivos, 25 Node y 5 recorridos de navegador pasan. Se verifican rollback de evento/cola por fallo de escritura, formulario sin confirmación falsa, mismo ID al reintentar, doble submit, concurrencia, descarga repetida, restauración idempotente, conflicto rechazado, v1 intacto y migración de DB con pendientes. Evidencia en `EVIDENCIA_DEV002_20261022.md` y `evidence/dev002/`.

Solo datos ficticios e identidades declaradas. Android/iPhone/iPad físicos, 24 h reales, cuotas/evicción reales, actualizaciones de shell en hardware y Chromium de Playwright pendientes. No hay servidor, autenticación, aprobación ni sincronización. La issue permanece abierta y el PR debe ser **borrador**; no usar `Closes`.

Publicación: destino main, rama `dev/dev-002-offline`; no hacer merge. Verificados Pages solo main/raíz, sin webhooks/Apps y único workflow de Pages. No se añade CI ni despliegue. Volver a comprobar esos ajustes al recuperar el acceso de escritura. No publicar originales, datos operativos ni otros documentos locales fuera de esta rama revisada.

Recuperación: mantener origen/perfil; exportar y verificar JSON; importar conserva IDs y rechaza conflictos sin reemplazo. La reversión de código debe preservar la DB y sus pendientes, nunca borrar registros. Guion físico, limitaciones y decisión reversible de persistencia en `DEV002.md`.
