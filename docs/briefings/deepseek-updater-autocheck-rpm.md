# Briefing DeepSeek V4 Pro — Sprint Bugfixes v1.0.6: Issues #13 y #14 (auto-updater)

## Contexto de Negocio
El auto-updater de Fokkus IDE (electron-updater 6.8.9 + GitHub Releases) funciona cuando el usuario lo lanza a mano
(Help > Check for Updates), pero tiene dos fallas reportadas:
- **#13:** nunca busca actualizaciones solo, ni al iniciar ni cada 60 minutos. Los usuarios no se enteran de las versiones nuevas.
- **#14:** en Linux (Fedora KDE, RPM) descarga la actualización, pero la instalación falla con `pkexec must be setuid root`.

## Diagnóstico QA (verificado)
- **#13:** en `TheiaUpdaterImpl.setUpdaterSettings()`, `scheduleUpdateChecks()` solo se ejecuta si `settingsChanged` es true.
  El frontend envía los valores por defecto (`true`/`60`/`stable`), que son iguales a los iniciales del backend, así que
  el chequeo inicial y el `setInterval` nunca se programan. `onStart()` está vacío.
- **#14:** reproducido con `setpriv --no-new-privs pkexec --disable-internal-agent /bin/true`, que devuelve
  `pkexec must be setuid root` con exit 127. `sudo` falla igual. `/usr/bin/pkexec` sí tiene setuid. La causa es que
  el lanzador del escritorio arranca la app con el flag del kernel `NoNewPrivs: 1` (visible en `/proc/self/status`),
  que se hereda y anula el setuid de pkexec/sudo. electron-updater (`LinuxUpdater.runCommandWithSudoIfNeeded`) solo
  sabe elevar privilegios con gksudo/kdesudo/pkexec/beesu/sudo, que son todos binarios setuid. **PackageKit
  (`pkcon`) no depende de setuid:** habla por D-Bus con `packagekitd` (que corre como root) y la autorización la
  resuelve polkit con el agente gráfico de la sesión. En la máquina de QA está `/usr/bin/pkcon` con el backend dnf5.

## HU-1 — #13 Chequeo automático al iniciar y periódico
- 📁 Repo: /home/juancarlos/Proyectos/Personales/Fokkus-IDE
- 🎯 Capa: Backend Electron main, en `theia-extensions/updater/src/electron-main/update/theia-updater-impl.ts`
- 📌 Objetivo técnico:
  1. Agregar `private settingsReceived = false;`. En `setUpdaterSettings`, la PRIMERA llamada siempre ejecuta
     `scheduleUpdateChecks()`. Las siguientes llamadas solo lo ejecutan si `settingsChanged`.
  2. Chequeos en segundo plano silenciosos ante errores: agregar `private backgroundCheck = false;` y un método privado
     `runBackgroundCheck()`, que usan tanto el chequeo inicial como el `setInterval` de `scheduleUpdateChecks`
     (reemplaza a las llamadas `this.checkForUpdates(false)`).
     - Si ya hay una actualización descargada (`this.updateDownloaded`, ver HU-2), no hace nada.
     - Pone `this.backgroundCheck = true`, asigna `autoUpdater.allowPrerelease` igual que `checkForUpdates` y llama a
       `autoUpdater.checkForUpdates().catch(err => autoUpdater.logger.error('Background update check failed', err))`.
     - En los handlers `update-available`, `update-not-available` y `error`, resetear `backgroundCheck = false`.
       Además, en `error`, si `backgroundCheck` era true, solo loguear (`autoUpdater.logger.warn`) y NO llamar a
       `reportError` en los clientes. Así no aparece un diálogo de error cada hora cuando no hay red.
     - `checkForUpdates()` (manual, público) pone `this.backgroundCheck = false` antes de chequear.
  3. `onStart` puede quedar vacío. No agregues timers con los valores por defecto antes de recibir las preferencias,
     porque eso ignoraría la preferencia del usuario `updates.checkForUpdates = false`.

## HU-2 — #14 Instalación RPM/DEB sin setuid (PackageKit)
- 📁 Repo: mismo
- 🎯 Capa: Backend Electron main, mismo archivo
- 📌 Objetivo técnico:
  1. Función de módulo `hasNoNewPrivs(): boolean`. Si `process.platform !== 'linux'`, devuelve false. Si no, lee
     `/proc/self/status` con `fs.readFileSync` (`import * as fs from 'fs'`) y aplica `/^NoNewPrivs:\s*1\s*$/m`.
     Envolver en try/catch y devolver false ante un error.
  2. Campo `private readonly setuidBlocked = hasNoNewPrivs();`. En el constructor, si `setuidBlocked`:
     `autoUpdater.autoInstallOnAppQuit = false;` (si no, al cerrar la app electron-updater reintenta pkexec y falla)
     y loguear un info explicando que se usará PackageKit.
  3. Handler `update-downloaded`: recibe `(event: { downloadedFile?: string })`, guarda `this.downloadedFile` y
     `this.updateDownloaded = true`, y mantiene el `notifyReadyToInstall()` existente.
  4. `onRestartToUpdateRequested()`: si `this.setuidBlocked && this.downloadedFile && /\.(rpm|deb)$/.test(this.downloadedFile)`,
     llama a `this.installWithPackageKit(this.downloadedFile)`. Si no, llama a `autoUpdater.quitAndInstall()` como hoy.
  5. `private installWithPackageKit(file: string): void`:
     - Usar `execFile` de `child_process` (asíncrono, NUNCA spawnSync, para no bloquear el main process mientras el
       usuario autentica en el diálogo de polkit):
       `execFile('pkcon', ['install-local', '--noninteractive', '--allow-untrusted', file], { timeout: 10 * 60 * 1000 }, cb)`.
     - Loguear el comando antes de ejecutarlo.
     - Éxito (sin error): `app.relaunch(); app.exit(0);`. Importar `app` con
       `import { app } from '@theia/core/electron-shared/electron';` (patrón usado en `theia-extensions/product`).
     - Error (incluye ENOENT si no existe pkcon): `autoUpdater.logger.error(...)` y
       `this.clients.forEach(c => c.reportError({ message, errorLogPath }))`, con un `message` en inglés (igual que
       el resto de la UI) que diga que no se pudo instalar automáticamente e incluya el comando manual:
       `sudo dnf install "<file>"` si termina en `.rpm`, o `sudo apt install "<file>"` si termina en `.deb`.
       `errorLogPath` se obtiene igual que en el handler `error`.
  6. `dispose()` y `onStop()` siguen limpiando el timer.

## Reglas estrictas
- Editar SOLO `theia-updater-impl.ts`. No cambiar la interfaz `TheiaUpdater` ni el frontend.
- Estilo: 4 espacios, comillas simples, punto y coma, sin líneas en blanco dobles (ESLint `no-multiple-empty-lines`),
  sin `any` explícito nuevo (usar `unknown` o tipos concretos).
- Conservar el header de copyright y toda la lógica existente que no se menciona arriba.
- Verificar con `leer_archivo_local` cada edición.

## Validación (la hace QA)
`yarn build` y `yarn lint` en `theia-extensions/updater` con exit 0.
