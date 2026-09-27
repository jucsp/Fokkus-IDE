# Briefing DeepSeek V4 Pro — Integración de Plane: panel «Backlog» (Issue #1, v1.1.0)

## Contexto de Negocio
El equipo gestiona sus historias de usuario en Plane (`https://plane.garagelabs.cl`, workspace `garage-labs`). Hoy el dev tiene que salir del IDE para ver qué tiene asignado. Se pide un panel «Backlog» en la barra lateral izquierda de Fokkus IDE que liste los issues de Plane filtrados por usuario, proyecto y (opcional) módulo, y que muestre el detalle al hacer clic.

**REGLA ABSOLUTA: SOLO LECTURA.** El código no puede contener ninguna petición POST/PATCH/PUT/DELETE a Plane. Solo GET.

**Seguridad:** la API Key NUNCA viaja al frontend ni se escribe en el repo. Vive solo en el backend (Node), en `~/.fokkus/plane.json` (permisos 0600). El frontend solo sabe si hay key (`hasApiKey: boolean`).

## Hechos verificados contra la API real (no los cambies)
- Auth: header `X-Api-Key: <key>`. Raíz: `{baseUrl}/api/v1/workspaces/{workspace}/`.
- `GET members/` → **array plano** `[{ id, first_name, last_name, email, display_name, avatar_url }]`.
- `GET projects/`, `GET projects/{pid}/modules/`, `GET projects/{pid}/issues/`, `GET projects/{pid}/modules/{mid}/module-issues/` → **paginados**: `{ results: [...], next_cursor: "100:1:0", next_page_results: boolean, total_count }`. Paginar con `?per_page=100&cursor=<next_cursor>` mientras `next_page_results === true` (tope de seguridad: 50 páginas).
- Proyecto: `{ id, name, identifier }`. Módulo: `{ id, name, status }`.
- Issue: `{ id, name, description_html, estimate_point (string, p.ej. "4", o null), point (number|null), assignees: string[] (UUIDs), sequence_id: number, priority, state, project }`.
- **El filtro `?assignees=` NO es aplicado por el servidor** (devuelve los 377 issues igual). El filtrado por usuario se hace en el backend de Fokkus: `issue.assignees.includes(memberId)`.
- `name` a veces trae prefijo de código: `"HU-09: Historial..."` o `"[HU-N11] Botón..."`; otras veces no trae código.
- Imágenes en `description_html` llegan de dos formas:
  - `<img src="https://plane.garagelabs.cl/api/assets/v2/workspaces/garage-labs/projects/{pid}/{assetId}/" ...>`
  - `<image-component src="{assetId}" width="510px" ...>` (solo el UUID del asset).
  La URL de asset es `{baseUrl}/api/assets/v2/workspaces/{workspace}/projects/{projectId}/{assetId}/`.
  **Verificado:** esa URL responde 401 con `X-Api-Key` (Plane exige sesión de navegador). El proxy igual debe intentarlo (otras instancias/versiones podrían aceptarlo) y, si falla, el frontend muestra un placeholder con enlace «Abrir imagen en Plane» que abre la URL en el navegador del sistema.

## HU-1 — Protocolo común
- 📁 Repo: `/home/juancarlos/Proyectos/Personales/Fokkus-IDE`, extensión `theia-extensions/fokkus-orchestrator`
- 🎯 Capa: common — crear `src/common/plane-protocol.ts`
- 📌 Objetivo técnico: definir `PlaneServerPath = '/services/fokkus-plane'`, símbolo `PlaneServer` y la interfaz RPC:
  ```ts
  interface PlaneConfigStatus { baseUrl: string; workspace: string; hasApiKey: boolean; }
  interface PlaneConfigInput { baseUrl: string; workspace: string; apiKey?: string; } // apiKey vacío/undefined = conservar la actual
  interface PlaneMember { id: string; displayName: string; fullName: string; email: string; }
  interface PlaneProject { id: string; name: string; identifier: string; }
  interface PlaneModule { id: string; name: string; status?: string; }
  interface PlaneIssue { id: string; projectId: string; code: string; title: string; estimate?: string; descriptionHtml: string; sequenceId?: number; }
  interface PlaneIssueQuery { projectId: string; assigneeId: string; moduleId?: string; }
  interface PlaneServer {
      getConfig(): Promise<PlaneConfigStatus>;
      saveConfig(input: PlaneConfigInput): Promise<PlaneConfigStatus>;
      listMembers(): Promise<PlaneMember[]>;
      listProjects(): Promise<PlaneProject[]>;
      listModules(projectId: string): Promise<PlaneModule[]>;
      listIssues(query: PlaneIssueQuery): Promise<PlaneIssue[]>;
      /** Devuelve data URI (`data:<mime>;base64,...`) o undefined si no se pudo. Nunca escribe a disco. */
      fetchImage(url: string): Promise<string | undefined>;
  }
  ```
  Exportar también una función pura `splitIssueName(name: string, fallbackCode: string): { code: string; title: string }` que reconozca `"[CODE] resto"` y `"CODE: resto"` / `"CODE - resto"` donde CODE es `[A-Za-z]+-[A-Za-z0-9]+` (p.ej. `HU-09`, `HU-N11`); si no hay prefijo, `code = fallbackCode` y `title = name`. Debe ir en common (sin imports de node ni browser) porque se prueba de forma aislada.

