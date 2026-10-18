# Objetivos medibles y preparación para producción

Fecha de evaluación: 18 de octubre de 2026. Responsables propuestos: Heydi (producto, UX/UI y finanzas), Elkin (ingeniería) y supervisor de Tamago (operación). Las asignaciones requieren aceptación de cada persona.

## 1. Decisión y alcance

Podemos comenzar ahora el descubrimiento de campo, la medición y las pruebas técnicas. Para comprometer el primer sprint funcional faltan acuerdos operativos y criterios de aceptación. El uso real del SaaS todavía no está demostrado como viable.

Primera entrega: un lote activo y una ubicación de Tamago, con sus tres recogidas esperadas por día, entrega a bodega, clasificación, conciliación, correcciones y cierre. Confirmar la ubicación y el lote con operación antes del piloto. Un lote histórico cerrado no sirve para validar captura actual.

La identidad y los permisos deben admitir empresas distintas desde el inicio; activar tres operaciones completas no es requisito de la primera entrega. Alimento, ventas, integración contable, Transagro y La Paulina tendrán puertas posteriores. El panorama financiero completo sigue siendo parte de la visión, pero no un resultado atribuible a este primer flujo.

“Comenzar producción” tiene dos decisiones: G0 autoriza construir el MVP; G1 autoriza un piloto con datos reales y respaldo del procedimiento actual; G2 autoriza convertirlo en registro operativo principal del alcance probado. Ninguna queda aprobada por este documento.

## 2. Evidencia actual y brechas

| Evidencia inspeccionada | Qué acredita | Qué falta demostrar |
|---|---|---|
| README y `dist/app.js` | Prototipo navegable con valores de demostración | Persistencia, identidad real, permisos y cálculo desde eventos |
| Acción `saveCapture` en `dist/app.js` | Cierra el diálogo y muestra “guardado” | No hay escritura persistente en ese controlador; el aviso no prueba registro |
| Estrategia de etapas 0 y 1 | Flujo inicial, riesgos y puertas propuestos | Observaciones de campo y aceptación del alcance |
| Registro de decisiones | Preguntas Q-001 a Q-007 y plantillas | Decisiones aprobadas y resultados de pruebas: las filas siguen sin evidencia |
| Documento master de junio | Describe importación, lotes y trabajo previo en Excel | Sus afirmaciones de validación no prueban la preparación del SaaS ni la vigencia de los datos |
| Handoff para Elkin | Roles, eventos y reglas iniciales | Contiene la estrategia insertada en el punto 5 de pantallas; depurar antes de usarlo como especificación |

No se ejecutó una auditoría de los libros ni de infraestructura externa en esta revisión. No se han verificado despliegues, pruebas reales de restauración ni un backend mediante los archivos inspeccionados. Falta de evidencia no equivale a afirmar que nunca se construyeron.

## 3. Objetivos y resultados medibles del primer producto

Todos los valores siguientes son metas propuestas, no resultados observados. Aprobarlos y congelarlos antes del piloto; cualquier cambio posterior conserva versión y motivo. Cinco jornadas de línea base son una medida inicial, no una prueba estadística de mejora.

