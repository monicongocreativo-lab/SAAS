# Centro de Control Empresarial — prototipo UX

Prototipo local para alinear diseño, finanzas e ingeniería antes de construir el MVP operativo.

## Empezar: prueba con un lote nuevo

La entrada principal es el cuaderno operativo del lote nuevo. El ejemplo ficticio está separado de la prueba local. Incluye registros diarios, balances, correcciones y cierre validado. No hay servidor, autenticación ni sincronización entre trabajadores.

```sh
python3 -m http.server 8765 --bind 127.0.0.1 --directory dist
```

Abrir http://127.0.0.1:8765. No abrir directamente con `file://`.

Guía y límites: [BOCETO_PRUEBA_CAMPO.md](BOCETO_PRUEBA_CAMPO.md). La visión multiempresa anterior se conserva en `dist/vision.html`; sus cifras son demostrativas y no funcionalidades conectadas.

Pruebas del motor (Node.js):

```sh
node --test tests/pilot-model.test.mjs
```

## Visión de producto representada (no toda implementada)

- Panorama individual y consolidado de La Paulina, Tamago y Transagro.
- Flujo diario de recogida, clasificación, conciliación y cierre.
- Comparador experimental de alimento con entradas editables.
- Matching y eliminación de operaciones interempresa.
- Lanzador de registros operativos por empresa.
- Handoff UX–desarrollo con eventos, estados y definición de terminado.
- Matriz DOFA, crítica del alcance y plan de validación por etapas.
- Biblioteca de prompts para observación, historias, eventos, ecuaciones, experimentos y puertas.

Los valores son datos de demostración. No sustituyen registros contables, productivos ni evidencia experimental.

## Documentos de trabajo

- `OBJETIVOS_Y_PREPARACION_PRODUCCION.md`: objetivos medibles, evidencia actual, responsabilidades y puertas para desarrollo, piloto y uso operativo (revisión 2026-10-18).
- `ESTRATEGIA_PRODUCTO_ETAPAS_0_1.md`: diagnóstico, DOFA, hoja de ruta, trabajo de UX, backlog y prompts.
- `REGISTRO_DECISIONES_Y_VALIDACION.md`: acuerdos, preguntas bloqueantes y resultados de pruebas.
- `HANDOFF_UX_UI_ELKIN.md`: corte vertical y contrato mínimo para ingeniería.

La versión actual es local. Publicar o desplegar requiere una instrucción explícita del propietario.
