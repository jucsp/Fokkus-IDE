# Briefing DeepSeek V4 Pro — Bugs #10, #9, #8 (Fokkus IDE)

## Contexto de Negocio
Usuarios reportan tres fallos de UX: (1) al abrir el IDE la caja del chat "Fokkus Team" aparece cortada hasta que se escribe algo; (2) en Windows 11 no se puede trabajar con proyectos dentro de WSL; (3) en Windows 11 el texto de la UI se ve opaco/ilegible. Son bloqueantes de adopción en Windows y afectan la primera impresión en todos los SO.

## Reglas generales (obligatorias)
- Stack: Eclipse Theia 1.76.0-next.18, TypeScript estricto, React (ReactWidget), InversifyJS. No agregar dependencias npm nuevas.
- Aplica los cambios físicamente en disco con tus herramientas; no devuelvas solo texto.
- No tocar `backlog.md`, no hacer commits.
- Mantén el estilo existente: comentarios breves en español, 4 espacios, comillas simples en TS.
- Al terminar: `yarn --cwd theia-extensions/fokkus-orchestrator build` debe compilar sin errores y el build de `applications/electron` debe completarse (HU-2 Parte A toca el bundling).
- Aclaración de rutas: NO existen `fokkus-chat` ni `fokkus-ide-theme`. El chat y el tema viven en `theia-extensions/fokkus-orchestrator`.

---

## HU-1 — Bug #10: Caja de chat cortada al iniciar
- 📁 Repositorio: `/home/juancarlos/Proyectos/Personales/Fokkus-IDE`
- 🎯 Capa: Frontend — `theia-extensions/fokkus-orchestrator/src/browser/fokkus-orchestrator-widget.tsx` (`FokkusChatApp`, `FokkusChatWidget`) y `src/browser/style/index.css`
- 📌 Objetivo técnico:
  **Evidencia (captura del ticket):** placeholder "¿Qué deseas construir hoy" cortado horizontalmente a la mitad dentro de la caja de input. Encaja con la causa 1.
  Diagnóstico QA (causas confirmadas en código):
  1. `resizePromptInput()` (≈L1321) fija `el.style.height = scrollHeight px`. `FokkusOrchestratorContribution.onStart` abre la vista y `FokkusChatWidget.init()` llama `this.update()` antes de que el widget esté adjunto/visible → `scrollHeight` = 0 → altura inline `0px`. Con `box-sizing: border-box` (clase `theia-input`) + `padding: 10px 14px` + `min-height: 22px`, el área de contenido queda en ~0-2 px y el texto/placeholder se ve cortado. El efecto solo se re-ejecuta al cambiar `promptText`, por eso "se arregla al escribir". Además con border-box la altura debería ser `scrollHeight + bordes`, no `scrollHeight`.
  2. `messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })` (≈L1335) se ejecuta en el montaje; `scrollIntoView` desplaza TODOS los ancestros desplazables, incluidos contenedores Lumino con `overflow: hidden` (`.theia-sidepanel-content`, `.lm-DockPanel-widget` en `theme.css`), lo que puede dejar el panel desplazado "a la mitad".
  Requisitos de la solución:
  - Ignorar mediciones cuando el textarea no es visible (`scrollHeight === 0` / `offsetParent === null`) y no escribir `0px`.
  - Calcular altura respetando border-box (sumar bordes o usar `offsetHeight - clientHeight`), con tope 160 px.
  - Re-medir cuando el widget se muestra o cambia de tamaño: sobrescribir `onAfterShow`/`onResize`/`onActivateRequest` en `FokkusChatWidget` (llamando a `super`) y propagar a React (p. ej. un contador de "layout version" o un `ResizeObserver` sobre el textarea con cleanup en el `useEffect`).
  - Reemplazar `scrollIntoView` por scroll directo del contenedor `.fokkus-chat-messages` (`container.scrollTop = container.scrollHeight`) usando un ref al contenedor; eliminar el ref `messagesEndRef` si queda sin uso.
  - `.fokkus-chat` debe tener `min-height: 0` y `overflow: hidden`; `.fokkus-chat-messages` `min-height: 0` para que el flex no desborde.
  - Criterio de aceptación: al arrancar el IDE con el panel visible y también con el panel colapsado y luego expandido, el textarea muestra el placeholder completo en una línea sin escribir nada, y el panel no queda desplazado.

---

