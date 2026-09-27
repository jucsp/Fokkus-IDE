# Briefing DeepSeek V4 Pro — Panel «Backlog»: código real de issue y buscador local (v1.1.2)

## Contexto de Negocio
En el panel «Backlog» cada tarjeta muestra un código y un título. Hoy el código se saca **recortando el título** (p. ej. `[HU-12] Login` → código `HU-12`, título `Login`). Eso es incorrecto: el único código oficial en Plane es `{identifier del proyecto}-{sequence_id}` (p. ej. `MEL-27`, `SER-14`), y el título debe mostrarse tal como está en Plane, sin cortarlo.
Además, con muchos issues cargados el usuario necesita encontrar uno rápido: se pide una barra de búsqueda que filtre las tarjetas **localmente**, sin volver a llamar a la API.

**REGLA ABSOLUTA: SOLO LECTURA.** Ninguna petición POST/PATCH/PUT/DELETE a Plane. Esta tarea no agrega ninguna petición nueva.

## Hechos (no los cambies)
- El backend ya obtiene `identifier` del proyecto (`getProjectIdentifier`) y `sequence_id` de cada issue.
- Si falla la carga de proyectos, `identifier` puede venir vacío.

## HU-1 — Código oficial y título intacto
- 📁 Repo: `/home/juancarlos/Proyectos/Personales/Fokkus-IDE`, extensión `theia-extensions/fokkus-orchestrator`
- 🎯 Capa: common + Backend Node — `src/common/plane-protocol.ts`, `src/node/plane-server.ts`
- 📌 Objetivo técnico: en `listIssues`, `code` debe ser `{identifier}-{sequence_id}` y `title` debe ser `issue.name` completo (solo `trim`). Decidir un comportamiento razonable cuando falte el identifier o el sequence_id (no mostrar códigos rotos como `-27` o `MEL-`). Eliminar `splitIssueName` e `ISSUE_CODE_RE` si quedan sin uso.

## HU-2 — Buscador local
- 📁 Repo: mismo
- 🎯 Capa: Frontend — `src/browser/plane-backlog-widget.tsx` (+ `src/browser/style/plane-backlog.css` solo si hace falta)
- 📌 Objetivo técnico: input de texto encima del listado de issues (dentro de la sección «Issues») que filtre en tiempo real, sin llamar a `planeServer`, por código y título (sin distinguir mayúsculas; idealmente también sin distinguir tildes). El contador debe reflejar el resultado filtrado frente al total, y debe haber un mensaje propio cuando la búsqueda no encuentre nada (distinto de «Sin issues para estos filtros»). Reutilizar las clases CSS existentes (`fokkus-backlog-input`).

## Verificación
- `yarn build` del monorepo sin errores; `npx eslint` sobre los archivos tocados sin errores nuevos.
- `grep -nE "method: '(POST|PATCH|PUT|DELETE)'" src/node/plane-server.ts` debe dar vacío.
