# Briefing DeepSeek V4 Pro — Tablero Kanban de Plane + envío a Fokkus Team (v1.2.0)

## Contexto de Negocio
El panel lateral «Backlog» lista los issues de Plane filtrados por usuario/proyecto/módulo/estado. El cliente quiere verlos como **tablero Kanban** en la zona principal del IDE (una columna por estado del proyecto), ver el detalle de un issue en un panel deslizable a la derecha y, con un botón **Play**, mandar el issue directamente al chat «Fokkus Team» para que el Swarm lo desarrolle sin copiar y pegar.

**REGLA ABSOLUTA: SOLO LECTURA hacia Plane.** Ninguna petición POST/PATCH/PUT/DELETE. El Kanban **no** permite arrastrar tarjetas ni cambiar estados. No se agregan métodos nuevos a `PlaneServer` salvo el campo `stateId` en la respuesta existente.

## Arquitectura (decidida por PM/QA — respetarla)
Extensión: `theia-extensions/fokkus-orchestrator` (Theia 1.76, React 19, inversify, TS ~5.9, 4 espacios, comillas simples).

```
PlaneBacklogWidget (left)  ──publish(snapshot)──►  PlaneKanbanService (singleton, Emitter)
      │ botón «Abrir Kanban» → comando fokkus-kanban:open            │ onDidChange
      ▼                                                              ▼
PlaneKanbanContribution (AbstractViewContribution, area 'main') ► PlaneKanbanWidget (main)
                                                                     │ Play
                                                                     ▼
          FokkusOrchestratorContribution.openView({activate, reveal}) + FokkusChatWidget.sendPrompt(text)
                                                                     │ Emitter + cola pendiente
                                                                     ▼
                                                    FokkusChatApp.dispatchPrompt(text) (envío real)
```

- **Snapshot compartido** (`PlaneKanbanSnapshot`): `{ project?: PlaneProject; states: PlaneState[]; issues: PlaneIssue[]; config?: PlaneConfigStatus }`. `issues` = lista **ya filtrada** del Backlog (incluye el buscador local).
- **Main widget**: registrado con `WidgetFactory` + `AbstractViewContribution` con `defaultWidgetOptions: { area: 'main' }`, singleton, `closable`.
- **Drawer derecho**: dentro del propio widget Kanban (overlay absoluto a la derecha), no un widget de Theia. Se cierra al hacer clic/mousedown fuera y con Escape.
- **Dispatch al chat**: API pública en `FokkusChatWidget` que no depende de que React ya esté montado (cola pendiente consumida al montar).

## HU-1 — Estado del issue en el protocolo (common + Backend)
- 📁 Repo: `/home/juancarlos/Proyectos/Personales/Fokkus-IDE`
- 🎯 Capa: `src/common/plane-protocol.ts`, `src/node/plane-server.ts`
- 📌 Objetivo técnico: `PlaneIssue` debe exponer `stateId?: string` (tomado de `issue.state`, que ya se lee en `listIssues`) para poder agrupar por columna. Sin nuevas peticiones HTTP.

## HU-2 — Servicio compartido y detalle reutilizable (Frontend)
- 🎯 Capa: nuevo `src/browser/plane-kanban-service.ts`, nuevo `src/browser/plane-issue-detail.tsx`, `src/browser/plane-backlog-widget.tsx`
- 📌 Objetivo técnico:
  - `PlaneKanbanService` (`@injectable`, singleton): guarda el último snapshot, `onDidChange` (Emitter de `@theia/core`), `publish(snapshot)`.
  - Extraer de `plane-backlog-widget.tsx` a `plane-issue-detail.tsx` la lógica del detalle (sanitizado DOMPurify, `image-component` → `img`, carga de imágenes por `planeServer.fetchImage`, placeholder «Abrir imagen en Plane», links externos por `WindowService`) como componente `PlaneIssueDetail` reutilizable por Backlog y Kanban. El Backlog debe verse y comportarse igual que hoy.
  - Exportar también `issueDescriptionToText(html)` (texto plano legible del HTML, conservando saltos de párrafo/lista) para el prompt.
  - El Backlog publica el snapshot cada vez que cambian proyecto/estados/issues filtrados/config.
  - En el header de la sección «Issues» del Backlog, botón con icono (`fa fa-columns`, title «Abrir Kanban») que ejecuta `fokkus-kanban:open`. Deshabilitado si no hay proyecto seleccionado.