## HU-2 — Bug #9: No se puede usar WSL en Windows 11
- 📁 Repositorio: `/home/juancarlos/Proyectos/Personales/Fokkus-IDE`
- 🎯 Capa: Build/empaquetado del backend Electron (`package.json` raíz → `resolutions`, `applications/electron/esbuild.mjs`) + backend `theia-extensions/fokkus-orchestrator/src/node/fokkus-orchestrator-server.ts` + frontend `src/browser/fokkus-orchestrator-contribution.ts`
- 📌 Objetivo técnico:
  **Evidencia (captura del ticket):** toast `Failed to connect to WSL: rLl is not a function`.

  **Diagnóstico QA — causa raíz (reproducida):**
  - El toast lo emite `@theia/remote-wsl/src/electron-node/remote-wsl-connection-provider.ts` (`connectToWsl`, bloque `catch`: `Failed to connect to WSL: ${e.message}`). La excepción viene de `RemoteSetupService.setup()` (`@theia/remote`).
  - En `setup()` → `copyService.copyToRemote()` → `getFiles()` → `RemoteNativeDependencyService.storeDependency()` se llama `decompress(archiveBuffer, directory, { plugins })`. Con host Windows y remoto Linux esto se ejecuta SIEMPRE en la primera conexión: `AppNativeDependencyContribution` descarga `native-dependencies-linux-x64.zip` y lo descomprime localmente.
  - El `package.json` raíz tiene `"resolutions": { "**/decompress": "npm:@xhmikosr/decompress@^5.0.0" }`. Ese paquete es **ESM puro** (`"type": "module"`, `export default`). El código de Theia hace `const decompress = require("decompress")` y lo invoca como función. Al empaquetar el backend con esbuild (`format: cjs`, minificado), `require()` de un módulo ESM devuelve el namespace `{ default: fn }` → `decompress(...)` lanza `TypeError: <nombre minificado> is not a function` → `rLl`.
  - Reproducción QA en Linux: bundle esbuild `--platform=node --format=cjs --minify` de `require("decompress")(...)` → `ERR: Di is not a function`, `typeof: object [ 'default' ]`. Mismo patrón que el ticket.
  - En Linux/macOS no se reproduce en uso normal porque no se usa Remote-WSL; el bug está en el bundle de todos los SO.
  - **Daño colateral (mismo origen):** `@theia/plugin-ext` (`plugin-deployer-file-handler-context-impl`) y `@theia/plugin-ext-vscode` (`plugin-vscode-utils`, instalación de `.vsix`) también hacen `require("decompress")` y fallan igual en la app empaquetada. `@theia/cli` (`download-plugins`) usa el mismo import en tiempo de build.

  **Requisitos de la solución — Parte A (bloqueante, resuelve el toast):**
  1. Corregir la interoperabilidad CJS/ESM de `decompress` en UN solo punto que cubra los 3 consumidores (`@theia/remote`, `@theia/plugin-ext`, `@theia/plugin-ext-vscode`). Analiza y elige entre: (a) plugin esbuild en `applications/electron/esbuild.mjs` (`onResolve`/`onLoad`) que redirija `decompress` a un shim que exporte `mod.default ?? mod`; (b) cambiar/eliminar el `resolution` de `**/decompress` volviendo a una versión CommonJS sin vulnerabilidades conocidas (`decompress@^4.2.1` ya incluye el fix de path traversal CVE-2020-12265). Justifica la elección en el entregable. No usar `patch-package` sobre 3 paquetes si un solo punto resuelve.
  2. Aplicar lo mismo al bundle de la app browser si comparte el backend (`applications/browser`), para no dejar el bug de `.vsix` ahí.
  3. Tras el cambio, `yarn.lock` debe quedar coherente (regenerar con `yarn install`, no editar a mano).
  4. Verificación obligatoria: construir el backend Electron y comprobar con `grep`/script sobre el bundle generado (`applications/electron/lib/backend/*.js`) que `decompress` se invoca como función (p. ej. un script Node que cargue el módulo del bundle o una prueba unitaria mínima del shim). Adjuntar el comando y la salida.
  5. No modificar código dentro de `node_modules`.

  **Requisitos — Parte B (se mantiene del diagnóstico previo, integración del orquestador):**
  - Escenario A — carpeta abierta como `\\wsl.localhost\<distro>\...` o `\\wsl$\...` SIN Remote-WSL: el backend corre en Windows, `getEffectiveCwd()` devuelve ruta UNC y `runCliAgent` (rama `win32`) lanza el CLI de Windows con `cwd` UNC; los CLIs de agentes suelen estar instalados dentro de la distro. Detectar rutas WSL (regex case-insensitive `^\\\\(wsl\.localhost|wsl\$)\\([^\\]+)\\(.*)$` y la forma URI `file://wsl.localhost/<distro>/...`), extraer `distro` y ruta Linux, y ejecutar el agente con `spawn('wsl.exe', ['-d', distro, '--cd', linuxPath, '--', 'bash', '-lc', <comando>], { cwd: os.homedir(), shell: false, env })`, pasando `FOKKUS_SAFE_PROMPT` vía `WSLENV` (`FOKKUS_SAFE_PROMPT/u`). `--add-dir` de `agy` recibe la ruta Linux. Extraer la construcción del comando POSIX a un método privado reutilizable (sin duplicar la lógica de `{prompt}`). No romper el fix de 1.0.2 (rama Windows nativa sin cmd.exe para el prompt); si el ejecutable nativo resuelve a `.cmd`/`.bat`, devolver un error claro en `SwarmAgentResult.error`.
  - Escenario B — conectado por Remote-WSL (posible solo tras la Parte A): el backend corre en Linux, `getDesktopEnvironment()` devuelve `linux` sin `XDG_CURRENT_DESKTOP` → se aplica `fokkus-os-kde` sobre Windows. La clase `fokkus-os-*` debe decidirse con el SO del cliente (`OS.type()`/`isWindows`/`isOSX` de `@theia/core` en el navegador) y consultar al backend solo para distinguir escritorios Linux.

  **Riesgos a documentar (no bloqueantes, no resolver sin avisar):**
  - Como la versión es `1.76.0-next.18`, `AppNativeDependencyContribution` descarga los nativos desde el release rolling `next` de GitHub; pueden no coincidir con el ABI de esta versión. Si tras la Parte A aparece otro error en "Installing application on remote...", reportarlo con el mensaje exacto.

  - Criterio de aceptación: (1) En Windows 11, `Connect to WSL` → elegir distro → conecta sin toast de error y abre ventana remota; (2) instalar un `.vsix` desde el IDE empaquetado funciona; (3) con backend Windows y carpeta `\\wsl.localhost\Ubuntu\home\user\proj`, el agente se ejecuta con `pwd` = `/home/user/proj` dentro de Ubuntu; (4) conectado por Remote-WSL, los controles de ventana siguen siendo los de Windows 11.

