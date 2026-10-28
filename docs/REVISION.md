# Revisar el checkpoint

Refs #3. Base:PR#2 DEV-002,abierto. Rama destino del borrador:dev/dev-002-offline. No modificar main ni su publicación Pages. Snapshot acumulado amplio para referencia técnica,requiere revisión por módulos antes de una integración;no es un PR pequeño de una sola función ni se atribuye aprobación independiente.

Orden sugerido:
1. `contracts/` y `src/shared/`: cantidades exactas,identidad,estados,fechas y validadores.
2. `supabase/migrations/`001–027 y `supabase/tests/database/`: Auth/RLS/roles,factos ylibro,compatibilidad/concurrencia/idempotencia.
3. `src/auth-prototype/`: gateway/sesiones/autorización/API;sin claves alojadas.
4. `src/feed-supply/`,`src/feed-intake/`,`src/feed-inventory/`: captura,vínculo,revisión,acuse,conflicto ycompensación.
5. `src/offline/`: recogidas,cifrado/prueba de identidad/cola;no inferir soporte offline de alimento.
6. `src/custody/`,`src/classification/`: procesos conectados ysus límites.
7. Pruebas Node,navegador,HTTP/SQL y `scripts/demo-local.mjs`:bootstrap local de fixtures.

`checkpoint-source-files.json` registra huellas de archivos técnicos copiados del checkout de desarrollo antes de preparar esta entrega. No es hash de los datos de usuario ni una firma del snapshot completo. Cambios específicos de publicación:README,guías públicas,AGENTS/CONTRIBUTING,gitignore,arranque/prueba de demo yscripts de package/lint. Las fuentes operativas y migraciones se copian sin alterar reglas. La construcción genera recursos;los nuevos directorios dist se ignoran salvo los archivos heredados ya rastreados.

Excluidos:documentos de operación locales,Excel/PDF/fotos originales,certificados/claves,entornos,DB,perfiles de navegador ylogs de arranque. Imágenes de docs muestran solo fixtures;no son capturas físicas del iPhone. Documentación histórica ya presente en la base conserva su fecha;estado actual enESTADO_TECNICO.md.

Reversión:eliminar una rama de demostración no revierte datos. Para datos persistentes,conservar fuentes ylibro ypreparar migraciones/correcciones hacia adelante. El rollback transaccional de un ensayo antes de confirmar no autoriza borrar un libro ya usado. Sin merge,tag de release,deployment o CI nuevo en esta entrega.

Normalización exclusiva de publicación:se quita una línea vacía al final de migración014 ytestSQL de apertura(sin cambiar tokens SQL);el generador de avisos legales recorta solo espacio final de licencia jose yconserva su texto completo. Estas normalizaciones también difieren de las huellas de copia inicial del manifiesto.