## HU-2 — Proxy backend de solo lectura
- 📁 Repo: mismo
- 🎯 Capa: Backend Node — crear `src/node/plane-server.ts` (`PlaneServerImpl`, `@injectable()`) y registrarlo en `src/node/fokkus-orchestrator-backend-module.ts` con su propio `RpcConnectionHandler(PlaneServerPath, ...)`, igual que el orquestador.
- 📌 Objetivo técnico:
  1. Config en `~/.fokkus/plane.json` (`{ baseUrl, workspace, apiKey }`), escrita con `fs.writeFile(..., { mode: 0o600 })` y `mkdir recursive`. Defaults: `baseUrl = 'https://plane.garagelabs.cl'`, `workspace = 'garage-labs'`, sin key. Las variables de entorno `PLANE_API_KEY`, `PLANE_BASE_URL`, `PLANE_WORKSPACE` tienen prioridad si existen. `getConfig()` NUNCA devuelve la key.
  2. Validar en `saveConfig`: `baseUrl` debe ser `https:` (o `http:` solo para `localhost`/`127.0.0.1`), sin barra final; `workspace` con `/^[a-z0-9_-]+$/i`.
  3. Un ÚNICO método privado `getJson(path, query?)` que hace `fetch(url, { method: 'GET', headers: { 'X-Api-Key', Accept: 'application/json' }, signal: AbortSignal.timeout(20000) })`. Prohibido cualquier otro método HTTP en el archivo. Errores: 401/403 → `Error('Plane rechazó la API Key (HTTP 401)')`; otros → `Error('Plane respondió HTTP <code> en <path>')`; sin key → `Error('Falta configurar la API Key de Plane')`. Nunca incluir la key en mensajes ni logs.
  4. Todo ID (`projectId`, `moduleId`, `assigneeId`) debe validarse como UUID (`/^[0-9a-f-]{36}$/i`) antes de construir la URL (evita path traversal hacia otros endpoints). `encodeURIComponent` en el workspace.
  5. Paginación genérica `getAllPages<T>(path)` según los hechos verificados. `members/` es un array plano (aceptar también objeto con `results` por robustez).
  6. `listIssues`: si viene `moduleId` usa `module-issues/`, si no `issues/`; filtra por assignee; mapea a `PlaneIssue` usando `splitIssueName(name, `${identifier}-${sequence_id}`)` (buscar el `identifier` del proyecto con una llamada a `projects/{pid}/` o cacheando la lista de proyectos); `estimate = estimate_point ?? point` convertido a string, omitido si null/''. Excluir issues con `archived_at` o `deleted_at` no nulos. Ordenar por `sequence_id` descendente.
  7. `fetchImage(url)`: aceptar solo `https:`/`http:`. Si el origen coincide con `baseUrl` → enviar `X-Api-Key`; si es otro origen → **no** enviar la key. `redirect: 'follow'`, timeout 20 s, rechazar si `content-type` no empieza por `image/` o si pesa más de 10 MB. Devolver `data:${mime};base64,...` solo en memoria. Cache en memoria (Map, máx. 50 entradas) por URL. Cualquier fallo → `undefined` (no lanzar).
  8. Estilo del repo: cabecera de licencia MIT igual que los demás archivos, 4 espacios, comillas simples, `fetch` global de Node (ya se usa en `fokkus-orchestrator-server.ts`).

