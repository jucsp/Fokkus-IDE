# Plan de Implementación — Issue #27: Asistente de Voz en Vivo estilo Jarvis (Desktop Bubble Overlay) conectado al Agente Líder

## Contexto de Negocio
Se requiere dotar a Fokkus IDE de una interfaz de voz estilo **Jarvis**, que actúe como la «boca y oídos» del Agente Líder actual de Fokkus Team. Permite interactuar mediante habla natural con el entorno de desarrollo mientras se programa o incluso con el IDE en segundo plano, a través de una burbuja de escritorio flotante permanente (Overlay) con efecto líquido reactivo y protección inteligente para gaming y pantalla completa.

### Principios Clave:
1. **Agnóstico y Open Source (Sin dependencias de pago obligatorias):** Basado en Web Audio API, Web Speech API nativa (Chromium/Electron) y síntesis local nativa, sin requerir APIs propietarias de pago.
2. **Interfaz de voz del Agente Líder actual:** Se conecta dinámicamente con el proveedor asignado al Product Owner o Líder en Fokkus Team (Antigravity CLI, Claude Code, DeepSeek, Ollama, etc.).
3. **Desktop Bubble Overlay:** Ventana flotante transparente, arrastrable, sin marco, con animación líquida y onda sinusoidal reactiva al habla del usuario y del asistente.
4. **Protección Gaming / Fullscreen:** Toggle de mute con clic; en pantalla completa o modo gaming, activa `setIgnoreMouseEvents` para cero interferencias con el mouse o juegos.
5. **Operación sin workspace:** Permite enviar comandos y consultar a Jarvis aun si no hay ninguna carpeta abierta (fallback a `$HOME`).

---

## Estado de las Historias de Usuario (HUs)

| HU | Alcance | Responsable | Estado |
|---|---|---|---|
| HU-1 | Soporte de chat sin workspace abierto (Fallback a $HOME) | DeepSeek V4 Pro | 🏃 In Progress |
| HU-2 | Ventana flotante de escritorio (Desktop Bubble Overlay) y efecto líquido | Claude Code (PM/QA) | 📝 To Do |
| HU-3 | Control de Mute, menú contextual y modo Gaming / Fullscreen seguro | Claude Code (PM/QA) | 📝 To Do |
| HU-4 | Pipeline de Audio desacoplado (STT/TTS) y despacho bidireccional al Líder | DeepSeek V4 Pro | 📝 To Do |
| QA | Verificación de tipos, build Theia Electron, linter y tests | Claude Code (PM/QA) | 📝 To Do |

---

## HU-1 — Soporte de chat sin workspace abierto (Fallback a $HOME)
- 📁 **Repositorio:** `theia-extensions/fokkus-orchestrator`
- 🎯 **Capa:** Backend (`src/node/fokkus-orchestrator-server.ts`) y Frontend (`src/browser/fokkus-orchestrator-widget.tsx`).
- 📌 **Objetivo técnico:**
  - En `resolveWorkspaceRoot()` y `getEffectiveCwd()`, si no hay workspace abierto, resolver a `os.homedir()` en lugar de lanzar una excepción fatal.
  - En `ensureProjectDocumentationFiles(cwd)`, si `cwd === os.homedir()`, evitar crear archivos sueltos `backlog.md` ni `technical_memory.md` en el home del usuario (usar `~/.fokkus/`).
  - En el frontend de chat, no deshabilitar ni bloquear el input si `getWorkspacePath()` está vacío.

## HU-2 — Ventana flotante de escritorio (Desktop Bubble Overlay)
- 📁 **Repositorio:** `theia-extensions/fokkus-orchestrator`, `applications/electron`
- 🎯 **Capa:** Electron Overlay Window & Renderer (HTML/Canvas 2D).
- 📌 **Objetivo técnico:**
  - Crear ventana secundaria en Electron: `width: 150, height: 150`, `transparent: true`, `frame: false`, `alwaysOnTop: true`, `skipTaskbar: true`, `hasShadow: false`.
  - Renderizado orgánico en Canvas 2D: burbuja líquida con gradiente y onda de sonido sinusoidal reactiva al volumen de voz y estados (idle, listening, thinking, speaking, muted).
  - Región arrastrable con `-webkit-app-region: drag`.

## HU-3 — Control de Mute, menú contextual y modo Gaming / Fullscreen
- 📁 **Repositorio:** `theia-extensions/fokkus-orchestrator`
- 🎯 **Capa:** Overlay Event & Input Management.
- 📌 **Objetivo técnico:**
  - Clic en la burbuja: toggle instantáneo de Mute/Escucha.
  - Clic derecho: menú contextual ("Silenciar/Activar", "Seguir oyendo en segundo plano", "Abrir chat del IDE", "Ocultar Jarvis").
  - Modo seguro gaming: cuando se requiera o esté en pantalla completa, invocar `win.setIgnoreMouseEvents(true, { forward: true })` para transparencia de clics sin robar el foco del ratón.

## HU-4 — Pipeline de Audio desacoplado (STT/TTS) y despacho bidireccional al Líder
- 📁 **Repositorio:** `theia-extensions/fokkus-orchestrator`
- 🎯 **Capa:** Audio & Orchestrator RPC Service.
- 📌 **Objetivo técnico:**
  - Captura y reconocimiento de voz (STT) con Web Speech Recognition nativo en Electron.
  - Síntesis de voz (TTS) con SpeechSynthesis nativo (`es-ES`, `es-CL`, `es-419`), modulando la onda interna durante la reproducción.
  - Envío automático del texto reconocido al Agente Líder de Fokkus Team (`dispatchSwarm`), sincronizando la transcripción y la respuesta en vivo en el chat del IDE.