| Objetivo | Resultado medible y meta propuesta | Medición y ventana | Responsable / evidencia |
|---|---|---|---|
| O1. Capturar con menos esfuerzo | Reducir al menos 30% la mediana del tiempo por recogida frente a la línea base | Tiempo desde inicio de tarea hasta confirmación local duradera; mismas tareas y dispositivos; 5 jornadas base frente a 14 de piloto | Heydi / observaciones cronometradas y eventos de interacción |
| O1. Facilitar aprendizaje | Al menos 90% de intentos de tareas críticas completados sin ayuda y cero errores críticos sin resolver | Recogida, entrega, clasificación, corrección y cierre; al menos un usuario real por rol; publicar número de usuarios e intentos | Heydi / guion, resultados y fallos. Es prueba formativa, no validación poblacional |
| O2. Disponer de jornadas completas | 100% de recogidas esperadas con registro válido o excepción aprobada; cobertura física de registros ≥98% | 14 días operativos consecutivos; denominador definido antes de capturar por lote/día/turno | Supervisor / agenda esperada y registro independiente de excepciones |
| O2. Cerrar con trazabilidad | 100% de días piloto cerrados antes del límite acordado; cero diferencias sin explicar al cierre | Registrar hora límite, evidencia y aprobador; días con excepción no desaparecen del denominador | Supervisor / expediente de cada cierre |
| O3. Conservar hechos íntegros | Cero pérdidas de eventos confirmados duraderamente y cero duplicados efectivos en pruebas definidas y piloto | Comparar IDs locales, confirmaciones del servidor y exportación; reconciliar cada día y al final | Elkin / informe de reconciliación y pruebas de fallo |
| O3. Corregir de forma auditable | 100% de correcciones con original, nuevo evento, motivo, usuario y fecha; cero sobrescrituras silenciosas | Todas las correcciones del piloto y casos de prueba | Elkin y supervisor / historial reconstruible |
| O4. Entregar información oportuna | p95 de visibilidad ≤60 s desde aceptación en servidor; p95 de sincronización ≤5 min tras recuperar conexión estable | Medir ambas latencias por separado; publicar n, periodo y pendientes. Offline conserva estado pendiente | Elkin / marcas de tiempo del servidor y telemetría |
| O4. Permitir comprobar resultados | 100% de totales diarios reconstruibles desde eventos y reglas vigentes, con igualdad exacta para conteos enteros | Todos los días del piloto; revisión por una persona distinta de quien programó | Heydi / cálculo independiente y exportación |
| O5. Operar con recuperación y acceso controlado | Cero accesos indebidos en matriz de pruebas; restauración probada dentro de RTO y RPO aprobados | Antes del piloto y después de cambios materiales en permisos o recuperación | Elkin / pruebas negativas, restauración y acta G1 |

La reducción de pérdidas económicas y la rentabilidad por alimento no se prometen en esta etapa: exigen inventario, consumo, precios y costos que este corte aún no captura.

## 4. Contratos mínimos de medición

La unidad de cantidad es huevo entero; bandejas y cajas se convierten con un factor configurado y versionado. La fecha operativa usa la zona horaria de la ubicación, que debe acordarse; no se hereda de la computadora del diseñador.

```text
reduccion_tiempo_pct = 100 × (mediana_base − mediana_piloto) / mediana_base
cobertura_fisica_pct = 100 × recogidas_validas / recogidas_esperadas
cobertura_resuelta_pct = 100 × (recogidas_validas + excepciones_aprobadas) / recogidas_esperadas
cierre_a_tiempo_pct = 100 × dias_cerrados_antes_del_limite / dias_operativos_esperados
exito_sin_ayuda_pct = 100 × intentos_correctos_sin_ayuda / intentos_evaluables
latencia_visibilidad = visible_at_servidor − accepted_at_servidor
```

Una excepción no cuenta como huevo producido ni como captura válida. Si el denominador es cero o falta, el resultado es “no evaluable”, con explicación; no es cero ni 100%. Reportar también cantidades absolutas. Los duplicados se miden por efecto de negocio, no solo por filas con igual ID.

Conservar por jornada y lote la agenda de recogidas esperadas, incluso si no hubo captura. Una jornada cancelada requiere motivo y autorización previos o trazables; no se excluye retrospectivamente para mejorar el indicador.

Conciliar por etapas para no ocultar pérdidas ni doble contarlas:

```text
pendiente_entrega_final = pendiente_entrega_inicial + recogido
                         − recibido_bodega − bajas_documentadas_en_entrega
pendiente_clasificacion_final = pendiente_clasificacion_inicial + recibido_bodega
                               − clasificado_total − bajas_previas_a_clasificacion
clasificado_total = suma_de_categorias_fisicas_mutuamente_excluyentes
```

“A”, “sucio” y “roto” pueden representar dimensiones distintas. Operación debe decidir si son categorías excluyentes o atributos de calidad; no sumarlos como si siempre fueran excluyentes. Una baja incluida en la clasificación no se vuelve a descontar. La clasificación puede corresponder a varias recogidas y ocurrir al día siguiente: conservar asignación de origen, saldo pendiente y fecha de cada evento. Diferencia no explicada distinta de cero bloquea cierre; un pendiente conocido se traslada con responsable y política aprobada, nunca se convierte en merma automática.

Separar el total producido por fecha de recogida del total procesado por fecha de clasificación. Esta puerta no valida todavía el inventario de huevo vendible, que necesita salidas, devoluciones y existencias valorizadas.

Cada métrica guarda versión, población, periodo, unidad, fuente y estado (preliminar/conciliado/cerrado). Mantener hora del dispositivo, recepción en servidor y desfase detectado; una hora móvil incorrecta no invalida la auditoría del servidor.

## 5. Qué necesita Heydi para entregar a Elkin

