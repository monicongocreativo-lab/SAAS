# Demostración local reproducible

Solo datos ficticios y ejecución en este ordenador. No usar la cuenta, claves o base de una empresa. No subir `.generated`, archivos de entorno, perfiles de navegador o bases SQLite. No abrir HTML con `file://`.

## Preparación

- Node24.19.0 y pnpm11.25.0 fijados; Docker local activo. El checkpoint se verificó con Node24.22.1 y declara la repetición exacta pendiente.
- Instalar desde lockfile: `pnpm install --frozen-lockfile --ignore-scripts`.
- Ejecutar `pnpm demo:start`. El comando construye recursos y prepara un proyecto Supabase **local** exclusivo en `.generated/tamago-dev012l-demo`, stack `demo`; no llama a servicios alojados ni despliega funciones. La primera descarga de dependencias/imágenes necesita conexión.
- Abrir la URL impresa, `http://localhost:<puerto>/demo/`. Puertos dinámicos y cuentas nuevas por sesión; no se reutilizan credenciales fijas publicadas.
- Para otro runtime24 probado, hacer explícita la excepción de instalación: `pnpm --config.engine-strict=false install --frozen-lockfile --ignore-scripts`. No cambia las versiones fijadas ni acredita haberlas probado exactamente.

La página contiene botones para copiar correos/contraseñas **ficticios**, ID de apertura y recepción. No contiene claves de proveedor. Identidades por rol ya confirmadas solo para este fixture, no es el alta de personas reales. Director no adquiere permiso de captura implícito.

## Recorrido preparado

1. **Dirección:** abrir Inventario, iniciar sesión y seleccionar SYN-LOTE. En Libro de inventario consultar ID de apertura de la página de ayuda,fecha27/10/2026,hora12:00 Colombia. Se esperan13 bultos revisables,ninguna apertura activa ni disponibilidad confirmada.
2. Escribir motivo de prueba,revisar acción y confirmar una vez. Se espera13/v1,dos asientos:apertura10 y recepción3. Recargar y repetir consulta:misma versión,ninguna duplicación.
3. **Registro:** cerrar sesión y entrar en Suministro con la otra cuenta. Fecha27/10/2026,09:00 Colombia,productoSYN-Alimento demo,ubicaciónSYN-Bodega demo,cantidad1,25 bultos. Revisar y registrar. Copiar ID del acuse/historial;hecho recibido no implica libro aplicado.
4. **Dirección:** cerrar sesión,volver a Inventario y seleccionar SYN-LOTE. Vincular registro original,tipoSuministro,ID copiado. Elegir producto/ubicación de catálogo ymotivo;revisar/confirmar. Consultar libro:13 anterior,11,75 revisable. Revisar acción yconfirmar:11,75/v2,tres asientos.
5. **Insuficiencia al final:** capture registra100 a10:00 en el mismo caso;Dirección vincula. Consulta:libro11,75/v2,resultado−88,25,insuficiencia ysin botón de aplicación. Conservar hecho,no inventar entrada/ajuste para cuadrar.

Para ensayar los pasos siguientes conviene una **sesión nueva**,terminando conCtrl+C y arrancando otra para recuperar el caso13 sin el bloqueo de100. No borrar bases reales ni reutilizar origen/cuenta en producción.

## Compensación y conflicto (sesión ficticia nueva)

Después de activar13,Dirección crea una ubicación de destino ficticia con motivo;no activa apertura en destino. Consulta la recepción3 usando el ID de la página de ayuda;su vínculo muestra el ID para consultar/corregir. En Correcciones e historial cambia solo ubicación a destino,revisando original/vigente/propuesta,autor y motivo. El libro conserva13 hasta revisar/aplicar su diferencia−3;queda10/v2 yconserva asientos+10,+3,−3. Destino sin apertura no tiene disponibilidad certificada.

Registro captura0,25 posterior al corte en la ubicación original yDirección lo vincula. Abrir dos pestañas A/B,consultar el mismo caso10→9,75/v2 ydejar revisiones preparadas con motivos distintos. B confirma9,75/v3;A,sin recargar,confirma ydebe recibir conflicto. Pulsar Revisar conflicto y versión vigente;carga9,75/v3 sin otro débito. Es concurrencia entre pestañas,no prueba de dos personas distintas.

## Recuperación y cierre

- Respuesta incierta:conservar pestaña/intención yusar consulta/reintento con mismo ID. No crear otro ID para ocultar un conflicto. El acuse es durable en servidor,el borrador de alimento sigue solo en memoria.
- Versión obsoleta:revisar conflicto yestado vigente antes de otra acción. No deducir saldo actual desde un acuse histórico.
- **Ctrl+C** en terminal de arranque cierra sus servidores,retira solo los fixtures generados de sus empresas ydetiene su stack,preservando volúmenes. No se ejecuta reset ni borrado global de Docker.
- Un cierre forzado/crash no garantiza cleanup:pueden quedar fixtures ficticios/archivos privados. Conservar diagnóstico yverificar el proyecto exclusivo antes de reanudar;no usar comandos globales ni borrar datos ajenos. El bootstrap de demo no es un runner de producción,backup ni solución de crash recovery.
- La URL usa loopback,no se comparte con iPhone ni internet yno requiere instalar certificados. Una demostración remota es otro alcance con seguridad/alojamiento propios.

## Límites

No alimento offline,apertura sustitutiva,stock físico certificado,stock comercial de huevo,contabilidad,Siigo/DIAN,producción o alta de usuarios reales. No se calcula ingesta de aves desde suministro. Las pantallas adicionales no quedan preconfiguradas por existir su código.
