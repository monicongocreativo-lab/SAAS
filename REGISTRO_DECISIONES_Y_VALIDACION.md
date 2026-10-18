# Registro de decisiones y validación

Este archivo evita que acuerdos importantes queden dispersos en chats. Cada decisión debe tener evidencia, dueño y condición de revisión.

## Decisiones activas

| ID | Fecha | Decisión | Por qué | Evidencia | Dueño | Estado | Revisar cuando |
|---|---|---|---|---|---|---|---|
| DEC-001 | 2026-09-11 | El primer corte será el cierre diario de Tamago | Es frecuente, observable y crea el núcleo de eventos | Hoja actual + flujo operativo | Heydi y Elkin | Propuesta | Terminen entrevistas de etapa 0 |
| DEC-002 | 2026-09-11 | La hoja de Excel es fuente de reglas, no modelo de base de datos | Mezcla captura, cálculo y reporte | Inspección estructural | Heydi y Elkin | Aceptar | Aparezca una regla que solo exista en Excel |
| DEC-003 | 2026-09-11 | No habrá causalidad automática en el primer MVP | No existe aún protocolo experimental suficiente | Hipótesis Solla/Hacienda | Responsable técnico | Propuesta | Se apruebe protocolo y datos mínimos |
| DEC-004 | 2026-09-11 | El MVP no sustituirá el libro contable legal | Las políticas y jurisdicción no están cerradas | Arquitectura financiera | Responsable contable | Propuesta | Se seleccione integración y marco contable |
| DEC-005 | 2026-09-11 | Los umbrales de éxito se fijan después de medir línea base | Un número arbitrario puede premiar una falsa mejora | Plan etapa 0 | Heydi | Aceptar | Existan cinco jornadas medidas |

## Plantilla de decisión

| Campo | Contenido |
|---|---|
| ID | DEC-000 |
| Fecha | AAAA-MM-DD |
| Pregunta | Qué se necesita resolver |
| Decisión | Una frase comprobable |
| Opciones descartadas | Alternativas y razón |
| Evidencia | Observación, documento, cálculo o prueba |
| Supuestos | Lo que aún no se ha comprobado |
| Dueño | Persona que responde por la decisión |
| Consultados | Personas que deben revisar |
| Impacto | UX, datos, API, finanzas, operación o seguridad |
| Estado | Propuesta, aprobada, reemplazada o cancelada |
| Condición de revisión | Hecho que obliga a reabrirla |

## Registro de prueba con usuarios

| Prueba | Rol | Tarea | Fecha | Resultado esperado | Resultado observado | Severidad | Evidencia | Acción |
|---|---|---|---|---|---|---|---|---|
| UT-001 | Operador | Registrar recogida |  | Completa sin ayuda |  |  |  |  |
| UT-002 | Bodega | Clasificar y conciliar |  | Detecta diferencia |  |  |  |  |
| UT-003 | Supervisor | Cerrar jornada |  | Entiende bloqueos |  |  |  |  |

## Preguntas abiertas que bloquean desarrollo

| ID | Pregunta | Decide | Fecha límite | Impacto si falta |
|---|---|---|---|---|
| Q-001 | ¿Qué identifica inequívocamente lote, galpón y turno? | Operación |  | Duplicados y relaciones incorrectas |
| Q-002 | ¿Cuánto puede diferir recogido de clasificado antes de exigir aprobación? | Operación/finanzas |  | No se puede diseñar cierre |
| Q-003 | ¿Cuándo comienza y termina el día operativo? | Operación |  | Periodos inconsistentes |
| Q-004 | ¿Qué roles pueden corregir y reabrir? | Dirección |  | Riesgo de auditoría |
| Q-005 | ¿Qué dispositivo y conectividad usa cada rol? | Operación/Elkin |  | UX y sincronización equivocadas |
| Q-006 | ¿Qué sistema conserva el libro legal? | Contabilidad |  | Integración financiera indefinida |
| Q-007 | ¿Qué variables exige el técnico para comparar alimentos? | Veterinario/zootecnista |  | Inferencia no válida |

## Cierre semanal

Responder cada viernes:

- Qué hipótesis quedó demostrada.
- Qué hipótesis quedó refutada.
- Qué decisión cambió.
- Qué riesgo nuevo apareció.
- Qué evidencia falta.
- Qué se elimina del alcance siguiente.
- Decisión de puerta: avanzar, rediseñar o detener.

