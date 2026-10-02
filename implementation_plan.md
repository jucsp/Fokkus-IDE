# Plan de Implementación — v1.5.0 (Issue #6: integración nativa con Bitbucket)

## Contexto de negocio

El equipo trabaja con repos de GitHub y de Bitbucket (clientes de Garage Labs: miseguridad, miplanta, mimixer,
miflota, micamion, sercom). En v1.3.x–v1.4.0 los PRs de GitHub se ven en Source Control y los agentes los revisan
por la API REST sin pedir credenciales. El cliente quiere lo mismo con Bitbucket, **en modo SOLO LECTURA**: el IDE
y los agentes solo pueden hacer `GET` a la API de Bitbucket. Está prohibido aprobar, mergear, declinar o comentar PRs.

### Hallazgo previo (QA, 2026-09-28)

`~/.bitbucket_credentials.env` **no** contiene `BITBUCKET_APP_PASSWORD`. Contiene `BITBUCKET_USERNAME` y un
*repository access token* (`ATCTT…`, se usa con `Authorization: Bearer`) por repositorio: `BITBUCKET_TOKEN_<CLAVE>`.
Cada token va precedido de un comentario `# Repositorio: <slug> (<workspace>)`. El nombre de la clave no
siempre coincide con el slug (`MIMIXER_WEB` → `melon-web`).
Un GET de prueba devolvió 403 «This workspace and its content have been deactivated due to inactivity» para
`garagelabs`. Por eso la QA usa un mock de `api.bitbucket.org`, y la UI tiene que mostrar los errores por repo en vez
de ocultarlos.

Soporte de credenciales:
1. Tokens por repo (Bearer): el repo sale del comentario `# Repositorio:` o de `BITBUCKET_REPO_<CLAVE>=workspace/slug`.
2. App password (`BITBUCKET_USERNAME` + `BITBUCKET_APP_PASSWORD`, Basic): sirve para los repos sin token y para
   descubrir repos con `GET /2.0/repositories?role=member`.

## HU-1 — Backend Bitbucket de solo lectura

- 📁 **Repositorio:** `Fokkus-IDE/theia-extensions/fokkus-orchestrator`
- 🎯 **Capa:** Common (`bitbucket-protocol.ts`) + Backend (`bitbucket-credentials.ts`, `bitbucket-server.ts`, backend module)
- 📌 **Objetivo técnico:** servicio RPC `BitbucketServer` (config, detectar el repo desde `origin`, listar repos, PRs
  por repo/estado, PRs abiertos de todos los repos con errores por repo, diffstat). Todas las llamadas HTTP pasan por
  un único punto que solo admite `GET`, con caché de 30 s y paginación por `next` restringida a `api.bitbucket.org`.
  Los secretos nunca viajan al frontend.

## HU-2 — Pull Requests de Bitbucket en Source Control

- 📁 **Repositorio:** `Fokkus-IDE/theia-extensions/fokkus-orchestrator`
- 🎯 **Capa:** Frontend (`bitbucket-pull-requests-widget.tsx`, `bitbucket-scm-contribution.ts`, frontend module)
- 📌 **Objetivo técnico:** sección «Bitbucket Pull Requests» en `scm-view-container`, con la misma UX que GitHub:
  filtro por repo persistido por workspace (vacío = vista global de abiertos), Detectar, filtro por estado, búsqueda,
  detalle con diffstat, botones «Pedir revisión a agentes» y «Abrir en Bitbucket». Revelado una sola vez, como en
  v1.3.2. El prompt de revisión obliga a usar curl GET contra la API (diff, diffstat, src). No se permite `git fetch`,
  ningún método que no sea GET, aprobar, mergear ni comentar. La credencial se referencia por nombre de variable.

## HU-3 — Credenciales Bitbucket en el entorno de los agentes

- 📁 **Repositorio:** `Fokkus-IDE/theia-extensions/fokkus-orchestrator`
- 🎯 **Capa:** Backend (`fokkus-orchestrator-server.ts`)
- 📌 **Objetivo técnico:** inyectar en el entorno de los agentes CLI las variables `BITBUCKET_*` del archivo de
  credenciales, sin sobrescribir las que ya vengan del entorno, y reenviarlas por WSLENV. Nunca van al prompt ni al historial.

## QA (Claude)

tsc + bundle del navegador, eslint en los archivos nuevos, tests unitarios del parser, del prompt y de la guardia
read-only, E2E con Puppeteer sobre un mock de `api.bitbucket.org` y un HOME aislado. En la E2E se audita que todas
las peticiones sean GET y se hace un control negativo.
Release: v1.5.0 (lerna + 7 package.json), commit, tag anotado (`--cleanup=verbatim`) y
`releng/release-notes/v1.5.0.md`. **Sin push.**