| Entregable | Criterio verificable de terminado | Prioridad |
|---|---|---|
| Ficha del piloto | Empresa, ubicación, lote activo, participantes, dispositivo, conectividad, horario, presupuesto y disponibilidad aceptados | Antes de G0 |
| Proceso observado | Cinco jornadas medidas; responsables y traspasos descritos; variantes de clasificación tardía, rotura y saldo pendiente incluidas | Antes de G0 |
| Diccionario del flujo | Cada campo con significado, unidad, origen, obligatoriedad, validación, responsable y ejemplo válido/inválido | Antes de G0 |
| Cinco flujos UX | Recoger, entregar, clasificar, corregir y cerrar; cada uno incluye vacío, error, offline, sincronización y permisos insuficientes | Antes de G0 |
| Backlog del primer corte | Cada historia enlaza flujo, regla, evento y caso de aceptación; prioridad y fuera de alcance explícitos | Antes de G0 |
| Acta de métricas | Línea base, metas, denominadores, exclusiones y fuente aprobados antes de medir el piloto | Antes de G1 |
| Handoff limpio | Eliminar la inserción accidental del documento existente, resolver términos y revisar junto a Elkin | Antes de G0 |
| Guía de operación | Capturas breves, procedimiento ante falta de red, soporte y recuperación manual; probada con los tres roles | Antes de G1 |

Heydi define el significado de la información, los criterios de negocio y la experiencia; Elkin define cómo persistir, sincronizar y controlar acceso. Ambos revisan las reglas que cruzan estas fronteras. No asignar al desarrollador la decisión de qué significa una diferencia productiva.

## 6. Puertas de salida y pendientes actuales

Estado “pendiente” significa que esta revisión no tiene evidencia suficiente para aprobar. Una demostración visual o una declaración en un documento no la sustituye.

| Puerta | Condiciones obligatorias | Evidencia para aprobar | Estado actual |
|---|---|---|---|
| G0: comenzar sprint funcional | Alcance aceptado; piloto identificado; IDs, unidades, día operativo, categorías, pendientes, cierre, corrección y permisos definidos; historias listas; capacidad y presupuesto acordados | Acta Heydi–Elkin–operación, diccionario, backlog y prueba formativa | Pendiente |
| G1: iniciar piloto real acompañado | Flujo persistente extremo a extremo; autenticación y autorización en servidor; aislamiento por empresa; captura local duradera; sincronización; auditoría; exportación; restauración; errores monitorizados; plan de soporte | Pruebas de aceptación en ambiente de ensayo, restauración cronometrada y aprobación del supervisor | Pendiente |
| G2: registro principal del alcance piloto | 14 días operativos consecutivos; metas O1–O5 cumplidas; todos los eventos reconciliados; cero defectos críticos abiertos; usuarios capacitados; recuperación manual ensayada | Informe comparativo, exportaciones, incidencias, aceptación conjunta y fecha de corte | Pendiente |

G0 no impide hacer ahora entrevistas, wireframes, contratos preliminares ni pruebas técnicas aisladas. G2 autoriza solo el lote/ubicación y flujo probados; ampliar al resto requiere validar la nueva carga, usuarios y variantes. Si falla una meta de valor, investigar y repetir la ventana acordada; no mover el umbral al ver los resultados.

Para G1, Elkin debe aportar evidencia de estos escenarios: reenvío del mismo evento; dos dispositivos en el mismo turno; desconexión antes y después de confirmar; reinicio con cola pendiente; error de servidor; clasificación parcial/tardía; corrección antes y después de cerrar; intento de acceso cruzado a otra empresa por API; restauración y reconciliación de exportación. El servidor impone permisos y unicidad aunque se omita la interfaz.

La prueba de aislamiento requiere al menos dos empresas de ensayo y roles con permisos distintos, aunque el piloto operativo sea solo Tamago. No usar el selector visual de empresa como control de seguridad.

Propuesta de recuperación para discutir con operación: RTO ≤4 horas y RPO del servidor ≤1 hora, más cola local durable hasta confirmación del servidor. Estas metas no están aprobadas ni demostradas. Antes del piloto se decide si son aceptables, se configura la copia y se ensaya la recuperación. Eventos confirmados dentro de la ventana RPO necesitan reconciliación y reproducción desde una fuente durable; documentar el riesgo de pérdida si el dispositivo también falla. No prometer pérdida cero ante desastres sin demostrar esa garantía.

