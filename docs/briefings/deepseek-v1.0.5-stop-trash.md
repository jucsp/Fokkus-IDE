# Briefing DeepSeek V4 Pro — v1.0.5: Botón Stop (#12) y Papelera de agentes (#11)

## Contexto de Negocio
El usuario quiere control total sobre el ciclo de vida de los agentes del Swarm. Hoy, si un agente CLI entra en bucle o tarda demasiado, no hay forma de frenarlo desde el chat: hay que matar el proceso a mano. Además, en el grafo del Team Builder se pueden crear agentes ("✚ Añadir Agente") pero no borrarlos visualmente, así que la interfaz se llena de nodos basura.

Extensión: `theia-extensions/fokkus-orchestrator` (Theia 1.76, React 19, @xyflow/react 12, TypeScript 5.9). Estilo: 4 espacios, comillas simples, sin `null` (usar `undefined`), sin `any` nuevo, llaves en todos los `if`, sin líneas en blanco dobles ni espacios al final.

## HU-12 — Botón Stop en el chat
- 📁 Repo: /home/juancarlos/Proyectos/Personales/Fokkus-IDE
- 🎯 Capa: Common (protocolo RPC) + Backend Node (`src/node/fokkus-orchestrator-server.ts`) + Frontend (`FokkusChat` en `src/browser/fokkus-orchestrator-widget.tsx`)
- 📌 Objetivo técnico: mientras `dispatching` es true, el botón de enviar se reemplaza por un botón Stop que llama a un nuevo método RPC `cancelDispatch(): Promise<void>`. El backend debe matar el árbol completo de procesos del agente en curso (no solo la shell intermedia creada con `shell: true`; en Windows y en `wsl.exe` también), y el dispatch debe terminar con un resultado de estado nuevo `'cancelled'` que el chat muestra como mensaje informativo (no como error). Solo se cancelan procesos de agentes, no los comandos git (`getWorkspaceDiff`, `approveDiff`, `rejectDiff`). Los archivos temporales de adjuntos se siguen limpiando. Un cancel sin dispatch activo es un no-op.

## HU-11 — Papelera para borrar agentes desde el grafo
- 📁 Repo: mismo
- 🎯 Capa: Frontend (`src/browser/fokkus-swarm-node.tsx`, `src/browser/fokkus-swarm-builder-widget.tsx`, `TeamBuilderPanel` en `src/browser/fokkus-orchestrator-widget.tsx`, CSS en `src/browser/style/fokkus-swarm.css`)
- 📌 Objetivo técnico: cada nodo muestra un botón papelera (junto al engranaje) que, tras confirmación del usuario (`ConfirmDialog` de `@theia/core/lib/browser`), elimina el rol: desaparece del grafo, se borran las aristas que lo tocan (el estado de aristas vive en `SwarmBuilder`), su asignación de proveedor (ya lo hace `handleRolesChange` en cascada) y su posición persistida, y se cierra el modal de reglas si estaba abierto para ese rol. Además, la tecla Supr/Backspace de React Flow no debe borrar nodos sin pasar por esta misma lógica.
