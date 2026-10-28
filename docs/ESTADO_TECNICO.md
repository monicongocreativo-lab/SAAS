# Estado verificable ·28/10/2026

## Incluido

Fuentes/contratos/dependencias fijadas y27 migraciones;Auth yámbitos por empresa,sesiones durables,roles,recogidas con captura/cola protegida,custodia yclasificación conectadas,recepción/suministro/conteo de alimento,catálogo/vínculos/empates/correcciones auditadas ylibro inmutable con primera apertura ycompensaciones. Es código experimental local,no servicio contratado/desplegado.

`pnpm demo:start` prepara un recorrido de alimento con Auth/Postgres reales **locales**,dos roles ydatos ficticios. No reutiliza las credenciales de las pruebas físicas ya cerradas. Fuentes,fechas,cantidad yevento original se conservan;una operación de libro es distinta de su captura.

## Evidencia previa del desarrollo

-106 Node,513 comprobaciones SQL en18 archivos y28 recorridos Chrome sobre026→027 probado con datos anteriores.
-Ensayos específicos025→026 y026→027:rollback intencional,datos/payload/autor/hora/IDs ysesión previa conservados. En026→027,28 filas de11 tablas,huellas iguales ysin activación automática. No prueban metadata/runner de despliegue o backup de producción.
-Corrección visual de hora:14:00UTC se presenta09:00 Colombia tanto desde contextoEurope/Lisbon comoAmerica/Bogota;payload original intacto.
-iPhone/Safari físico:usuario reporta yservidor local confirma apertura13/v1,recarga sin duplicación,suministro1,25 aplicado11,75/v2,suministro100 conservado con−88,25 revisable bloqueado. Caso separado13→10 mediante−3,persistencia de asientos;dos pestañas10→9,75/v3,segunda revisión obsoleta rechazada yrecuperación explícita,sin doble descuento. Pruebas cerradas:fixtures retirados,servidores detenidos,CA temporal eliminada por usuario.

Son reportes del usuario contrastados con servidor;no video/capturas del hardware. Modelo/iOS actual no reconfirmados. Paginación ydesconexión de alimento no probadas físicamente;corrección visual solo automatizada sin confirmación física específica. Android actual pendiente. No aprobación del piloto/producción.

## Comandos y entorno

Node24.19.0 fijado,ejecutado24.22.1 (repetición exacta pendiente);pnpm11.25.0,SupabaseCLI2.119.0,Playwright1.62.1/Chrome instalado. Instalación desde lockfile;primera instalación necesita registro npm yprimera base imágenes Docker. Sin dependencias nuevas para publicación.

```sh
pnpm test
pnpm lint
TAMAGO_BROWSER_CHANNEL=chrome pnpm test:browser
```

Sin opt-in de proveedor local,las pruebas de backend se omiten. Para incluirlas durante la demo,usar el archivo privado generado yel contenedor **de ese proyecto**,con `TAMAGO_ALLOW_LOCAL_SUPABASE_TEST=1`,`TAMAGO_CUSTODY_TEST_ENV_FILE=<ruta privada .generated/demo-private/env.json>`,`TAMAGO_FIELD_TEST_CONTAINER=<contenedor de la demo>`. Para el test adicional del bootstrap: `TAMAGO_DEMO_URL=<URL /demo/ impresa>`. No publicar el contenido del entorno.

Los ensayos de upgrade requieren además `TAMAGO_ALLOW_LOCAL_MIGRATION_TEST=1` yuna base desechable con la versión anterior exacta;no ejecutarlos sobre la demo ya migrada. Ver guardas de los tests. SQL usa pgTAP local ytransacciones con rollback;no va al servidor de una empresa.

## Pendientes de producto

Suministro yrecepción de alimento offline,libro de aves/mortalidad yresultados completos por ave-día,integración fiscal,alojamiento remoto,operación/backup,multiinstancia yrevisión independiente. Sustituir una apertura requiere otro flujo auditado. Inventario registrado no certifica existencia física ni llegada de todos los eventos offline. No trasladar estos saldos ficticios a operación.

Resultados frescos de la copia publicable se registran abajo después de ejecutar;los números anteriores corresponden al desarrollo previo.

## Verificación fresca de la copia publicable

Instalación aislada desde lockfile con scripts deshabilitados;la caché offline carecía de un paquete yse completó desde registry.npmjs.org,sin cambiar versiones. Build correcto;106/106 Node,513/513 pgTAP18 archivos y29/29 Chrome en primera pasada,incluido bootstrap/cuentas ficticias/apertura persistente/salida de sesión. Biome174 archivos sin errores. Reinicio normal del bootstrap final también verificado.

En repetición después de reiniciar Docker,cambió el ID de contenedor:28/29 navegadores pasaron yla limpieza de field-layout falló por apuntar al ID anterior. Se identificaron porUUID/código/fecha sus dos empresas ficticias ycuatro identidades@example.invalid,se retiraron solo esos fixtures,se preservó la demo yse repitió field-layout:1/1 pasa con el contenedor correcto. SQL repetido contra el contenedor correcto:513/513;Node106/106 yBiome174 pasan. No se bajaron criterios ni se cambiaron reglas del producto para pasar. Los comandos requieren descubrir el ID actual tras cada arranque,no reutilizar uno anterior.

Normalizaciones de publicación:espacio final de avisos legales,una línea vacía final en migración014 ytestSQL de apertura;sin cambio de tokens SQL o texto de licencias. Se conserva íntegra la migración027. Revisión de archivos staged y búsqueda de firmas de secretos sin hallazgos;esta revisión propia no es una auditoría independiente.

Cierre final del bootstrap comprobado:retirada de sus empresas ficticias verificada por consulta de proveedor antes de detener stack. Servidores cerrados,HTML/entorno de sesión retirados yvolúmenes conservados. Los artefactos de tests se ignoran;solo las imágenes seleccionadas en docs/images forman parte del checkpoint.
