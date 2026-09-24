# Briefing DeepSeek — Issue #16: responsive del chat "Fokkus Team"

## Contexto de negocio
Al estrechar el panel lateral **Fokkus Team**, el texto de los mensajes se aplasta en columnas de una letra y los botones de abajo (barra de uso/Compactar e input) se montan unos sobre otros. El chat tiene que seguir siendo legible y usable con cualquier ancho del panel.

## HU-1 — Layout responsive del chat
- 📁 **Repositorio:** Fokkus-IDE — `theia-extensions/fokkus-orchestrator`
- 🎯 **Capa a trabajar:** Frontend (React + CSS). Archivos: `src/browser/fokkus-orchestrator-widget.tsx` (componente `FokkusChatApp`, JSX desde `<div className='fokkus-chat'>`) y `src/browser/style/index.css` (sección `/* Chat Widget Layout */`).
- 📌 **Objetivo técnico:**
  1. Ponerle un ancho mínimo razonable al widget (id `fokkus-chat-widget`) para que el split panel de Lumino no pueda achicarlo por debajo de lo usable.
  2. Arreglar el cálculo de tamaño de los flex items: burbujas, contenedor del textarea y los hijos markdown (`pre`, `table`, `img`, URLs largas) no deben forzar desborde horizontal ni quedar aplastados.
  3. Pasar los estilos inline de la barra de uso (progreso + contador + Compactar) y del contenedor del textarea/adjuntos a clases CSS, y hacer que la barra y el input se adapten a anchos chicos sin superponerse (container queries sobre `.fokkus-chat`; Electron 42 las soporta).
  4. No cambiar comportamiento, handlers ni textos.
