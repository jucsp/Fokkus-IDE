# Plan de Implementación — Issue #26: Bandeja Pre-Kanban (Inbox / Triage) Slack + Gmail → Plane | Jira | GitHub Issues

> Plan detallado, decisiones de arquitectura y criterios de aceptación: `.fokkus/briefs/issue-26-plan.md`.
> Brief técnico para la Fase 2 (DeepSeek V4 Pro): `.fokkus/briefs/issue-26-deepseek-prompt.md`.
> El plan anterior (v1.5.0, #6) está en el historial de git.

## Contexto de negocio

Las solicitudes llegan por Gmail corporativo y por el Slack de trabajo, y algunas se pierden. El cliente quiere que
Fokkus revise ambas fuentes **cada 5 minutos** y deje lo detectado en una **Bandeja Pre-Kanban**, clasificado en
5 categorías:

1. Soporte
2. Creación de tickets del equipo
3. Consultas del cliente
4. Consultas desde la empresa
5. Consultas generales de clientes

Nada entra solo a los tableros oficiales: una persona revisa, edita y **aprueba** o **descarta** cada solicitud, para
no ensuciarlos con falsos positivos ni con conversaciones partidas.

El destino es **agnóstico**: al aprobar se elige **Plane**, **Jira** o **GitHub Issues**, y desde ese proveedor se
cargan en vivo el proyecto o repo y los sub-contenedores:

- Plane: módulo, estado y labels.
- Jira: tipo de issue, componentes y sprint.
- GitHub: labels y milestone.

## Estado

| Fase | Pieza | Responsable | Estado |
|---|---|---|---|
| 1 | Contrato RPC congelado `src/common/triage-protocol.ts` | Claude (PM/QA) | ✅ |
| 1 | Frontend completo (bandeja, selector de destino, configuración, notificaciones, binds) | Claude (PM/QA) | ✅ tsc + eslint limpios + E2E 44/44 |
| 2 | Backend completo (`src/node/triage/*`, `plane-server.ts`, `fokkus-orchestrator-backend-module.ts`) | Claude (Backup por DeepSeek HTTP 402) | ✅ Implementado, `tsc -b` y `theia build` (browser + node) con 0 errores |
| 3 | QA y suite unitaria del backend (`triage-server.ts`, `unit-triage.test.js`) | DeepSeek V4 Pro | ✅ `eslint` 0 errores + Unit `PASS 25/25` |

## HU-0 — Bandeja Pre-Kanban en el IDE (Fase 1, hecha)

- 📁 **Repositorio:** `Fokkus-IDE/theia-extensions/fokkus-orchestrator`
- 🎯 **Capa:** Frontend (`src/browser/triage-*.ts(x)`, `style/triage.css`, `fokkus-orchestrator-frontend-module.ts`) +
  Common (`triage-protocol.ts`)
- 📌 **Objetivo técnico:** vista lateral «Bandeja de solicitudes» con:
  - estado del sondeo, con pausar/reanudar y «Revisar ahora»;
  - filtros por estado, origen y categoría, y búsqueda;
  - edición rápida de título, descripción y categoría;
  - selector agnóstico Plane | Jira | GitHub con carga jerárquica dinámica;
  - Aprobar, Descartar y Restaurar;
  - notificación de solicitudes nuevas;
  - configuración de Slack, Gmail y Jira con inputs ofuscados.

## HU-1 — Persistencia, configuración y RPC base

- 📁 **Repositorio:** `Fokkus-IDE/theia-extensions/fokkus-orchestrator`
- 🎯 **Capa:** Backend (`src/node/triage/triage-store.ts`, `triage-config.ts`, `triage-server.ts`, backend module)
- 📌 **Objetivo técnico:**
  - almacenamiento atómico de ítems y cursores;
  - configuración con secretos en el keystore del SO (precedencia env > almacén);
  - operaciones sobre ítems con validación estricta;
  - difusión de eventos a todas las ventanas conectadas.

## HU-2 — Fuente Slack (solo lectura)

- 📁 **Repositorio:** `Fokkus-IDE/theia-extensions/fokkus-orchestrator`
- 🎯 **Capa:** Backend (`src/node/triage/sources/slack-source.ts`)
- 📌 **Objetivo técnico:** lectura incremental por cursor de los canales configurados, un ítem por hilo, filtrado de
  ruido y manejo del rate limit sin perder mensajes.

## HU-3 — Fuente Gmail (solo lectura)

- 📁 **Repositorio:** `Fokkus-IDE/theia-extensions/fokkus-orchestrator`
- 🎯 **Capa:** Backend (`src/node/triage/sources/gmail-source.ts`)
- 📌 **Objetivo técnico:** OAuth con refresh token (scope `gmail.readonly`), lectura de los hilos de la búsqueda
  configurada, extracción de texto plano, detección de correos automáticos y un ítem por hilo.

## HU-4 — Clasificador de 5 categorías y sondeo de 5 minutos

- 📁 **Repositorio:** `Fokkus-IDE/theia-extensions/fokkus-orchestrator`
- 🎯 **Capa:** Backend (`src/node/triage/triage-classifier.ts`, `triage-poller.ts`)
- 📌 **Objetivo técnico:** clasificador puro y explicable con confianza, más un poller sin solapamiento, con pausa
  persistida y aislamiento de fallos por fuente.

## HU-5 — Adaptadores de destino Plane, Jira y GitHub Issues

- 📁 **Repositorio:** `Fokkus-IDE/theia-extensions/fokkus-orchestrator`
- 🎯 **Capa:** Backend (`src/node/triage/targets/*.ts`, refactor mínimo de `plane-server.ts`)
- 📌 **Objetivo técnico:** una interfaz común de adaptador con listado jerárquico (contenedores → grupos de opciones),
  creación del ticket con endpoints de escritura en lista blanca y aprobación idempotente. `github-server.ts` sigue
  siendo de solo lectura.

## HU-6 — Pruebas de conexión

- 📁 **Repositorio:** `Fokkus-IDE/theia-extensions/fokkus-orchestrator`
- 🎯 **Capa:** Backend (`triage-server.ts`)
- 📌 **Objetivo técnico:** un único GET de verificación por fuente o destino, con resultado legible y sin secretos.

## QA (Claude)

- `tsc -b`, bundle del navegador y eslint.
- Unit tests sin red: clasificador, anti-ruido, cursores, lista blanca HTTP, idempotencia y que no se filtren secretos.
- E2E con Puppeteer: HOME aislado y mocks de Slack, Gmail, Plane, Jira y GitHub, con auditoría de métodos (0
  escrituras hacia las fuentes).
- Regresión de v1.4.x, v1.5.0 y #22.
- **Sin commit ni push** sin autorización.
