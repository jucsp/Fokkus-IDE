# Briefing DeepSeek — Issue #18: Product Owner de tipo API

## Contexto de negocio
Hoy el rol **Product Owner** del Swarm solo funciona con un agente CLI local. Si el usuario le asigna un proveedor de tipo API (DeepSeek, OpenAI, Gemini, Anthropic), el backend lo descarta con «el orquestador principal debe ser de tipo CLI», y la ayuda de Providers lo advierte. Queremos quitar esa restricción para que quien no tenga un CLI instalado pueda orquestar con un PO que consuma una API directamente.

## HU-1 — Ejecutar el PO vía API
- 📁 **Repositorio:** Fokkus-IDE — `theia-extensions/fokkus-orchestrator`
- 🎯 **Capa a trabajar:** Backend (Node). Archivo: `src/node/fokkus-orchestrator-server.ts` (`doDispatchToSwarm`, `cancelDispatch`).
- 📌 **Objetivo técnico:** Quitar la validación que rechaza al PO de tipo API y ejecutarlo contra un endpoint compatible con OpenAI Chat Completions, usando `apiEndpoint`, `apiKey` y `model` del proveedor. Hay que manejar configuración incompleta, errores HTTP (sin filtrar la API key) y respuestas vacías, y la cancelación con el botón Stop. El PO CLI no debe cambiar.

## HU-2 — Texto de ayuda en Providers
- 📁 **Repositorio:** Fokkus-IDE — `theia-extensions/fokkus-orchestrator`
- 🎯 **Capa a trabajar:** Frontend (React). Archivo: `src/browser/fokkus-orchestrator-widget.tsx` (`PROVIDER_HELP_GUIDES` y el aviso del panel de ayuda).
- 📌 **Objetivo técnico:** Reemplazar el aviso «el PO debe ser CLI» por uno que diga que el PO puede ser CLI o API, y que explique qué hace de distinto cada uno.
