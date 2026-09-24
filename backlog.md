# Product Backlog

Este documento contiene el listado de funcionalidades, mejoras y correcciones pendientes para **Fokkus IDE**.

## Épica 1: Estabilización Inicial
- [x] Configurar CI/CD para compilación nativa en Ubuntu y Windows.
- [x] Corregir compatibilidad de NodeJS 22 con dependencias ESM.
- [x] Automatizar la publicación de Releases en GitHub.
- [x] Renombrar binarios e instaladores comerciales a "Fokkus IDE".
- [x] #5 Detección de proyecto y contexto: el agente reconoce la carpeta abierta sin necesidad de workspace (`.theia-workspace`) y sigue el protocolo jerárquico de contexto (historial -> backlog -> proyecto).

## Bugs Reportados
- [x] #16 Responsive horizontal del chat se rompe al estrechar el panel lateral (squished text).
  - _Fix v1.0.9:_ el panel Fokkus Team tiene ancho mínimo de 260px; las burbujas, el textarea y el markdown (tablas, bloques de código, URLs largas) ya no desbordan ni se aplastan, y la barra de uso y el input se compactan con container queries en anchos chicos.
- [x] #14 Error de instalación Auto-Updater (RPM): Falla elevación de privilegios con `pkexec must be setuid root`.
  - _Fix v1.0.6:_ la app hereda `NoNewPrivs=1` del lanzador y eso anula el setuid de pkexec/sudo. Si se detecta, la instalación de `.rpm`/`.deb` se hace con PackageKit (`pkcon install-local`, sin setuid). Si falla, se muestra el comando manual.
  - _Fix v1.0.8 (regresión):_ la detección de `NoNewPrivs` no cubría todos los casos (en el cliente no se activó y electron-updater volvió a usar pkexec). Ahora en Linux los `.rpm`/`.deb` se instalan siempre con PackageKit (`pkcon install-local`); solo si `pkcon` no existe se usa el instalador de electron-updater. La instalación automática al cerrar la app queda desactivada en Linux.
  - _Fix v1.0.10 (regresión):_ `pkcon --noninteractive` desactiva la interacción con Polkit, así que la contraseña nunca se pedía y PackageKit rechazaba la instalación. Ahora pkcon se ejecuta sin esa flag, dentro de una pseudo-terminal (`python3` + `pty`), porque su confirmación se lee de la TTY, y el updater responde «y» automáticamente. El log guarda stdout/stderr completos y, si falla, el aviso muestra el motivo y un botón «Copy Command» con `sudo dnf/apt install ...`.
- [x] #13 El Auto-Updater no comprueba actualizaciones automáticamente en segundo plano ni al iniciar (solo funciona manual desde Help > Check for Updates).
  - _Fix v1.0.6:_ la primera sincronización de preferencias siempre programa el chequeo inicial y el intervalo. Los errores de los chequeos en segundo plano solo se registran en el log.
- [x] #10 Caja de chat aparece a la mitad cuando se recien se ejecuta el IDE.
- [x] #9 No se puede usar WSL en Windows 11.
- [x] #8 Texto opaco o poco visible en la UI del IDE (Windows 11).

## Mejoras y Nuevas Funcionalidades (Enhancements)
- [x] #18 Permitir configurar roles Product Owner de tipo API (eliminar restricción estricta de CLI).
  - _Fix v1.0.11:_ el backend ya no descarta al PO de tipo API: lo ejecuta contra un endpoint compatible con OpenAI (`POST {apiEndpoint}/chat/completions`, con `apiKey` y `model` del proveedor). Si falta el endpoint o el modelo, se avisa qué falta. El botón «Stop» también cancela la petición HTTP. Un PO vía API solo responde en el chat (planifica y delega): para que edite archivos y ejecute comandos sigue haciendo falta un agente CLI. La ayuda de Providers ya no dice que el PO debe ser CLI.
- [ ] #17 Agregar ejemplos de configuraciones de agentes CLI en la sección de Ayuda de Providers.
- [ ] #15 Abrir carpeta en el explorador al arrastrarla dentro del IDE (Drag and Drop).
- [x] #12 Agregar botón "Stop" en el chat para detener la ejecución de los agentes.
- [x] #11 Agregar botón de papelera para borrar agentes desde el grafo visualmente.
- [x] #7 Implementar actualización desde el IDE (detectar nuevo release y notificar mediante popup).
- [ ] #6 Implementar integración con Bitbucket (mediante token o OAuth deseable).
- [ ] #4 Implementar integración con Github (mediante token o OAuth deseable).
- [x] #3 En Providers, agregar helper que de ayuda de como integrar proveedores (Gemini, Claude, GPT, DeepSeek).
  - _Fix v1.0.7:_ botón «Ayuda» en Settings > Providers que abre un panel con una guía por proveedor (Claude, Gemini, OpenAI, DeepSeek, Ollama): dónde crear la API Key, Base URL compatible con OpenAI y modelos de ejemplo. Los links se abren en el navegador del sistema y «Usar esta configuración» rellena el formulario de alta.

## Épica 2: Mejoras de Usuario (UX/UI) (Deuda Técnica)
- [ ] Personalizar los iconos de la aplicación (Linux/Windows) con el logo oficial de Fokkus.
- [ ] Revisar el tema oscuro por defecto y los colores de la interfaz.

---
*Nota: Este backlog es mantenido por el Product Owner (Antigravity) según las metodologías de la Fábrica de Software.*
