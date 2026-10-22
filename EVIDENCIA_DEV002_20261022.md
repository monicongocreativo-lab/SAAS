# Evidencia DEV-002 · 22/10/2026

Estado: **implementado y probado localmente; validación física pendiente**. Elkin — Desarrollo virtual, revisión propia. No hubo revisor independiente, datos reales, aprobación de piloto, merge ni despliegue.

Issue [#1](https://github.com/monicongocreativo-lab/SAAS/issues/1), abierta. Contrato: `contracts/collection-export.v1.schema.json`. Fuente: `src/offline/`; entorno, decisión de persistencia, recuperación y guion físico en `DEV002.md`. Plan/criterios anteriores a construcción en `plans/DEV-002-offline.md`.

## Entorno y comandos ejecutados

macOS, Node **24.19.0**, pnpm **11.25.0**, Playwright **1.62.1**, Google Chrome **155.0.8059.85**, headless. Servidores solo en 127.0.0.1 y contextos/perfiles temporales. Pantallas 1280×1000 y 390×844; el test de reinicio usa un perfil persistente temporal, cierra el proceso y lo abre offline, sin usar el perfil personal.

En este entorno se añadieron al PATH los ejecutables existentes:

```sh
export PATH="/Users/monicongo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/monicongo/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH"
pnpm install --ignore-scripts
pnpm install --frozen-lockfile --ignore-scripts --offline
TAMAGO_BROWSER_CHANNEL=chrome pnpm check
```

La primera instalación consultó npm; la segunda verificó el lockfile desde caché sin red/scripts. `check` ejecutó build, Biome, 25 pruebas Node y 5 recorridos de navegador: **todos pasan, ninguno omitido**. Biome verificó 15 archivos sin cambios, preset `recommended`; no cubre legado ni bundle generado. No se descargó Chromium de Playwright: su validación sigue pendiente; Chrome instalado sí fue probado.

Build determinista observado en ejecuciones sucesivas: shell **bf236c87f75c998e**, bundle `app.js` **33.654 bytes** sin comprimir. Esa huella de recursos no es firma de autoría ni identificador de despliegue.

## Matriz de resultados reales

| Criterio | Caso / observado | Estado |
|---|---|---|
| Pantalla disponible offline | Worker verifica recursos; recarga y navegación offline, incluyendo nuevo proceso Chrome | Pasa |
| Captura recuperable | 7.200 huevos ficticios del 21/10, ocurrencia 1; mismo evento, cantidad, autor/dispositivo declarados y pendiente después del reinicio | Pasa |
| Atomicidad / error | `QuotaExceededError` inyectado en `outbox.add` después de escribir evento: ambos stores vacíos; formulario conserva 7.200; sin mensaje de éxito | Pasa |
| Reintento con identidad | ID observado del intento fallido coincide exactamente con el del guardado posterior | Pasa |
| Doble pulsación | Dos submits seguidos producen un evento y una entrada de cola | Pasa |
| Concurrencia | Otra pestaña rechazada por ocurrencia; dos escrituras concurrentes con IDs nuevos para ocurrencia 2: una aplicada, otra rechazada | Pasa |
| Idempotencia | Dos escrituras concurrentes del mismo ID/contenido devuelven cero nuevos | Pasa |
| Exportación | Dos descargas JSON iguales al snapshot completo; la cola no cambia | Pasa |
| Recuperación | Importación en contexto vacío conserva paquete exacto; dos importaciones al mismo perfil agregan cero; mismo ID con contenido distinto se rechaza sin reemplazo | Pasa |
| Contrato | Validación al guardar/leer/descargar/recuperar; faltantes, nulos, fracciones, negativos, cantidades inseguras, extras, fechas inválidas, versiones y falsos acuses rechazados | Pasa |
| Separación | Namespace sintético exigido; claves v1 en el mismo perfil permanecen byte a byte | Pasa |
| Actualización DB | DB experimental v1→v2 agrega meta; evento cero y cola previa permanecen idénticos | Pasa |
| Más de 24 h | Pendiente antiguo según reloj inyectado; aviso y nueva captura offline permitida | Pasa en navegador; 24 h físicas no probadas |
| Regresión DEV-001 | 21 casos anteriores dentro de 25 Node; dos recorridos anteriores, incluido v1 cerrado leído sin reescritura | Pasa |
| Interfaz | Revisión visual escritorio, móvil y fallo; etiquetas asociadas y foco nativo; 390 px sin desborde horizontal | Pasa para ese alcance; sin auditoría exhaustiva de accesibilidad |
| Android/iPhone/iPad físicos | Sin dispositivos accesibles para la prueba | Pendiente |
| Servidor / identidad / puente / acuse | No implementados; todo permanece pendiente | No aplica al corte |

El fallo de cuota es una inyección controlada que prueba la ruta y el rollback real de IndexedDB, no una medición de cuota física. No se borraron datos reales ni se utilizaron perfiles personales. La migración probada es de la DB experimental, no del cuaderno localStorage v1.

Evidencia sintética en `evidence/dev002/`: escritorio, móvil después de reiniciar, fallo de almacenamiento, conflicto y exportación validada. Las capturas no acreditan hardware móvil.

## Límites y recuperación

Depende del navegador/origen/perfil. Reinicio normal no equivale a corte eléctrico. Evicción, cuotas reales, suspensión, exportación Archivos de Apple/Android, persistencia concedida/denegada y actualización del shell en hardware necesitan el guion de `DEV002.md`. No se promete recuperación ante borrado/pérdida de equipo ni cobertura global.

No se hizo elección final PWA/nativa. No hay autenticación, autorización, cifrado local, aislamiento efectivo de usuarios, servidor o acuse. Ni selector de empresa ni UUID de instalación acreditan identidad. Todo queda provisional/pendiente. No se contrató observabilidad ni se exportaron payloads a telemetría.

## Publicación controlada

Antes de escribir en GitHub se verificó: issues vacías; Pages desde **main / raíz**; ningún webhook; ninguna GitHub App; Actions solo **pages-build-deployment**, último despliegue del 18/10. Los endpoints de configuración no permitidos por conector se resolvieron con lectura de navegador. El conector dio 403 al crear issue, sin efecto; #1 se creó mediante UI autorizada y se verificó abierta.

La rama se prepara en copia de revisión temporal desde main remoto `316072e6e5abc465bd48bc44128b4ed1f7a68165`, cuya historia era distinta de la local aunque coincidían los archivos de aplicación. No se reseteó ni cambió de rama el checkout del usuario. Primer commit conserva solo código/pruebas DEV-001 necesarios; siguiente incorpora el experimento. No se publican originales de operación, análisis con cifras reales ni los demás cambios locales. No se agrega CI ni se modifica main/Pages.

Issue abierta por validación física. **PR no publicado**: `git push --set-upstream origin dev/dev-002-offline` falló por ausencia de credenciales (`could not read Username`); el conector rechazó crear rama con HTTP 403 `Resource not accessible by integration`. No fue rechazo de revisión automática de aprobación. La autorización del usuario existe; falta un canal Git con escritura, no un nuevo permiso de negocio. No se buscaron ni extrajeron secretos de la sesión del navegador.

Verificación posterior mediante `git ls-remote`: main sigue en `316072e6e5abc465bd48bc44128b4ed1f7a68165`; no existe rama remota `dev/dev-002-offline`. Commits locales de revisión: `c35f7b8` (DEV-001 previo) y `4d804598775cf6b97ae24a15cbb4696f69b8f94f` (código DEV-002). La copia aislada completó instalación limpia y `check` sin diferencias de build.

Se conserva `BORRADOR_PR_DEV002.md` con `Refs #1` y un bundle local de la rama en `artifacts/DEV-002.bundle`; no representan un PR publicado. El bundle se verifica con Git antes de entregar e incluye un commit documental posterior. Reanudar desde él y volver a verificar disparadores remotos antes de publicar. La issue sigue abierta y no hubo merge/despliegue.

### Actualización de publicación · 22/10/2026

La rama [`dev/dev-002-offline`](https://github.com/monicongocreativo-lab/SAAS/tree/dev/dev-002-offline) se publicó y el PR [#2](https://github.com/monicongocreativo-lab/SAAS/pull/2) quedó abierto como borrador, asociado a la issue [#1](https://github.com/monicongocreativo-lab/SAAS/issues/1). El texto anterior describe correctamente el bloqueo observado antes de completar el acceso y se conserva como registro histórico.

Después de publicar: PR `OPEN` y `isDraft=true`; issue `OPEN`; `main` sigue en `316072e6e5abc465bd48bc44128b4ed1f7a68165`; no se creó un nuevo workflow run. El único run visible continúa siendo Pages desde `main` (18/10/2026). No hubo merge ni despliegue. Android/iPhone/iPad físicos y revisión del PR continúan pendientes.