Un defecto crítico permite fuga de datos, pierde o duplica cantidades, permite cierre incorrecto, altera historia o impide recuperar la operación. Cualquiera detiene la ampliación y activa el procedimiento de respaldo.

## 7. Secuencia inicial de trabajo

Día 1 significa primera jornada de trabajo acordada, no una fecha de despliegue comprometida. La duración del desarrollo depende de capacidad real de Elkin y de lo aprendido en G0.

| Ventana | Heydi | Elkin | Resultado y decisión |
|---|---|---|---|
| Días 1–2 | Identificar piloto, roles, recorrido actual y preguntas Q-001 a Q-005 | Revisar arquitectura, persistencia local y sincronización; proponer ambientes y costos | Alcance y responsables identificados; incógnitas registradas |
| Días 3–7 | Medir cinco jornadas reales y preparar flujos/diccionario | Ensayar IDs, idempotencia y control de acceso con datos de prueba | Línea base y pruebas técnicas documentadas |
| Días 8–10 | Probar tareas con operador, bodega y supervisor; ajustar backlog y metas | Revisar contratos, esfuerzo, pruebas y recuperación | Evaluar G0: avanzar o resolver pendientes |
| Tras G0 | Acompañar implementación y aceptación por flujo | Construir, instrumentar y verificar el recorrido completo | Evaluar G1 cuando haya evidencia; estimación previa de 3–4 semanas por revalidar |
| Tras G1 | Medir uso y revisar diariamente diferencias | Atender fallos y reconciliar persistencia/sincronización | 14 días operativos de piloto y evaluación G2 |

El piloto conserva un control independiente de contraste. Acordar quién registra ese control y cómo se evita sumar dos veces. Al aprobar G2, fijar fecha de corte, fuente principal y procedimiento de contingencia para evitar un Excel paralelo indefinido.

## 8. Historia e incorporación de las otras empresas

Para arrancar no hace falta migrar toda la historia. Sí hace falta cargar y validar catálogos activos y saldos operativos de apertura: huevo pendiente de entregar y de clasificar por origen, empresa y ubicación. Adjuntar fecha de corte, fuente, responsable y conciliación. Probar importación repetida sin duplicados y exportación de control antes de usarla.

La migración histórica posterior usa lotes de importación, identificador de fuente, validación, rechazos revisables y nivel de confianza. No convertir totales diarios antiguos en tres recogidas inventadas ni asumir que un vacío es cero. Separar hechos históricos de captura actual y registrar fecha efectiva frente a fecha de incorporación.

| Etapa posterior | Resultado medible que habilita expansión | Dependencia |
|---|---|---|
| Alimento Tamago | 100% de consumos del piloto vinculados a batch; stock inicial + entradas − consumo − bajas = stock final dentro de tolerancia aprobada | Pesos, unidades, inventario físico y política de diferencias |
| Economía del alimento | 100% de comparaciones muestran kg consumidos, aves-día, masa/mezcla vendible, precio y costos disponibles; faltantes explícitos | Calidad de datos y protocolo técnico si se pretende causalidad |
| La Paulina | Traslados del piloto con origen/destino, cantidad, valor y recepción conciliados en ambos lados | Identidad de lotes y documentos propios de cada empresa |
| Transagro | Cada viaje piloto con ruta, carga, costos, cliente, factura/cartera y margen reconstruible; sin viajes omitidos en agenda | Captura de viajes y criterio de distribución de costos aprobado |
| Finanzas e interempresa | Diferencias de submayores contra contabilidad explicadas; eliminación grupal no altera libros individuales | Políticas aprobadas, balances iniciales y sistema legal identificado |

No confundir saldo de apertura operativo con balance contable. Activos, pasivos, patrimonio, impuestos y depreciación requieren su propio levantamiento y conciliación antes de mostrar estados financieros completos. El criterio de éxito posterior será una conciliación verificable, no solo más indicadores en pantalla.

## 9. Acta mínima para cada puerta

Conservar: puerta y fecha; versión del alcance; criterio; meta aprobada; resultado observado con numerador/denominador; enlace a evidencia; incidencias y severidad; persona que verificó; decisión (avanzar, corregir o detener); responsables y fecha de siguiente revisión. Mientras no haya medición, usar “sin evidencia”, nunca “cumplido”.

Primera acción: Heydi completa ficha del piloto y cinco jornadas de línea base mientras Elkin prepara las pruebas de persistencia, idempotencia y permisos. La siguiente decisión útil es G0 con esos resultados sobre la mesa.
