# Product Backlog

Este documento contiene el listado de funcionalidades, mejoras y correcciones pendientes para **Fokkus IDE**.

## Épica 1: Estabilización Inicial
- [x] Configurar CI/CD para compilación nativa en Ubuntu y Windows.
- [x] Corregir compatibilidad de NodeJS 22 con dependencias ESM.
- [x] Automatizar la publicación de Releases en GitHub.
- [x] Renombrar binarios e instaladores comerciales a "Fokkus IDE".
- [x] #5 Detección de proyecto y contexto: el agente reconoce la carpeta abierta sin necesidad de workspace (`.theia-workspace`) y sigue el protocolo jerárquico de contexto (historial -> backlog -> proyecto).

## Bugs Reportados
- [x] #14 Error de instalación Auto-Updater (RPM): Falla elevación de privilegios con `pkexec must be setuid root`.
  - _Fix v1.0.6:_ la app hereda `NoNewPrivs=1` del lanzador y eso anula el setuid de pkexec/sudo. Si se detecta, la instalación de `.rpm`/`.deb` se hace con PackageKit (`pkcon install-local`, sin setuid). Si falla, se muestra el comando manual.
- [x] #13 El Auto-Updater no comprueba actualizaciones automáticamente en segundo plano ni al iniciar (solo funciona manual desde Help > Check for Updates).
  - _Fix v1.0.6:_ la primera sincronización de preferencias siempre programa el chequeo inicial y el intervalo. Los errores de los chequeos en segundo plano solo se registran en el log.
- [x] #10 Caja de chat aparece a la mitad cuando se recien se ejecuta el IDE.
- [x] #9 No se puede usar WSL en Windows 11.
- [x] #8 Texto opaco o poco visible en la UI del IDE (Windows 11).

## Mejoras y Nuevas Funcionalidades (Enhancements)
- [x] #12 Agregar botón "Stop" en el chat para detener la ejecución de los agentes.
- [x] #11 Agregar botón de papelera para borrar agentes desde el grafo visualmente.
- [x] #7 Implementar actualización desde el IDE (detectar nuevo release y notificar mediante popup).
- [ ] #6 Implementar integración con Bitbucket (mediante token o OAuth deseable).
- [ ] #4 Implementar integración con Github (mediante token o OAuth deseable).
- [ ] #3 En Providers, agregar helper que de ayuda de como integrar proveedores (Gemini, Claude, GPT, DeepSeek).

## Épica 2: Mejoras de Usuario (UX/UI) (Deuda Técnica)
- [ ] Personalizar los iconos de la aplicación (Linux/Windows) con el logo oficial de Fokkus.
- [ ] Revisar el tema oscuro por defecto y los colores de la interfaz.

---
*Nota: Este backlog es mantenido por el Product Owner (Antigravity) según las metodologías de la Fábrica de Software.*
