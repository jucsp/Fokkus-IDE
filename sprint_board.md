# Sprint Board

## 📝 To Do (Pendiente)
- [ ] **[Responsable: Swarm (Claude/DeepSeek)]** Issue #25: Actividades en modo paralelo (Agente Líder no bloqueante).
- [ ] **[Responsable: Swarm (Claude/DeepSeek)]** Issue #24: Spec-Driven Development (SDD) Mode.
- [ ] **[Responsable: Swarm (Claude/DeepSeek)]** Issue #23: Unificar secciones de Pull Requests (GitHub y Bitbucket) en un solo Widget.
- [ ] **[Responsable: Swarm (Claude/DeepSeek)]** Issue #19: Imágenes de Plane en el IDE.

## 🏃 In Progress (En Progreso)
- [ ] Pruebas de usabilidad por usuarios externos (Amigos en Windows).

## ✅ Done (Completado)
- [x] **[Responsable: DeepSeek V4 Pro (Senior Dev)]** #26 (Mejora Deduplicación Remota) — Estampado de `Fokkus-Triage-ID: <item.id>` en la descripción del ticket y verificación previa en **Plane**, **Jira** y **GitHub Issues** filtrando desde `receivedAt` en adelante para vincular sin duplicar (`PASS 26/26`).
- [x] **[Responsable: DeepSeek V4 Pro (Senior Dev + Backup QA)]** #26 (Fase 3) — Fix shadow `status` -> `httpStatus` en `triage-server.ts:270` (`eslint` 0 errores, `tsc -b` 0 errores, `theia build` browser + node 0 errores) y suite unitaria sin red `unit-triage.test.js` (`PASS 25/25`).
- [x] **[Responsable: Claude Code (Backup Senior Dev — DeepSeek HTTP 402)]** #26 (Fase 2) — Motor Backend completo (`src/node/triage/*`, `plane-server.ts`, `fokkus-orchestrator-backend-module.ts`): cliente HTTP con allowlist, config/secretos en keystore del SO, store de ítems/cursores, clasificador de 5 categorías, fuentes Slack/Gmail, adaptadores multi-destino (Plane, Jira, GitHub Issues), poller de 5 min y `TriageServerImpl`. Compila con 0 errores en `tsc -b` y `theia build` (browser + node).
- [x] **[Responsable: Claude Code (PM/QA)]** #26 (Fase 1) — Plan de Implementación (`implementation_plan.md`), Contrato RPC congelado (`triage-protocol.ts`) y Frontend UI de la Bandeja Pre-Kanban con selector agnóstico (Plane, Jira, GitHub Issues) (E2E 44/44 contra mock).
- [x] **[Responsable: Swarm (Claude/DeepSeek)]** #22 UI de Configuración de Credenciales para GitHub y Bitbucket con SecretStorage (v1.6.0).
- [x] **[Responsable: Swarm (Claude/DeepSeek)]** #6 Integración con Bitbucket en Source Control, solo lectura (v1.5.0).
- [x] **[Responsable: Swarm (Claude/DeepSeek)]** #21 Revisión de PRs con token de GitHub, sin prompts de credenciales (v1.4.0).
- [x] **[Responsable: Swarm (Claude/DeepSeek)]** #20 Modos de ejecución reales, sin Workspace Tree y tool de aprobación en el chat (v1.4.0).
- [x] **[Responsable: Swarm]** #4 Implementar integración con Github (Pull Requests en Source Control).
- [x] **[Responsable: Antigravity]** CI/CD Release Automation (Ubuntu/Windows).
- [x] **[Responsable: Antigravity]** Corrección ESM / Decompress para Theia en Node 22.
- [x] **[Responsable: Antigravity]** Renombrado de ejecutables a Fokkus IDE.
- [x] **[Responsable: Antigravity + Claude Code]** #5 Detección de carpeta abierta y contexto jerárquico.