## HU-3 — Tablero Kanban en la zona principal (Frontend)
- 🎯 Capa: nuevos `src/browser/plane-kanban-widget.tsx`, `src/browser/plane-kanban-contribution.ts`, `src/browser/style/plane-kanban.css`; `src/browser/fokkus-orchestrator-frontend-module.ts`
- 📌 Objetivo técnico:
  - Widget `fokkus-kanban-widget`, label «Kanban» (título: «Kanban · {identifier}» si hay proyecto), icono `fa fa-columns`, suscrito a `PlaneKanbanService`.
  - Una columna por estado en el orden recibido (cabecera con punto de color `state.color`, nombre y contador). Issues sin `stateId` o con estado desconocido van a una columna final «Sin estado» (solo si hay alguno). Columnas con scroll vertical propio; tablero con scroll horizontal.
  - Tarjeta: código, título, estimación y botón Play (`fa fa-play`, title «Enviar a Fokkus Team»). Clic en tarjeta abre el drawer; clic en Play **no** abre el drawer (stopPropagation).
  - Drawer derecho: código, título, estado, estimación, botón Play y `PlaneIssueDetail`. Se cierra con clic fuera, con Escape y con botón ×.
  - Estados vacíos: sin proyecto → «Selecciona un proyecto en el panel Backlog y aplica filtros».
  - Comando `fokkus-kanban:open` (label «Fokkus: Abrir Kanban») registrado en la contribution; abre/activa el widget.

## HU-4 — Play: envío automático al chat Fokkus Team
- 🎯 Capa: `src/browser/fokkus-orchestrator-widget.tsx` (FokkusChatWidget + FokkusChatApp), `plane-kanban-widget.tsx`
- 📌 Objetivo técnico:
  - `FokkusChatWidget.sendPrompt(text: string): void` público. Si la app React ya está suscrita, dispara el envío; si no, deja el texto en cola y la app lo consume al montar.
  - `FokkusChatApp.dispatchPrompt` debe aceptar un texto externo (hoy solo lee `promptText`). El envío externo pasa por **el mismo camino** que el botón enviar (mensaje de usuario visible, guardado de historial, `dispatchToSwarm`).
  - Si el chat está ocupado (`dispatching`), no se pierde el prompt: se deja en el textarea y se avisa con `MessageService.warn`.
  - Cuidar la carrera con `loadChatHistory` (si el historial llega después de enviar, no debe borrar el mensaje recién enviado).
  - Play: abre y activa Fokkus Team en el panel izquierdo (reemplaza visualmente a Backlog) y envía:
    `Desarrolla la siguiente Historia de Usuario: {código} - {título}. Descripción: {descripción}. Recuerda utilizar el Swarm y tus agentes designados (Claude/Deepseek) para ejecutar el desarrollo.`
    Descripción = `issueDescriptionToText(descriptionHtml)`; vacía → «Sin descripción». Sin código → omitir «{código} - ».

## Verificación (QA)
- `yarn build` del monorepo sin errores; `npx eslint` sin errores nuevos en archivos tocados.
- `grep -nE "method: '(POST|PATCH|PUT|DELETE)'" src/node/plane-server.ts` vacío.
- En la app: Backlog → Abrir Kanban → columnas por estado → drawer abre/cierra al clic fuera → Play activa Fokkus Team y el mensaje aparece enviado.
