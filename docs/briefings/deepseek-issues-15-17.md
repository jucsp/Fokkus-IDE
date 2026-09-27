# Briefing DeepSeek — Issues #17 y #15

## Contexto de negocio
- **#17:** la ayuda de Settings > Providers explica bien cómo conectar proveedores por API, pero casi no dice nada de los agentes CLI (Antigravity `agy`, Claude Code, etc.), que son los que pueden editar archivos y ejecutar comandos. El cliente quiere ejemplos reales con el comando exacto para copiar. Además, el ejemplo de Ollama indicaba `http://localhost:11434` como comando CLI, lo que no funciona porque el backend lo ejecuta en una shell.
- **#15:** para abrir un proyecto hoy hay que ir a File > Open Folder. El cliente quiere arrastrar una carpeta desde el gestor de archivos del sistema operativo al IDE y que se abra en el explorador.

## HU-1 — Ejemplos de agentes CLI en la ayuda de Providers (#17)
- 📁 **Repositorio:** Fokkus-IDE — `theia-extensions/fokkus-orchestrator`
- 🎯 **Capa a trabajar:** Frontend (React). Archivo: `src/browser/fokkus-orchestrator-widget.tsx` (`PROVIDER_HELP_GUIDES`, `ProvidersPanel`, `DEFAULT_PROVIDERS`).
- 📌 **Objetivo técnico:** Agregar guías de agentes CLI con su comando no interactivo real, compatible con cómo `runCliAgent` arma el comando (el prompt va como último argumento o en `{prompt}`). Permitir usar la configuración de una guía CLI para rellenar el formulario. Corregir el ejemplo de Ollama.

## HU-2 — Abrir carpeta al arrastrarla al IDE (#15)
- 📁 **Repositorio:** Fokkus-IDE — `theia-extensions/product`
- 🎯 **Capa a trabajar:** Frontend (Theia, Electron). Nueva contribución en `src/browser/`, registrada en `theia-ide-frontend-module.ts`.
- 📌 **Objetivo técnico:** Detectar cuando se suelta una carpeta del sistema operativo en la ventana y abrirla en el explorador (sin carpeta abierta) o permitir añadirla al workspace / abrirla (con carpeta abierta), sin romper el drop de archivos ni la copia de archivos dentro del árbol del explorador.