## HU-3 — Widget «Backlog» en la activity bar
- 📁 Repo: mismo
- 🎯 Capa: Frontend Theia/React — crear `src/browser/plane-backlog-widget.tsx`, `src/browser/plane-backlog-contribution.ts`, `src/browser/style/plane-backlog.css`; registrar en `src/browser/fokkus-orchestrator-frontend-module.ts`.
- 📌 Objetivo técnico:
  1. `PlaneBacklogWidget extends ReactWidget`, `ID = 'fokkus-backlog-widget'`, `LABEL = 'Backlog'`, `iconClass = 'fa fa-list-alt'`, `closable = true`. Patrón idéntico a `FokkusChatWidget` (ver `fokkus-orchestrator-widget.tsx` ~línea 1901): el widget solo renderiza un componente funcional `<PlaneBacklogApp planeServer windowService />` con hooks.
  2. `PlaneBacklogContribution extends AbstractViewContribution<PlaneBacklogWidget>` con `area: 'left'`, `rank: 300`, `toggleCommandId: 'fokkus-backlog:toggle'`, `toggleKeybinding` no. Registrar: `bindViewContribution(bind, PlaneBacklogContribution)`, `bind(FrontendApplicationContribution).toService(PlaneBacklogContribution)` (en `initializeLayout` llamar `openView({ activate: false })` para que el icono aparezca en la activity bar sin robar el foco al chat), WidgetFactory singleton y el proxy `PlaneServer` vía `RemoteConnectionProvider` como el orquestador.
  3. Secciones del panel (de arriba abajo), con CSS propio con prefijo `fokkus-backlog-` que reutilice la paleta existente (`var(--fokkus-accent)`, `var(--theia-foreground)`, `var(--theia-input-background)`, etc.) y soporte anchos estrechos (panel ≥ 220px, `min-width: 0`, `overflow-wrap: anywhere`):
     - **Conexión** (plegable; abierta si `!hasApiKey`): inputs Base URL, Workspace, API Key (`type="password"`, placeholder «•••• guardada» si `hasApiKey`) y botón «Guardar». Nunca prellenar la key.
     - **Filtros**: Usuario (obligatorio) = `<input list>` + `<datalist>` o select con búsqueda por nombre/correo sobre `listMembers()`; Proyecto (obligatorio) = select de `listProjects()` mostrando `identifier — name`; Módulo (opcional) = select de `listModules(projectId)` recargado al cambiar proyecto (opción «Todos los módulos»). Botón «Aplicar filtros» deshabilitado si faltan obligatorios. Los filtros se pueden cambiar y re-aplicar cuantas veces se quiera; persistir la última selección en `localStorage` (`fokkus.backlog.filters`).
     - **Lista**: estado de carga, error (mensaje del backend), vacío («Sin issues para estos filtros») y contador. Cada tarjeta muestra el **código** (chip), el **título** y la **estimación** (badge, «—» si no hay). Clic o Enter/Espacio en la tarjeta expande/colapsa el detalle (acordeón, un solo abierto), `aria-expanded`.
     - **Detalle**: renderizar `descriptionHtml` sanitizado con `DOMPurify` (`import DOMPurify from '@theia/core/shared/dompurify'`), permitiendo tags de formato habituales, tablas, listas, `a`, `img`; prohibir `script`, `style`, `iframe`, `form`, `on*`. Antes de sanitizar, transformar cada `<image-component src="{assetId}">` en `<img src="{baseUrl}/api/assets/v2/workspaces/{workspace}/projects/{projectId}/{assetId}/">` (usar `DOMParser`). Luego, por cada `<img>` resolver la imagen llamando `planeServer.fetchImage(src)` y, si devuelve data URI, asignarla; si no, reemplazar por un placeholder `.fokkus-backlog-img-missing` con botón «Abrir imagen en Plane» (`windowService.openNewWindow(src, { external: true })`). Los enlaces `<a>` del detalle deben abrirse con `windowService.openNewWindow(href, { external: true })` interceptando el clic (no navegar dentro del IDE). Descripción vacía → «Sin descripción».
  4. No tocar `fokkus-orchestrator-widget.tsx` ni el CSS del chat. Nada de `any` innecesario. TypeScript strict del repo.

## Criterios de aceptación (QA los verificará)
- `yarn build:extensions` sin errores de TypeScript; `yarn lint` de la extensión sin errores nuevos.
- `grep -nE "method: *'(POST|PUT|PATCH|DELETE)'" src/node/plane-server.ts` → vacío.
- La key no aparece en ningún archivo del repo ni en respuestas RPC.
- El panel Fokkus Team y el Explorer siguen funcionando igual.
