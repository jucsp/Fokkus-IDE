# Briefing DeepSeek V4 Pro — Issue #14 (reabierto): pkcon falla sin pedir autenticación

## Contexto de Negocio
Al actualizar Fokkus IDE de v1.0.8 a v1.0.9 en Linux (.rpm), el IDE ya llama a PackageKit (`pkcon`) en lugar de `pkexec`, pero la instalación falla en 2 segundos sin mostrarle al usuario ninguna ventana para ingresar su contraseña. El usuario solo ve un error genérico y no sabe qué hacer. Queremos que se abra el diálogo de contraseña de Polkit y, si igual falla, que el IDE muestre el comando manual con un botón para copiarlo.

## Diagnóstico (ya verificado por QA; no hay que volver a investigarlo)
1. Journal: `uid 1000 is trying to obtain org.freedesktop.packagekit.package-install-untrusted auth` → `failed to obtain auth`. Esa acción exige `auth_admin` en todos los casos.
2. pkcon 1.4.0 (`client/pkcon/pk-console.c`): `--noninteractive` configura la tarea con `"interactive", !noninteractive` y `"simulate", !noninteractive`. Con `interactive=false`, PackageKit consulta a Polkit sin permitir interacción del usuario → nunca aparece el diálogo del agente (polkit-kde/gnome) → rechazo inmediato.
3. Sin `--noninteractive`, pkcon simula la transacción y pregunta `Proceed with changes? [N/y]`. Esa pregunta **NO se lee de stdin**: `pk_readline_unbuffered` abre `ctermid()` (`/dev/tty`). Si Electron se lanza desde el escritorio no hay TTY controladora → `fopen` falla → la respuesta se toma como "No" y se cancela. Si se lanza desde una terminal, se queda bloqueado en esa terminal.
4. `script` (util-linux) NO está instalado en Fedora 44 → no se puede usar. `python3` sí está disponible por defecto (Fedora y Debian/Ubuntu); su módulo estándar `pty` (`pty.spawn`, que usa `os.forkpty`) crea una sesión con la pty como TTY controladora.
5. El callback actual de `execFile` descarta `stdout`/`stderr`, así que el log solo muestra "Command failed".

## HU-1 — Instalación con PackageKit interactiva y con logs completos
- 📁 Repositorio: /home/juancarlos/Proyectos/Personales/Fokkus-IDE
- 🎯 Capa: Backend Electron main — `theia-extensions/updater/src/electron-main/update/theia-updater-impl.ts` (método `installWithPackageKit`)
- 📌 Objetivo técnico:
  - Ejecutar `pkcon install-local --plain --allow-untrusted <file>` (SIN `--noninteractive`) dentro de una pseudo-TTY usando `python3 -c <script>` con `pty.spawn`. Requisitos del script de Python (solo librería estándar, sin pip):
    - Si `shutil.which('pkcon')` es None → `sys.exit(127)`.
    - Pasar la ruta del archivo como argumento (`sys.argv`), NUNCA interpolada en el código ni en un string de shell.
    - Devolver el código de salida real de pkcon (`os.waitstatus_to_exitcode` si existe; si no, `os.WEXITSTATUS` / 1).
  - Usar `spawn` de `child_process` (no `execFile`) con `stdio: 'pipe'` y `env: { ...process.env, LC_ALL: 'C.UTF-8' }`.
  - Leer stdout y stderr: acumularlos (limitar cada buffer a unos 64 KB, conservando la parte final) y quitar los `\r` de la pty.
  - Responder a las preguntas: cada vez que en stdout aparezca un nuevo `[N/y]` o `[Y/n]`, escribir `y\n` en stdin del hijo **una sola vez por pregunta** (contar las apariciones acumuladas y comparar con las respuestas ya enviadas).
  - Timeout de 10 minutos (el usuario tiene que escribir su contraseña): `kill('SIGTERM')` al vencer y tratarlo como error.
  - Manejar `error` (ENOENT de python3) y `close(code)` sin duplicar el cierre (flag `finished`). Poner `pkconInstallRunning = false` en ambos caminos.
  - Resultados:
    - código 0 → `app.relaunch(); app.quit();` (igual que ahora).
    - código 127 (sin pkcon) → mantener el fallback actual: log warn + `autoUpdater.quitAndInstall()`.
    - ENOENT de python3 u otro error → `logger.error` con código, stdout y stderr COMPLETOS, y `reportError` a los clientes.
  - Mensaje amigable para `reportError`: `Unable to install the update automatically (<detalle>). Please run in a terminal: <comando>`. El `<detalle>` es la última línea de stdout/stderr que empiece con `Fatal error:` o `Error:` (texto sin ese prefijo); si no hay → `exit code N`. El `<comando>` es `sudo dnf install "<file>"` para .rpm y `sudo apt install "<file>"` para .deb (reutilizar la lógica existente).
  - Mantener el estilo: 4 espacios, comillas simples, nada de líneas en blanco dobles (el lint lo prohíbe) y métodos privados pequeños si ayudan a la lectura.

## HU-2 — Error accionable en el frontend
- 📁 Repositorio: mismo
- 🎯 Capa: Common + Frontend — `theia-extensions/updater/src/common/updater/theia-updater.ts`, `theia-extensions/updater/src/electron-browser/updater/theia-updater-frontend-contribution.ts`
- 📌 Objetivo técnico:
  - Agregar el campo opcional `manualCommand?: string` a `UpdaterError` y enviarlo desde HU-1.
  - En `handleError`, si viene `manualCommand`, mostrar las acciones `'Copy Command'` (y `'View Error Log'` si existe `errorLogPath`). Al elegir copiar, usar `ClipboardService` (`@theia/core/lib/browser/clipboard-service`, inyectado con `@inject(ClipboardService)`) → `writeText(manualCommand)` + `messageService.info('Command copied to clipboard: ' + manualCommand)`. Mantener el comportamiento actual cuando no hay `manualCommand`.

## Restricciones
- No tocar otros archivos ni la interfaz RPC (salvo el campo opcional nuevo).
- No agregar dependencias npm.
- No hacer commit.

## Validación (la hace QA)
`yarn build` y `yarn lint` en `theia-extensions/updater` deben terminar con exit 0.
