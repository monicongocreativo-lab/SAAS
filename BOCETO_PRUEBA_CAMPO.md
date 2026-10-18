# Boceto operativo: lote nuevo

## Decisión de alcance · 18 octubre 2026

La prueba de campo se realiza con un lote nuevo. Los meses actuales sirven para comprobar funcionalidad. Las discrepancias históricas de AH2/junio no bloquean esta etapa ni se corrigen automáticamente. No se han importado archivos históricos al nuevo espacio.

## Entrega implementada

- `dist/index.html`: nuevo cuaderno operativo, adaptable a móvil.
- `dist/vision.html`: visión anterior preservada, no representa funcionalidades conectadas.
- Ejemplo ficticio y prueba nueva separados en almacenamiento local.
- Configuración de lote, fecha inicial del piloto, aves y alimento existentes.
- Tres recogidas, clasificación diaria, sucios, descartes, suministro, mortalidad y llegadas físicas de alimento.
- Indicadores calculados, consulta mensual, correcciones con motivo y cierre validado.
- Exportación JSON como copia local; todavía no existe restauración/importación.

Para abrir desde esta carpeta:

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory dist
```

Visitar http://127.0.0.1:8765 en navegador. Usar siempre el mismo origen/puerto para conservar acceso al guardado. No abrir el HTML con file://, pues usa módulos JavaScript.

## Guion UX para Heydi y Elkin

1. Explorar el ejemplo ficticio y elegir una fecha informada.
2. Completar una recogida y comprobar actualización inmediata del balance.
3. Corregir un registro con motivo; comprobar que se conserva el original en Registros.
4. Intentar cerrar con diferencia: debe bloquearse sin inventar cifras.
5. Cambiar a Mi prueba nueva: debe estar vacía y solicitar configuración.
6. Configurar exclusivamente un lote destinado a esta prueba. No hay reemplazo/borrado de lote desde la interfaz.
7. Registrar un día completo, incluyendo ceros explícitos de suministro/mortalidad si corresponden.
8. Recargar: comprobar persistencia. Exportar respaldo antes de limpiar datos del navegador.

Observar: tiempo por tarea, errores, términos que requieren explicación, campos difíciles de obtener, interrupciones y diferencias al cierre. Estos son criterios de investigación, no resultados ya medidos.

## Reglas del primer corte

- Bultos de 40 kg; suministro no equivale a ingesta biológica.
- Balance diario: recogidos − (tipologías + sucios pendientes + descartes).
- Tratamiento de sucios: corrección del mismo informe, sin duplicar producción. Se requiere modelar un evento específico en siguiente versión.
- Tipologías mutuamente excluyentes para este formulario. La separación peso/condición requiere un diseño más completo.
- Yemas y clasificación de recogidas de otras fechas no soportadas todavía.
- Existencias son acumulados de producción SIN descontar despachos: no disponibilidad comercial.
- Postura usa aves calculadas al cierre, no ave-día promedio. Lectura parcial si faltan recogidas.
- Cierre requiere tres recogidas, clasificación conciliada, suministro y mortalidad explícitos. No hay reapertura todavía.

## Límites antes de una prueba multiusuario real

No hay servidor, autenticación, permisos, firma, sincronización, base de datos compartida ni respaldo remoto. El nombre del revisor es declarado. localStorage no es un registro contable seguro. No cargar datos sensibles ni usar como única fuente empresarial.

Próxima etapa técnica: API, identidades y roles por empresa/sede/lote, almacenamiento transaccional, idempotencia, conflictos offline, bitácora protegida, copias y recuperación. Validar captura con trabajadores antes de conectar facturación y costos.

Después: despachos por lote y pedido, facturas multidespacho/multilote, transferencias y préstamos, FIFO real, contabilidad por empresa y eliminaciones de operaciones internas en vista de grupo. Comparación económica de alimentos requiere costos y precios verificables; causalidad requiere controlar edad, clima y otras variables.

## Verificación realizada

12 pruebas automáticas del motor pasan. Revisión visual de escritorio y prueba de captura ficticia con actualización y persistencia tras recarga realizadas en navegador. El ejemplo de ese navegador conserva una tercera recogida ficticia de 500 huevos añadida durante QA. No representa datos de Tamago. Prueba móvil y con trabajadores pendiente.

```sh
node --test tests/pilot-model.test.mjs
node --check dist/pilot-app.mjs
```

No se publicó ni se modificaron archivos operativos originales.