---

## HU-3 — Bug #8: Texto opaco / poco visible en Windows 11
- 📁 Repositorio: `/home/juancarlos/Proyectos/Personales/Fokkus-IDE`
- 🎯 Capa: Configuración de aplicación (`applications/electron/package.json`, `applications/browser/package.json`) + tema global `theia-extensions/fokkus-orchestrator/src/browser/style/theme.css` + contribución frontend
- 📌 Objetivo técnico:
  **Evidencia (captura del ticket):** menú superior (File, Edit…) y textos de bienvenida en gris casi negro sobre fondo oscuro → ilegible. Confirma el diagnóstico.
  Diagnóstico QA (causa raíz confirmada):
  - Ninguna app define `frontend.config.defaultTheme`, así que Theia usa el default `{ light: 'light', dark: 'dark' }` y elige según `prefers-color-scheme` del SO (`@theia/application-package/src/application-props.ts:115`, `core/src/browser/theming.ts:159`). Windows 11 en modo claro → tema **Light** → foregrounds oscuros (#616161, #1f1f1f…).
  - `theme.css` fuerza fondos transparentes y un body `#0a0a0e` también para `body.theia-light`/`vscode-light`, pero NO redefine ningún color de texto. Resultado: texto gris oscuro sobre fondo casi negro = contraste < 2:1. En Linux con tema oscuro no se reproduce.
  - Agravante: `--theia-editor-background: transparent` + múltiples `backdrop-filter` hacen que Chromium en Windows desactive el antialiasing ClearType (subpíxel) → texto aún más fino/lavado. La fuente `Inter` no viene instalada en Windows.
  Requisitos de la solución:
  1. Añadir `"defaultTheme": "dark"` en `theia.frontend.config` de `applications/electron/package.json` y `applications/browser/package.json`.
  2. Migración única para usuarios existentes (el tema queda guardado en `localStorage`): en `FokkusOrchestratorContribution.onStart`, con un flag `fokkus.themeMigration.v1` en `localStorage`, si `ThemeService.getCurrentTheme().type` es `light` o `hcLight`, cambiar a `dark` una sola vez. Inyectar `ThemeService` desde `@theia/core/lib/browser/theming`.
  3. En `theme.css`, dentro del bloque de variables raíz, fijar foregrounds legibles (≥ 4.5:1 sobre #0a0a0e): `--theia-foreground`, `--theia-ui-font-color0..3`, `--theia-descriptionForeground`, `--theia-sideBar-foreground`, `--theia-editor-foreground`, `--theia-input-foreground`, `--theia-input-placeholderForeground`, `--theia-menu-foreground`, `--theia-tab-inactiveForeground`, `--theia-list-inactiveSelectionForeground`. Sugerencia de rango: principal #e6e6ef, secundario #b4b4c6, placeholder ≥ #8a8aa0. Quitar `theia-light`/`vscode-light` del selector de fondos si el fondo oscuro se mantiene forzado (no mezclar fondo oscuro con paleta clara).
  4. Windows: en `html body.fokkus-os-win` añadir `-webkit-font-smoothing: auto; text-rendering: optimizeLegibility;` y anteponer `'Segoe UI Variable Text', 'Segoe UI'` a la pila tipográfica para ese SO.
  5. Revisar en `index.css` los `color: rgba(255,255,255,0.45..0.6)` usados como fallback de `--theia-descriptionForeground` y subirlos a ≥ 0.7 de opacidad.
  - Criterio de aceptación: Windows 11 en modo claro, primera ejecución y ejecución con tema Light previamente guardado → IDE abre en Dark; texto del explorador, menús, tabs, placeholder del chat y descripciones con contraste ≥ 4.5:1.

---

## Entregable esperado
Lista de archivos modificados con resumen por HU. QA (Claude) validará con build + prueba manual en Linux y revisión de diff para las ramas Windows/WSL.
