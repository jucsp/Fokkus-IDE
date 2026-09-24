# Briefing DeepSeek V4 Pro — Regresión Issue #14 (pkexec must be setuid root)

## Contexto de Negocio
En v1.0.6 se agregó un fallback a PackageKit (`pkcon`) para instalar actualizaciones .rpm/.deb sin pkexec. El log de un cliente real (v1.0.6 → v1.0.7) muestra que el fallback nunca se activó: se llamó a `autoUpdater.quitAndInstall()`, electron-updater 6.8.9 (`LinuxUpdater.runCommandWithSudoIfNeeded`) eligió `pkexec` y falló con `pkexec must be setuid root` (exit 127). El usuario no puede actualizar.

Causa raíz (QA): el fallback depende de `hasNoNewPrivs()` (lectura de `/proc/self/status`). Esa heurística no cubre todos los casos en que pkexec no puede elevar (montaje `nosuid`, user namespaces, sandbox del lanzador, etc.), así que `setuidBlocked` quedó en `false` y el código tomó la rama de `quitAndInstall()`. Además, con `autoInstallOnAppQuit` en `true` (valor por defecto), al cerrar la app electron-updater también intenta instalar con pkexec.

## HU-1 — Instalación Linux .rpm/.deb siempre por PackageKit
- 📁 Repositorio: /home/juancarlos/Proyectos/Personales/Fokkus-IDE
- 🎯 Capa: Backend Electron main — `theia-extensions/updater/src/electron-main/update/theia-updater-impl.ts`
- 📌 Objetivo técnico:
  1. En Linux, cuando el paquete descargado es `.rpm` o `.deb`, NO depender de ninguna heurística de privilegios: instalar siempre primero con PackageKit (`pkcon install-local --noninteractive --allow-untrusted <file>`), que eleva por D-Bus/polkit sin binario setuid.
  2. Solo si `pkcon` no existe (error `ENOENT` de `execFile`), caer a `autoUpdater.quitAndInstall()` (comportamiento original de electron-updater).
  3. Si `pkcon` existe pero falla, NO llamar a `quitAndInstall()`: reportar el error a los clientes con el comando manual (`sudo dnf install "<file>"` / `sudo apt install "<file>"`), como ya se hace.
  4. En Linux, poner `autoUpdater.autoInstallOnAppQuit = false` siempre (para que el cierre de la app nunca dispare pkexec). Mantener el valor por defecto en Windows/macOS.
  5. Eliminar `hasNoNewPrivs()`, el campo `setuidBlocked` y cualquier código que quede muerto; ajustar el log del constructor.
  6. Evitar doble ejecución: si el usuario pulsa "Restart to update" dos veces mientras pkcon corre, ignorar la segunda llamada (flag privado).
  7. No cambiar la interfaz pública `TheiaUpdater` ni el resto de la lógica (chequeos automáticos #13). Estilo: 4 espacios, comillas simples, sin líneas en blanco dobles.

## Validación (QA)
`yarn build` y `yarn lint` en `theia-extensions/updater` con exit 0 (solo se tolera el warning de deprecación de JsonRpcConnectionHandler).
