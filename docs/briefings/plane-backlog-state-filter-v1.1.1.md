# Briefing DeepSeek V4 Pro — Panel «Backlog»: filtro opcional por Estado (v1.1.1)

## Contexto de Negocio
El panel «Backlog» (v1.1.0) lista los issues de Plane filtrados por usuario, proyecto y módulo. El equipo quiere acotar además por **Estado** (p. ej. «In Progress», «Todo») sin salir del IDE. Los estados son propios de cada proyecto en Plane, por eso el selector solo tiene sentido después de elegir un proyecto.

**REGLA ABSOLUTA: SOLO LECTURA.** Ninguna petición POST/PATCH/PUT/DELETE a Plane. Solo GET, reutilizando `getAllPages`/`getJson` existentes (ya fuerzan `method: 'GET'`).

## Hechos (no los cambies)
- Endpoint de estados: `GET {baseUrl}/api/v1/workspaces/{workspace}/projects/{projectId}/states/`. Puede responder como array plano o paginado `{ results: [...] }`; `getAllPages` ya maneja ambos. Cada estado trae al menos `id` y `name` (Plane además envía `group`, `color`, `sequence`).
- Cada issue trae `state` (UUID del estado).
- **Plane ignora algunos filtros de query** (ya pasó con `?assignees=`: devuelve todos los issues). Por eso el `state` se envía como query param **y además** se filtra localmente en el backend.

## HU-1 — Protocolo común
- 📁 Repo: `/home/juancarlos/Proyectos/Personales/Fokkus-IDE`, extensión `theia-extensions/fokkus-orchestrator`
- 🎯 Capa: common — `src/common/plane-protocol.ts`
- 📌 Objetivo técnico: agregar `PlaneState { id: string; name: string; group?: string; color?: string }`, el campo opcional `stateId?: string` en `PlaneIssueQuery` y el método `listStates(projectId: string): Promise<PlaneState[]>` en `PlaneServer`.

## HU-2 — Proxy backend
- 📁 Repo: mismo
- 🎯 Capa: Backend Node — `src/node/plane-server.ts`
- 📌 Objetivo técnico:
  1. `listStates(projectId)`: validar UUID (`assertUuid`), pedir `projects/{pid}/states/` con `getAllPages` y mapear a `PlaneState` (nombre vacío si falta; `group`/`color` solo si vienen). Ordenar por `sequence` si viene (número), si no conservar el orden.
  2. `listIssues`: si `query.stateId` viene, validar UUID y pedir la ruta de issues (y la de module-issues) con el query param `state=<stateId>`. Agregar `state?: string` a `PlaneApiIssue` y filtrar localmente `issue.state === query.stateId`.
  3. `getAllPages`/`fetchAllPages` deben aceptar un `extraQuery?: Record<string, string>` que se combine con `per_page`/`cursor`. **La clave de `pagesCache` debe incluir ese extraQuery** (si no, con/sin estado devolverían la misma entrada de caché).
  4. No agregar ningún otro método HTTP. Mantener estilo (4 espacios, comillas simples, comentarios breves en español).

## HU-3 — Frontend React
- 📁 Repo: mismo
- 🎯 Capa: Frontend — `src/browser/plane-backlog-widget.tsx`
- 📌 Objetivo técnico:
  1. Nuevo `<select>` «Estado» debajo de «Módulo», con opción `''` = «Todos los estados». Siempre visible; **deshabilitado** mientras no haya proyecto seleccionado o se estén cargando los estados.
  2. Al cambiar el proyecto: resetear el estado seleccionado y pedir `listStates(projectId)` (mismo patrón que el efecto de módulos, con flag `cancelled`). Si falla, lista vacía + `console.error`.
  3. Si tras cargar los estados el `stateId` seleccionado no existe en la lista, volver a `''` (no hacerlo mientras la lista está cargando, para no borrar el estado restaurado desde localStorage).
  4. `applyIssues` recibe el `stateId` y lo pasa como `stateId` (o `undefined` si vacío). `handleApplyFilters` lo guarda en `localStorage` (`FILTERS_STORAGE_KEY`) y la restauración inicial lo lee y aplica.
  5. No tocar otras secciones del panel ni el CSS salvo que sea imprescindible (reutilizar `fokkus-backlog-field` / `fokkus-backlog-input`).

## Verificación
- `yarn build` del monorepo sin errores; `npx eslint` sobre los 3 archivos sin errores nuevos.
- `grep -nE "method: '(POST|PATCH|PUT|DELETE)'" src/node/plane-server.ts` debe dar vacío.
