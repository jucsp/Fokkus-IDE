# Briefing DeepSeek V4 Pro — Correcciones auto-updater GitHub Releases (Issue #7)

## Contexto de Negocio
Fokkus IDE debe auto-actualizarse desde las Releases de GitHub (jucsp/Fokkus-IDE). El commit ae6c091 cambió el feed en código, pero la auditoría QA encontró que: el lint falla, la release no publica los metadatos que necesita electron-updater (latest.yml / latest-linux.yml), los nombres de los instaladores tienen espacios (GitHub los renombra y el updater recibe 404), y hay promesas sin capturar en el proceso main.

## HU-1 — Robustez de TheiaUpdaterImpl
- 📁 Repo: /home/juancarlos/Proyectos/Personales/Fokkus-IDE
- 🎯 Capa: Backend Electron main — `theia-extensions/updater/src/electron-main/update/theia-updater-impl.ts`
- 📌 Cambios EXACTOS:
  1. Eliminar las líneas en blanco dobles (líneas ~14-15 y ~151-152) para que `yarn lint` pase (`no-multiple-empty-lines`).
  2. Mover `autoUpdater.setFeedURL({ provider: 'github', owner: 'jucsp', repo: 'Fokkus-IDE' })` al constructor (una sola vez). Definir owner/repo como constantes de módulo `GITHUB_OWNER` / `GITHUB_REPO`.
  3. `checkForUpdates()`: antes de chequear, asignar `autoUpdater.allowPrerelease = this.settings.channel !== 'stable';`. Encadenar `.catch((err: unknown) => autoUpdater.logger.error('Update check failed', err))` a `autoUpdater.checkForUpdates()` (el evento 'error' ya notifica a los clientes; el catch solo evita unhandled rejections).
  4. `downloadUpdate()`: igual, `.catch(...)` sobre `autoUpdater.downloadUpdate(this.cancellationToken)` con log.
  5. Guardar el último `UpdateInfo` recibido en 'update-available' en un campo privado `lastUpdateInfo?: UpdateInfo` (importar `UpdateInfo` desde `../../common/updater/theia-updater`) y usarlo en `setClient` cuando `reportOnFirstRegistration` es true: `c.updateAvailable(true, this.lastUpdateInfo)`.
  6. No cambiar la interfaz pública ni el resto de la lógica. Mantener estilo (4 espacios, comillas simples).

## HU-2 — Configuración de publicación
- 📁 Repo: mismo
- 🎯 Capa: Build/CI — `applications/electron/electron-builder.yml`, `.github/workflows/release.yml`
- 📌 Cambios EXACTOS:
  1. En `electron-builder.yml`, eliminar los tres bloques `publish:` (generic, eclipse.org) dentro de `win`, `mac`, `linux` y agregar UN bloque top-level (debajo de `npmRebuild: false`):
     ```yaml
     publish:
       provider: github
       owner: jucsp
       repo: Fokkus-IDE
       releaseType: release
     ```
  2. En `electron-builder.yml` reemplazar los `artifactName` con espacios: nsis → `Fokkus-IDE-Setup.${ext}`; dmg, deb, appImage, rpm → `Fokkus-IDE.${ext}`.
  3. En `.github/workflows/release.yml`, en el step "Upload Release Artifacts", añadir a `files:` las líneas `applications/electron/dist/latest*.yml` y `applications/electron/dist/*.blockmap`.
  4. NO tocar nada más del workflow.

## Validación (la hará QA)
`yarn build` y `yarn lint` en `theia-extensions/updater` deben terminar con exit 0 (solo se tolera el warning de deprecación de JsonRpcConnectionHandler).
