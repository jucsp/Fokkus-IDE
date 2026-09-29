# Briefings DeepSeek V4 Pro — v1.4.0 (Issues #21 y #20)

Plan general: `implementation_plan.md`. Tres delegaciones (`deepseek_task.py --model pro`); las dos primeras en paralelo porque tocan archivos distintos.

## 1. HU-1 (#21) — Prompt de revisión de PRs

CONTEXTO DE NEGOCIO: En Fokkus IDE (extensión Theia, TypeScript/React 19), el botón "Pedir revisión a agentes" de la vista Source Control > Pull Requests envía al chat un prompt que sugiere a los agentes `git fetch https://github.com/owner/repo.git ...`. Git no tiene credenciales y abre KWallet/SSH askpass pidiendo usuario: el flujo automatizado se corta (Issue #21). El backend ya inyectará GITHUB_TOKEN en el entorno de los agentes (lo hace otro dev, NO lo toques).

TAREA ÚNICA: editar SOLO el archivo
/home/juancarlos/Proyectos/Personales/Fokkus-IDE/theia-extensions/fokkus-orchestrator/src/browser/github-pull-requests-widget.tsx
función exportada `buildPullRequestReviewPrompt(repo: string, pr: GitHubPullRequest, files: GitHubPullRequestFile[]): string` (línea ~107). Conserva la firma, las primeras líneas (título, autor, ramas, estado, URL, descripción, lista de archivos) y la parte final (formato de entrega 1-2-3, "NO apruebes ni rechaces el PR", "No modifiques archivos, no hagas commits ni publiques comentarios en GitHub"). Sustituye SOLO el bloque 'INSTRUCCIÓN: Obtén el diff completo del PR (por ejemplo git fetch https://github.com/...' por instrucciones nuevas en español que digan:

1. El entorno ya expone la variable $GITHUB_TOKEN con el token de la integración GitHub del IDE. Úsala siempre por referencia ("$GITHUB_TOKEN"): nunca imprimas, copies ni registres su valor.
2. Método preferido — diff por la API REST (sin git ni credenciales interactivas):
   `curl -sSfL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github.v3.diff" https://api.github.com/repos/${repo}/pulls/${pr.number}`
3. Si el diff es demasiado grande (la API responde 406/422), usar la lista de archivos con sus parches:
   `curl -sSfL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/${repo}/pulls/${pr.number}/files?per_page=100&page=1"` (paginando page=2,3…).
4. Solo si necesitas el código completo: git fetch con el token embebido en la URL de esa única orden, sin añadir remotes ni guardarla en la config:
   `git -c credential.helper= fetch "https://x-access-token:$GITHUB_TOKEN@github.com/${repo}.git" +refs/heads/${pr.baseRef}:refs/fokkus/pr-${pr.number}-base +refs/pull/${pr.number}/head:refs/fokkus/pr-${pr.number}` y luego `git diff refs/fokkus/pr-${pr.number}-base...refs/fokkus/pr-${pr.number}`.
5. Si $GITHUB_TOKEN está vacío, repite las mismas llamadas curl SIN la cabecera Authorization (solo sirve para repos públicos). Nunca uses comandos que pidan usuario/contraseña de forma interactiva; si una orden pide credenciales, abórtala y usa la API.

REGLAS ESTRICTAS:
- La función devuelve un string construido con concatenación de template literals (sigue el estilo existente: `'...' + \`...\``). Cuidado: dentro de template literals JS, `$GITHUB_TOKEN` NO es interpolación (solo `${...}` lo es), pero verifica que ninguna secuencia `${GITHUB_TOKEN}` quede interpolada por error: escribe siempre `$GITHUB_TOKEN` sin llaves. Los backticks de markdown dentro de template literals deben escaparse como \`.
- Usa las variables existentes `repo`, `pr.number`, `pr.baseRef`. No importes nada nuevo. No toques otras funciones ni otros archivos.
- Indentación 4 espacios, comillas simples, sin punto y coma faltantes (estilo del archivo).
- Tras editar, relee la función completa con leer_archivo_local y confirma que compila visualmente (paréntesis/comillas balanceados).
Entrega al final la función completa tal como quedó.

## 2. HU-2/3/4 (#20) — Protocolo y backend (+ entorno git de #21)

CONTEXTO DE NEGOCIO: Fokkus IDE (extensión Theia, TypeScript). El chat "Fokkus Team" despacha prompts a un agente líder (Product Owner) que es un proceso CLI one-shot (claude/agy/gemini) o una API OpenAI-compatible que solo devuelve texto. Issue #20: (a) el selector de modos (Manual / Automático / Plan de implementación) no hace nada: hay que convertir el modo en una INSTRUCCIÓN CRÍTICA del prompt; (b) se elimina el "Workspace Tree" (diff + Approve/Reject que hacían `git add . && git commit` / `git reset --hard && git clean -fd`); (c) la aprobación/rechazo pasa al chat mediante una "tool" que el agente invoca con un protocolo de texto. Issue #21: los agentes deben tener GITHUB_TOKEN en su entorno y git NUNCA debe abrir diálogos de credenciales (KWallet/askpass).

Directorio: /home/juancarlos/Proyectos/Personales/Fokkus-IDE/theia-extensions/fokkus-orchestrator
Archivos a editar (SOLO estos dos):
A) src/common/fokkus-orchestrator-protocol.ts
B) src/node/fokkus-orchestrator-server.ts
NO toques src/browser/* (otro dev lo hace en paralelo).

=== CAMBIOS EN A) protocol ===
1. Añadir y exportar:
```ts
/** Modo de ejecución del chat (Settings > Workspace). */
export type ExecutionMode = 'manual' | 'auto' | 'plan';
export const EXECUTION_MODE_IDS: readonly ExecutionMode[] = ['manual', 'auto', 'plan'];
export const DEFAULT_EXECUTION_MODE: ExecutionMode = 'manual';
/** Modo para dispatches internos (p. ej. compactar historial): sin directiva de modo ni tool de aprobación. */
export const RAW_DISPATCH_MODE = 'raw';
/** Lenguaje del bloque de código con el que un agente invoca la tool de aprobación. */
export const APPROVAL_REQUEST_FENCE = 'fokkus-approval';
export function isExecutionMode(value: unknown): value is ExecutionMode { ... }
```
2. En la interfaz FokkusOrchestratorServer ELIMINAR: executeTask, getWorkspaceDiff, approveDiff, rejectDiff. Cambiar el tipo del parámetro `mode` de dispatchToSwarm a `ExecutionMode | typeof RAW_DISPATCH_MODE` (añade un JSDoc breve). No cambies nada más de la interfaz.

=== CAMBIOS EN B) server ===
1. Eliminar los métodos executeTask, getWorkspaceDiff, approveDiff, rejectDiff (líneas ~94-113). No elimines runStreamingCommand (se usa en otros sitios).
2. Sustituir `private buildAgentPrompt(prompt, mode)` por dos métodos:
   - `private buildExecutionModeDirective(mode: string): string | undefined` → devuelve undefined si mode no es ExecutionMode (usa isExecutionMode; 'raw' o cualquier otro valor → undefined). Si lo es, devuelve una sección que empiece por `[MODO DE EJECUCIÓN: <Nombre> — INSTRUCCIÓN CRÍTICA]` con estos contenidos (en español, redactado claro, imperativo):
     * manual (Nombre "Manual"): Eres el agente líder. Debes solicitar la aprobación del usuario con la herramienta fokkus_request_approval ANTES de cada interacción del equipo con el código: primero para aprobar el plan de implementación (pídeselo al PM si existe en el equipo) y después ANTES de cada cambio crítico (escritura/edición/borrado de archivos, commits, instalación de dependencias, migraciones, comandos con efectos). Puedes leer e investigar sin pedir permiso. Una aprobación cubre SOLO la operación descrita en esa solicitud; el siguiente cambio crítico requiere una nueva. Si el usuario rechaza, no ejecutes la operación: explica alternativas y espera instrucciones.
     * auto (Nombre "Automático"): Pide al PM (rol de gestión/QA del equipo, si existe) que genere un plan de implementación basado en el estado actual del proyecto y en lo solicitado, y delega las tareas a cada área del equipo según la etapa correspondiente, sin detenerte a pedir aprobación. Usa fokkus_request_approval SOLO ante operaciones irreversibles o destructivas (borrado masivo, git push, reescritura de historial, cambios en producción, secretos).
     * plan (Nombre "Plan de implementación"): Pide al PM un plan de implementación y, antes de tocar cualquier archivo, sométalo al usuario con fokkus_request_approval (resume el plan en `summary`; el plan completo va en tu respuesta, antes del bloque). Si el historial contiene una respuesta de aprobación (marcador fokkus-approval-response con decision="approved") para el plan vigente, el equipo tiene pase libre: ejecuta todo el plan sin más interrupciones ni consultas. Si el usuario lo rechazó (decision="rejected"), corta el flujo: no modifiques nada, pregunta qué cambiar e itera el plan con el usuario.
   - `private buildApprovalToolSection(): string` → sección `[HERRAMIENTA DISPONIBLE: fokkus_request_approval]` que explique EXACTAMENTE el protocolo:
     * Para invocarla, termina tu respuesta con UN único bloque de código markdown cuyo lenguaje sea `fokkus-approval` (usa la constante APPROVAL_REQUEST_FENCE al construir el texto) que contenga SOLO un objeto JSON en una línea o varias:
       {"id": "<identificador corto único, p. ej. plan-1>", "title": "<qué se aprueba, máx. 80 caracteres>", "summary": "<qué harás y qué archivos o sistemas afecta>", "risk": "baja|media|alta"}
     * Incluye un ejemplo literal completo del bloque (con las tres comillas invertidas y el lenguaje fokkus-approval).
     * Tras el bloque, DETÉN tu ejecución en ese mismo turno: no ejecutes la operación ni escribas nada más. El chat mostrará al usuario los botones Aprobar/Rechazar.
     * La respuesta del usuario llegará en el siguiente mensaje con el marcador `<!-- fokkus-approval-response id="<id>" decision="approved|rejected" -->` y, si rechaza, un motivo opcional. Solo "approved" autoriza la operación.
     * Máximo una solicitud por respuesta. No inventes respuestas del usuario ni asumas aprobación.
   Ojo: el texto de estas secciones se construye con arrays de strings `.join('\n')` (estilo existente). Las tres comillas invertidas dentro de un string con comillas simples no necesitan escape: usa comillas simples para esas líneas, p. ej. '```' + APPROVAL_REQUEST_FENCE.
3. En buildDispatchPrompt: donde hoy hace `sections.push(this.buildAgentPrompt(prompt, mode));`, hacer:
   ```ts
   const modeDirective = this.buildExecutionModeDirective(mode);
   if (modeDirective) {
       sections.push(modeDirective);
       sections.push(this.buildApprovalToolSection());
   }
   sections.push(`[INSTRUCCIÓN DEL USUARIO]\n${prompt}`);
   ```
4. Entorno de los agentes (Issue #21). En doDispatchToSwarm, donde se crea `const teamEnvs: NodeJS.ProcessEnv = { ...process.env };`, añadir tras esa línea una llamada `await this.applyAgentGitEnvironment(teamEnvs);` e implementar:
   ```ts
   /** Expone el token de la integración GitHub a los agentes y evita que git abra diálogos de credenciales. */
   private async applyAgentGitEnvironment(env: NodeJS.ProcessEnv): Promise<void>
   ```
   - token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim(); si vacío, leer `join(os.homedir(), '.fokkus', 'github.json')` (JSON con campo opcional `token: string`), tolerando que no exista o sea JSON inválido (catch vacío con comentario). Si hay token: env.GITHUB_TOKEN = token; env.GH_TOKEN = token.
   - Siempre: env.GIT_TERMINAL_PROMPT = '0'; env.GIT_ASKPASS = ''; env.SSH_ASKPASS = ''; env.GCM_INTERACTIVE = 'never'.
   - NUNCA loguear el token (ni con console.log ni con onAgentLogEmitter).
   `os`, `join` y `fs` (promises) ya están importados en el archivo.
5. Importar desde '../common/fokkus-orchestrator-protocol' lo que uses (isExecutionMode, APPROVAL_REQUEST_FENCE, ExecutionMode, RAW_DISPATCH_MODE si aplica), añadiéndolo al import existente. Actualiza la firma de dispatchToSwarm/doDispatchToSwarm/buildDispatchPrompt para que `mode` acepte `ExecutionMode | typeof RAW_DISPATCH_MODE` (o déjalo como string si simplifica; debe compilar contra la interfaz).

REGLAS ESTRICTAS:
- TypeScript estricto (strict, noUnusedLocals). No dejes imports sin usar ni variables muertas.
- Estilo del repo: 4 espacios, comillas simples, `undefined` en lugar de `null`, llaves siempre en if, sin líneas en blanco dobles.
- No cambies lógica ajena a lo pedido. No renombres métodos existentes.
- Tras cada edición, relee con leer_archivo_local las líneas modificadas y verifica.
- Al final, busca en ambos archivos (buscar_en_archivos) 'executeTask|getWorkspaceDiff|approveDiff|rejectDiff|buildAgentPrompt' y confirma que ya no aparecen.
Entrega: lista de cambios aplicados con números de línea y el código de los métodos nuevos.

## 3. HU-2/3/4 (#20) — Frontend (Settings, chat, tool de aprobación) y CSS

CONTEXTO DE NEGOCIO: Fokkus IDE (extensión Theia, TypeScript estricto + React 19, react-markdown 9). Issue #20: la pestaña "Workspace" de Settings (Fokkus Team) tiene un selector de modos que no se persiste ni se usa (el chat siempre envía 'manual'), un visor de diff ("Workspace Tree") redundante con el SCM nativo y botones Approve/Reject peligrosos. El cliente quiere: (1) que el modo elegido (Manual / Automático / Plan de implementación) se persista y se envíe en cada dispatch; (2) eliminar por completo el Workspace Tree, Approve/Reject y "Ejecutar Prueba"; (3) que la aprobación/rechazo ocurra DENTRO del chat, solo cuando el agente lo pida mediante la tool `fokkus_request_approval`.

PROTOCOLO DE LA TOOL (ya implementado en backend, NO lo cambies): el agente termina su respuesta con un bloque markdown de lenguaje `fokkus-approval` que contiene JSON {"id","title","summary","risk"} (risk: baja|media|alta). La respuesta del usuario es un mensaje de usuario que empieza con el marcador `<!-- fokkus-approval-response id="<id>" decision="approved|rejected" -->`.

Ya existen en src/common/fokkus-orchestrator-protocol.ts (NO editar ese archivo): `ExecutionMode`, `EXECUTION_MODE_IDS`, `DEFAULT_EXECUTION_MODE`, `RAW_DISPATCH_MODE`, `APPROVAL_REQUEST_FENCE` ('fokkus-approval'), `isExecutionMode()`. La interfaz FokkusOrchestratorServer YA NO tiene executeTask/getWorkspaceDiff/approveDiff/rejectDiff, y dispatchToSwarm acepta `mode: ExecutionMode | typeof RAW_DISPATCH_MODE`. Lee ese archivo primero.

Directorio: /home/juancarlos/Proyectos/Personales/Fokkus-IDE/theia-extensions/fokkus-orchestrator
Archivos que puedes tocar: src/browser/fokkus-approval.ts (NUEVO), src/browser/fokkus-orchestrator-widget.tsx, src/browser/style/index.css. Nada más.

=== 1. NUEVO src/browser/fokkus-approval.ts (lógica pura, SIN React ni Theia; solo puede importar APPROVAL_REQUEST_FENCE del protocolo) ===
Cabecera de licencia igual a la de los demás archivos (copiarla de fokkus-orchestrator-protocol.ts). Exportar:
```ts
export type ApprovalRisk = 'baja' | 'media' | 'alta';
export type ApprovalDecision = 'approved' | 'rejected';
export interface ApprovalRequest { id: string; title: string; summary: string; risk?: ApprovalRisk; }
export function parseApprovalRequest(raw: string): ApprovalRequest
export function buildApprovalResponse(request: ApprovalRequest, decision: ApprovalDecision, reason?: string): string
export function parseApprovalResponses(content: string): Array<{ id: string; decision: ApprovalDecision }>
export function resolveApprovalDecision(contents: string[], requestIndex: number, requestId: string): ApprovalDecision | undefined
export function stripApprovalResponseMarkers(content: string): string
```
Reglas:
- parseApprovalRequest: JSON.parse tolerante (trim; si el texto contiene texto extra, intentar el substring entre el primer '{' y el último '}'). Campos string; `risk` solo si es baja|media|alta (acepta mayúsculas: normaliza a minúsculas). Si falta title → 'Solicitud de aprobación'. Si JSON inválido o no es objeto → summary = raw.trim(), title por defecto. `id`: si viene y cumple /^[A-Za-z0-9_.:-]{1,64}$/ se usa; si no, `req-` + hash determinista (djb2 en base36) del raw trimmed. Nunca lanza.
- buildApprovalResponse: devuelve
  aprobado: `<!-- fokkus-approval-response id="${id}" decision="approved" -->\n✅ **Aprobado:** ${title}\n\nContinúa con la operación aprobada.`
  rechazado: `<!-- fokkus-approval-response id="${id}" decision="rejected" -->\n❌ **Rechazado:** ${title}\n\n` + (motivo no vacío ? `**Motivo:** ${motivo}\n\n` : '') + `No ejecutes la operación: detente y propone alternativas.`
  El title se sanea para una sola línea (reemplazar saltos de línea por espacio) y el id se re-valida con la misma regex (si no cumple, usa el hash). En el motivo, reemplazar '-->' por '--&gt;' por seguridad.
- parseApprovalResponses: regex global `/<!--\s*fokkus-approval-response\s+id="([^"]*)"\s+decision="(approved|rejected)"\s*-->/g`.
- resolveApprovalDecision: busca en contents[j] para j > requestIndex, en orden, la PRIMERA respuesta con ese id; devuelve su decisión o undefined.
- stripApprovalResponseMarkers: elimina esos marcadores (y el salto de línea siguiente) para mostrar el mensaje limpio.
Usa `undefined`, nunca `null`.

=== 2. src/browser/fokkus-orchestrator-widget.tsx ===
2a. Imports: añade desde '../common/fokkus-orchestrator-protocol' (import existente) ExecutionMode, DEFAULT_EXECUTION_MODE, RAW_DISPATCH_MODE, APPROVAL_REQUEST_FENCE, isExecutionMode (solo los que uses). Importa de './fokkus-approval' lo necesario.
2b. Constante `const EXECUTION_MODE_PREFERENCE_KEY = 'fokkus-orchestrator.executionMode';` junto a las otras *_PREFERENCE_KEY (línea ~45) y helper `function readExecutionMode(preferenceService: PreferenceService): ExecutionMode { const value = preferenceService.get(EXECUTION_MODE_PREFERENCE_KEY); return isExecutionMode(value) ? value : DEFAULT_EXECUTION_MODE; }`.
2c. Sección "Workspace panel" (línea ~884 en adelante, hasta antes de "Settings widget"):
   - `ExecutionModeDefinition.id` pasa a ser `ExecutionMode`. Textos nuevos de EXECUTION_MODES (conserva icon/accent):
     manual → name 'Manual', description 'El agente líder pide tu aprobación en el chat antes de cada interacción con el código: desde el plan de implementación hasta cada cambio crítico.'
     auto → name 'Automático', description 'El líder pide al PM un plan según el estado del proyecto y delega cada etapa al área correspondiente, sin interrupciones.'
     plan → name 'Plan de implementación', description 'El PM genera un plan y lo apruebas en el chat. Si lo apruebas, el equipo trabaja sin interrupciones; si lo rechazas, se detiene para iterar contigo.'
   - ELIMINAR DiffLine, parseDiff, extractDiffFilenames y todo el estado/efectos/callbacks de diff, approve, reject, probe (runProbe) y su JSX (.fokkus-diff-viewer, .fokkus-decision-bar, .fokkus-execution-probe).
   - WorkspacePanel pasa a recibir `{ preferenceService: PreferenceService }`. Estado inicial `readExecutionMode(preferenceService)`; en un useEffect espera `preferenceService.ready` y rehidrata (con guarda `disposed`, patrón idéntico al de FokkusSettingsApp). Al hacer clic en una tarjeta: setActiveMode(id) y `preferenceService.set(EXECUTION_MODE_PREFERENCE_KEY, id, PreferenceScope.User).catch(error => console.error('[fokkus-orchestrator] No se pudo guardar el modo de ejecución', error));`. Añade `aria-pressed={isActive}` al botón.
   - Header: título 'Modo de Ejecución', subtítulo 'Elige cómo trabaja el equipo. Cuando un agente necesite tu aprobación, aparecerá en el chat con los botones Aprobar y Rechazar.'
   - Actualiza el comentario de la sección: 'Workspace panel — execution mode selector'.
   - En FokkusSettingsApp cambia el render a `<WorkspacePanel preferenceService={preferenceService} />`.
2d. FokkusChatApp:
   - `dispatchPrompt`: en vez de `'manual'` usa `readExecutionMode(preferenceService)` (después del `await preferenceService.ready` existente). `compactChatHistory`: usa `RAW_DISPATCH_MODE`.
   - Estado `executionMode` (init readExecutionMode) + useEffect que se suscribe a `preferenceService.onPreferenceChanged` y actualiza cuando `event.preferenceName === EXECUTION_MODE_PREFERENCE_KEY` (y también rehidrata tras preferenceService.ready). Dispose con la misma guarda `typeof disposable?.dispose === 'function'` usada en el archivo.
   - En la barra `.fokkus-chat-usage`, ANTES del botón Compactar, un botón `className='fokkus-chat-mode'` con `style={{ '--fokkus-accent': accent } as React.CSSProperties}`, icono del modo + `<span className='fokkus-chat-mode-label'>{name}</span>`, title `Modo de ejecución: ${name} (clic para cambiarlo)`, onClick={openSettings}. Busca la definición en EXECUTION_MODES. Como openSettings se declara más abajo, puedes declarar el botón en el JSX (el JSX está al final, no hay problema).
   - Tool de aprobación en el chat:
     * Crea un contexto `const ApprovalContext = React.createContext<ApprovalContextValue | undefined>(undefined);` con `interface ApprovalContextValue { resolveDecision(requestId: string): ApprovalDecision | undefined; actionable: boolean; decide(request: ApprovalRequest, decision: ApprovalDecision, reason?: string): void; }`.
     * Componente `function ApprovalRequestCard({ raw }: { raw: string }): React.ReactElement` (a nivel de módulo, antes de FokkusChatApp): parsea con useMemo(parseApprovalRequest), lee el contexto. Render:
       <div className='fokkus-approval-card' data-risk={risk ?? 'media'}> cabecera con icono 'fa fa-shield-alt', texto 'Aprobación requerida' y chip de riesgo `Riesgo ${risk}` si hay risk; <div className='fokkus-approval-title'>{title}</div>; <div className='fokkus-approval-summary'> con el summary renderizado como texto plano con `white-space: pre-wrap` (NO markdown, para evitar anidar ReactMarkdown).
       Estado: decision = context?.resolveDecision(id). Si decision === 'approved' → <div className='fokkus-approval-status fokkus-approval-status--approved'><i className='fa fa-check-circle' /> Aprobado</div>; 'rejected' → análogo con fa-times-circle y 'Rechazado'. Si no hay decisión y context?.actionable → acciones: botón 'Aprobar' (className 'fokkus-approval-button fokkus-approval-button--approve', icono fa-check) y 'Rechazar' ('fokkus-approval-button fokkus-approval-button--reject', icono fa-times). Rechazar abre un paso de confirmación inline: textarea className 'fokkus-approval-reason theia-input' placeholder 'Motivo del rechazo (opcional)' con onKeyDown que hace event.stopPropagation(), y botones 'Confirmar rechazo' y 'Cancelar'. Un estado local `sent` evita doble clic (deshabilita botones tras decidir). Si no hay decisión y no es actionable → <div className='fokkus-approval-status fokkus-approval-status--expired'><i className='fa fa-clock' /> Sin respuesta</div>. Sin contexto (no debería pasar) → trata como no accionable.
     * Integración con react-markdown: en CustomCodeComponent, si `match && match[1] === APPROVAL_REQUEST_FENCE` (ojo: la regex actual `/language-(\w+)/` NO captura guiones; cámbiala a `/language-([\w-]+)/`) y no es inline → `return <ApprovalRequestCard raw={String(children).replace(/\n$/, '')} />;`. IMPORTANTE reglas de hooks: CustomCodeComponent llama useMemo/useEffect incondicionalmente al principio; mantén ese orden (el return del card va después de los hooks existentes). Además, añade al objeto `components` un override de `pre` para que el card no quede dentro de <pre>: `const CustomPreComponent: Components['pre'] = ({ node, children, ...props }: any) => { const first = node?.children?.[0]; const classes = first?.properties?.className; const isApproval = Array.isArray(classes) && classes.includes(`language-${APPROVAL_REQUEST_FENCE}`); return isApproval ? <>{children}</> : <pre {...props}>{children}</pre>; };` y usar `components={{ code: CustomCodeComponent, pre: CustomPreComponent }}`.
     * En el render de mensajes (`messages.map(...)`), usa el índice: `messages.map((message, index) => ...)`. Envuelve el ReactMarkdown de cada mensaje en `<ApprovalContext.Provider value={...}>` con: resolveDecision = id => resolveApprovalDecision(contents, index, id) donde `contents` es un useMemo de `messages.map(m => m.content)`; actionable = `index === messages.length - 1 && message.role === 'assistant' && !dispatching`; decide = handleApprovalDecision. Para no crear objetos nuevos innecesarios está bien construir el value inline (son pocos mensajes).
     * Muestra el contenido con `stripApprovalResponseMarkers(message.content)` en el ReactMarkdown.
     * `handleApprovalDecision = React.useCallback((request, decision, reason?) => { dispatchPromptRef.current(buildApprovalResponse(request, decision, reason)).catch(error => console.error('[fokkus-orchestrator] No se pudo enviar la respuesta de aprobación', error)); }, [])`. OJO: dispatchPromptRef se declara más abajo que el render pero antes del return; declara handleApprovalDecision DESPUÉS de `dispatchPromptRef` para evitar uso antes de declaración (TS2448).
   - No cambies nada más del chat (historial, attachments, prompts externos).

=== 3. src/browser/style/index.css ===
- ELIMINA completamente las reglas de: `/* Execution probe (Motor de Ejecución) */` .fokkus-execution-probe, .fokkus-probe-button (+ :hover, :disabled), .fokkus-probe-result; `/* Diff viewer */` todas las .fokkus-diff-*; `/* Decision bar */` todas las .fokkus-decision-*; `/* Diff empty / loading states */` .fokkus-diff-empty, .fokkus-diff-empty--error y `.fokkus-decision-button:disabled`. Están entre las líneas ~629-677 y ~779-958. NO elimines las reglas .fokkus-mode-* ni `/* Prompt input bar */`.
- AÑADE al final del archivo estilos para: .fokkus-chat-mode (botón compacto tipo chip, borde 1px con color var(--fokkus-accent), fondo transparente, color var(--theia-foreground), border-radius 10px, padding 2px 8px, font-size 0.8em, gap 6px, display inline-flex, align-items center, cursor pointer; icono coloreado con var(--fokkus-accent); hover con fondo var(--theia-toolbar-hoverBackground)); .fokkus-chat-mode-label (white-space nowrap, overflow hidden, text-overflow ellipsis, max-width 140px); .fokkus-approval-card (margen 8px 0, padding 10px 12px, border 1px solid var(--theia-panel-border), border-left 3px solid (color por riesgo con [data-risk='baja'] #10c48c, [data-risk='media'] #f59e0b, [data-risk='alta'] #f87171), border-radius 6px, fondo var(--theia-editor-background), font-family var(--theia-ui-font-family)); .fokkus-approval-header (flex, gap 6px, font-weight 600, font-size 0.85em, uppercase, letter-spacing .04em); .fokkus-approval-risk (chip pequeño a la derecha, margin-left auto); .fokkus-approval-title (font-weight 600, margin 6px 0 4px); .fokkus-approval-summary (white-space pre-wrap, color var(--theia-descriptionForeground), font-size .9em); .fokkus-approval-actions (flex, gap 8px, margin-top 10px, flex-wrap wrap); .fokkus-approval-button (padding 4px 12px, border-radius 4px, border none, cursor pointer, color #fff) con --approve fondo #10a37f, --reject fondo #d9534f, :disabled opacity .55 cursor not-allowed; .fokkus-approval-button--secondary (fondo transparente, borde 1px var(--theia-button-secondaryBackground, #555), color var(--theia-foreground)); .fokkus-approval-reason (width 100%, min-height 48px, margin-top 8px, resize vertical, box-sizing border-box); .fokkus-approval-status (margin-top 10px, font-size .85em, display flex, gap 6px, align-items center) con --approved color #10c48c, --rejected color #f87171, --expired color var(--theia-descriptionForeground).
  Usa el botón 'Cancelar' con clases 'fokkus-approval-button fokkus-approval-button--secondary'.

REGLAS ESTRICTAS:
- TypeScript strict + noUnusedLocals: no dejes imports, tipos ni variables sin usar (p. ej. si FokkusOrchestratorServer deja de usarse en WorkspacePanel, quita solo lo que quede muerto; FokkusOrchestratorServer SIGUE usándose en otras partes del archivo).
- Estilo: 4 espacios, comillas simples en TS (JSX attrs con comillas simples como el resto del archivo), `undefined` no `null`, llaves en todos los if, sin dobles líneas en blanco, textos de UI en español.
- Tras cada edición relee las líneas modificadas con leer_archivo_local y verifica. Al final busca en el widget 'getWorkspaceDiff|approveDiff|rejectDiff|executeTask|fokkus-diff|fokkus-decision|fokkus-probe' y confirma 0 coincidencias; y en index.css 'fokkus-diff|fokkus-decision|fokkus-probe|fokkus-execution-probe' → 0.
Entrega: resumen de cambios con líneas y el contenido completo de fokkus-approval.ts.
