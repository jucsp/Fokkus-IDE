# Contexto de Negocio
Fokkus IDE (fork de Theia) ya integra Plane: un panel lateral "Backlog" (lista filtrable de issues) + un tablero "Kanban" en el área main con botón Play que envía el issue al chat Fokkus Team. El cliente quiere EXACTAMENTE la misma UX/UI, pero con Issues de GitHub (filtrables por repo y por GitHub Project v2), en modo lista y Kanban. El backend GitHub (src/node/github-server.ts, protocolo src/common/github-protocol.ts, proxy RPC ya bindeado en el frontend module) YA EXISTE y funciona: NO lo modifiques salvo bug evidente.

# Epic #4 — HU: Panel GitHub Issues (lista + Kanban)
- 📁 Repositorio: /home/juancarlos/Proyectos/Personales/Fokkus-IDE/theia-extensions/fokkus-orchestrator
- 🎯 Capa: Frontend (Theia React widgets, inversify DI, CSS)
- 📌 Objetivo técnico: clonar la arquitectura Plane (plane-backlog-widget.tsx, plane-backlog-contribution.ts, plane-kanban-service.ts, plane-kanban-widget.tsx, plane-kanban-contribution.ts, style/plane-backlog.css, style/plane-kanban.css) para GitHub. LEE esos archivos completos primero, y también github-protocol.ts, github-html.tsx, github-pull-requests-widget.tsx (ya existentes, reutiliza sus patrones de config de token, sanitización GitHubHtml/htmlToPlainText y detectRepository), fokkus-chat-dispatch.ts.

## Archivos a CREAR (en src/browser/):
1. github-issues-service.ts — clon de plane-kanban-service.ts: @injectable GitHubIssuesService con Emitter de snapshot { repo?: string; project?: GitHubProject; columns: GitHubColumn[]; issues: GitHubIssue[]; config?: GitHubConfigStatus }. Exporta const GITHUB_KANBAN_OPEN_COMMAND_ID = 'fokkus-github-kanban:open'.
2. github-issues-widget.tsx — clon de plane-backlog-widget.tsx: ReactWidget, ID 'fokkus-github-issues-widget', LABEL 'GitHub Issues', iconClass 'codicon codicon-github'. Funciones: configurar token (si getConfig().hasToken es false, formulario idéntico al de Plane para token → saveConfig), selector de repositorio (listRepositories; preselecciona detectRepository(workspace root) usando WorkspaceService), selector de Project v2 opcional (listProjects), filtros state (open/closed/all), assignee (listAssignees), label (listLabels), milestone (listMilestones), búsqueda local por texto/código (#num), lista de issues con código, título, labels coloreadas, assignees; al clickear un issue muestra detalle (descripción con <GitHubHtml html=... windowService=.../>) y botón para abrir en navegador (WindowService.openNewWindow(url,{external:true})); botón "Kanban" que ejecuta GITHUB_KANBAN_OPEN_COMMAND_ID. Cada vez que cambian issues/columns publica snapshot en GitHubIssuesService. Recordar repo/proyecto/filtros en localStorage con claves 'fokkus.github.*'.
3. github-issues-contribution.ts — clon EXACTO de plane-backlog-contribution.ts (area 'left', rank 310, toggleCommandId 'fokkus-github:toggle' (OBLIGATORIO este id exacto: el widget de Pull Requests lo invoca para abrir la configuración del token; exporta const GITHUB_PANEL_TOGGLE_COMMAND_ID), misma lógica initializeLayout/onDidInitializeLayout con clave 'fokkus.githubIssues.layoutAdded.v1').
4. github-kanban-widget.tsx — clon de plane-kanban-widget.tsx: ID 'fokkus-github-kanban-widget', LABEL 'GitHub Kanban'. Columnas = snapshot.columns, cards agrupadas por issue.columnId. Botón Play por card → FokkusChatDispatcher.send(buildGitHubDevelopPrompt(issue, repo)). buildGitHubDevelopPrompt debe ser agnóstico al proveedor de IA y equivalente al buildDevelopPrompt de Plane (reutiliza su redacción, cambiando la referencia a GitHub y usando htmlToPlainText(issue.bodyHtml)).
5. github-kanban-contribution.ts — clon de plane-kanban-contribution.ts (area 'main', comando GITHUB_KANBAN_OPEN_COMMAND_ID label 'Fokkus: Abrir GitHub Kanban').
6. style/github-issues.css — Reusa las MISMAS clases CSS de Plane (fokkus-backlog-*, fokkus-kanban-*) en el JSX para UX idéntica; este archivo solo para lo específico (ej. chips de labels con color de fondo `#${label.color}`). Importarlo en el frontend module.

## Archivo a MODIFICAR:
- src/browser/fokkus-orchestrator-frontend-module.ts: bind de GitHubIssuesService (singleton), GitHubIssuesWidget + WidgetFactory, bindViewContribution(GitHubIssuesContribution) + FrontendApplicationContribution.toService, GitHubKanbanWidget + WidgetFactory, bindViewContribution(GitHubKanbanContribution). Copia el patrón EXACTO de cómo están bindeados los de Plane en ese mismo archivo.

## Reglas estrictas
- TypeScript estricto, React 19 vía `import * as React from 'react'`, inversify de '@theia/core/shared/inversify'. Archivos con JSX DEBEN tener extensión .tsx.
- Estilo ESLint del repo: comillas SIMPLES, 4 espacios, punto y coma, header de licencia MIT idéntico al de los otros archivos, comentarios en español.
- No agregues dependencias npm. No toques package.json. No hagas git commit.
- Manejo de errores: mostrar mensaje en el panel (como hace Plane), nunca throw no capturado.
- No tienes bash: el QA (tsc/eslint) lo hace Claude. Escribe código que compile a la primera en TypeScript estricto (tipos explícitos, sin any implícito, sin variables sin usar).
- Escribe los archivos físicamente en disco con tus herramientas. No devuelvas solo código en texto.
