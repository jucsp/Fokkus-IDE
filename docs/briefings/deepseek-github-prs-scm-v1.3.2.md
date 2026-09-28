# Contexto de Negocio
El usuario sigue sin ver la sección "Pull Requests" en la vista nativa de Source Control de Fokkus IDE (fork de Theia 1.76) en v1.3.1. Además precisó lo que espera: "Una subsección Pull Request que tenga filtro para buscar PRs por repositorio y que me permita solicitar a mis agentes del IDE que revisen el PR (sin aprobarlo, solo revisar y dar feedback). Si no hay filtros aplicados se deben mostrar todos los PRs abiertos pendientes de todos los repos."

## Diagnóstico del QA (Claude) — causa raíz ya verificada en node_modules
1. `src/browser/github-scm-contribution.ts` (v1.3.1, commit 6e78ac4) llama `widgetManager.getWidget('scm-view-container')` en `onStart`. En `FrontendApplication.start()` los `onStart` corren ANTES de `initializeLayout()`, así que el contenedor aún no existe → `getWidget` devuelve `undefined` y la sección nunca se agrega (fallo silencioso).
2. Aunque se agregara tarde, `ViewContainer.doRestoreState()` (node_modules/@theia/core/lib/browser/view-container.js ~l.444) OCULTA (`part.hide()`) toda parte con `canHide: true` que no esté en el layout persistido del usuario. Los usuarios que ya tenían layout guardado jamás verían la sección.
3. Patrón oficial de Theia para contribuir vistas a un contenedor ajeno: `node_modules/@theia/plugin-ext/lib/main/browser/view/plugin-view-registry.js` (método `init`, ~l.99): se suscribe a `widgetManager.onWillCreateWidget(({ factoryId, widget, waitUntil }) => ...)` y, si `factoryId === SCM_VIEW_CONTAINER_ID && widget instanceof ViewContainer`, hace `waitUntil(promesa que agrega la parte)`. Así la parte existe ANTES de `restoreState`.

# HU-1 — Registro correcto de la sección PULL REQUESTS en Source Control
- 📁 Repositorio: /home/juancarlos/Proyectos/Personales/Fokkus-IDE/theia-extensions/fokkus-orchestrator
- 🎯 Capa: Frontend (Theia DI / ViewContainer)
- 📌 Objetivo técnico: reescribir `src/browser/github-scm-contribution.ts` usando el patrón oficial `onWillCreateWidget` + `waitUntil` (suscripción en `@postConstruct` o en `initialize()` de FrontendApplicationContribution, que corre antes de `onStart`/layout). Importa `SCM_VIEW_CONTAINER_ID` desde `@theia/scm/lib/browser/scm-contribution` (verifica que `@theia/scm` sea resoluble; si no está en package.json de la extensión, usa la constante literal `'scm-view-container'` con comentario). Mantén `canHide: true`, `order: 3`. Resuelve el punto 2 del diagnóstico: en `onDidInitializeLayout` busca la parte (`container.getPartFor(widget)`), y si está oculta y NO existe la clave localStorage `'fokkus.github.prs.scmRevealed.v1'`, muéstrala (`setHidden(false)`) y guarda la clave — así el usuario ve la sección una vez y después se respeta si decide ocultarla. Revisa `node_modules/@theia/core/lib/browser/view-container.d.ts` para la API exacta de `ViewContainerPart` (setHidden, isHidden, collapsed). Deja también un fallback: si el contenedor ya existía cuando se suscribe (`widgetManager.tryGetWidget`), agrega la parte directamente. Todo con try/catch y `console.error('[fokkus-github] ...')`.

# HU-2 — Filtro por repositorio y vista global de PRs abiertos
- 📁 Repositorio: el mismo
- 🎯 Capa: Backend (src/node/github-server.ts, src/common/github-protocol.ts) + Frontend (src/browser/github-pull-requests-widget.tsx)
- 📌 Objetivo técnico:
  - Protocolo: agrega `repo: string` (owner/name) a `GitHubPullRequest`, y un método nuevo `listOpenPullRequestsAllRepos(): Promise<GitHubPullRequest[]>`.
  - Backend: `listPullRequests` debe rellenar `repo`. `listOpenPullRequestsAllRepos` obtiene los repos con `listRepositories()` (ya existe) y consulta `/repos/{repo}/pulls?state=open&sort=updated&direction=desc` para cada uno, UNA sola página (per_page 100, maxPages 1 vía `fetchAllPages`), con concurrencia limitada (pool de 6 promesas simultáneas, sin dependencias nuevas), tope de 100 repos (constante `ALL_REPOS_MAX`). Un repo que falle (404/403) se ignora y no tumba el resto (Promise.allSettled o try/catch por repo). Resultado combinado ordenado por `updatedAt` desc. Sigue siendo SOLO LECTURA (GET).
  - Frontend: el input de repositorio se convierte en FILTRO: `<select>` con opción vacía "Todos los repositorios" + los repos de `listRepositories()`. Sin filtro (valor vacío, el DEFAULT) → llamar `listOpenPullRequestsAllRepos()` y mostrar todos los PRs abiertos; en ese modo el select de estado se deshabilita/fija en "Abiertos". Con repo elegido → `listPullRequests(repo, stateFilter)` como hoy. Botón "Detectar" conserva su función (selecciona el repo del workspace como filtro). Persistir el filtro en localStorage por workspace (clave actual). Cada tarjeta debe mostrar el repo (`owner/name`) en la línea meta cuando se está en modo global. `listPullRequestFiles` y "Revisar con IA" deben usar `pr.repo`, NO la variable `repo` del filtro (en modo global está vacía). El estado de expansión/archivos debe indexarse por clave `${pr.repo}#${pr.number}` (números se repiten entre repos). La búsqueda local también debe matchear por nombre de repo.

# HU-3 — Revisión por agentes SIN aprobar
- 📁 Repositorio: el mismo
- 🎯 Capa: Frontend (src/browser/github-pull-requests-widget.tsx)
- 📌 Objetivo técnico: `buildPullRequestReviewPrompt` hoy pide un "veredicto final (Aprobar / Solicitar cambios)". El usuario NO quiere que los agentes aprueben: elimina el veredicto de aprobación y deja explícito que es solo revisión y feedback (hallazgos + sugerencias + resumen de riesgos), sin aprobar, sin comentar en GitHub, sin modificar archivos ni hacer commits. Renombra el botón a "Pedir revisión a agentes" (ícono puede seguir igual). Debe seguir siendo agnóstico al proveedor de IA.

## Reglas estrictas
- Lee COMPLETOS antes de editar: github-scm-contribution.ts, github-pull-requests-widget.tsx, github-protocol.ts, github-server.ts, fokkus-orchestrator-frontend-module.ts, y las rutas de node_modules citadas arriba.
- TypeScript estricto, React 19 vía `import * as React from 'react'`, inversify desde '@theia/core/shared/inversify'. Sin `any` implícito, sin variables sin usar.
- Estilo ESLint del repo: comillas SIMPLES, 4 espacios, punto y coma, header de licencia MIT existente, comentarios en español.
- No agregues dependencias npm, no toques package.json, no hagas git commit.
- Errores: mostrar mensaje en el panel, nunca throw no capturado en la UI.
- No tienes bash: Claude (QA) compila y hace lint. Escribe los archivos físicamente en disco con tus herramientas y verifica releyéndolos.
