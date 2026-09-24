/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { spawn, ChildProcess, SpawnOptionsWithoutStdio } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import { dirname, join } from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
import URI from '@theia/core/lib/common/uri';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { inject, injectable } from '@theia/core/shared/inversify';
import { WorkspaceServer } from '@theia/workspace/lib/common';
import {
    ChatAttachment,
    ChatMessage,
    DesktopEnvironment,
    DynamicProvider,
    DynamicRole,
    FokkusOrchestratorServer,
    ProvidersState,
    RolesState,
    SwarmAgentResult,
    SwarmDispatchResult,
    SwarmEdge,
    TeamAssignments,
    TeamConfiguration
} from '../common/fokkus-orchestrator-protocol';

const TECHNICAL_MEMORY_TEMPLATE = `# Memoria Técnica del Proyecto (Fokkus Swarm)

> Archivo de memoria viva generado automáticamente. Consérvalo actualizado para
> que el enjambre no sufra "amnesia de contexto" ni alucinaciones destructivas.

## 1. Regla estricta de honestidad

- Está PROHIBIDO inventar cambios, resultados o estados del repositorio.
- Si no conoces un dato o no lo has verificado, decláralo explícitamente en lugar de suponerlo.
- Nunca reportes una acción como exitosa si no has verificado el resultado real en disco.

## 2. Regla de producción

- Está PROHIBIDO mutar variables de entorno, secretos, credenciales o configuraciones del sistema sin confirmación explícita del usuario.
- Está PROHIBIDO ejecutar \`git push\` (o cualquier operación remota destructiva) sin confirmación explícita del usuario.
- Antes de cualquier acción con efectos secundarios irreversibles, solicita aprobación.

## 3. Instrucción de actualización de avances

- Al finalizar una tarea, añade una entrada nueva en la sección "Bitácora de avances" con: fecha, resumen de lo realizado, archivos modificados y decisiones relevantes.
- Mantén este archivo sincronizado con el estado real del repositorio. Si el estado cambia, actualiza la memoria.

---

## Bitácora de avances

<!-- Añade aquí tus entradas con el formato:

### YYYY-MM-DD — Título breve
- Resumen de cambios y decisiones.
- Archivos afectados.

-->
`;

class AgentCancelledError extends Error {
    constructor() {
        super('Ejecución detenida por el usuario.');
        this.name = 'AgentCancelledError';
    }
}

@injectable()
export class FokkusOrchestratorServerImpl implements FokkusOrchestratorServer {

    @inject(WorkspaceServer)
    protected readonly workspaceServer: WorkspaceServer;

    protected readonly onDidDispatchSwarmEmitter = new Emitter<SwarmDispatchResult>();
    readonly onDidDispatchSwarm: Event<SwarmDispatchResult> = this.onDidDispatchSwarmEmitter.event;

    protected readonly onAgentLogEmitter = new Emitter<string>();
    readonly onAgentLog: Event<string> = this.onAgentLogEmitter.event;

    protected readonly activeAgentProcesses = new Set<ChildProcess>();
    protected readonly activeApiRequests = new Set<AbortController>();
    protected cancelRequested = false;
    protected dispatchesInFlight = 0;

    async executeTask(task: string): Promise<string> {
        // Fase 4 (infraestructura base): responde con un pong de verificación.
        // La ejecución real de agentes se implementará sobre esta interfaz.
        return `pong: ${task}`;
    }

    async getWorkspaceDiff(workspacePath: string): Promise<string> {
        const cwd = await this.getEffectiveCwd(workspacePath);
        return this.runStreamingCommand('git diff', cwd);
    }

    async approveDiff(workspacePath: string): Promise<void> {
        const cwd = await this.getEffectiveCwd(workspacePath);
        await this.runStreamingCommand('git add . && git commit -m "Aprobado vía Fokkus Swarm"', cwd);
    }

    async rejectDiff(workspacePath: string): Promise<void> {
        const cwd = await this.getEffectiveCwd(workspacePath);
        await this.runStreamingCommand('git reset --hard && git clean -fd', cwd);
    }

    async dispatchToSwarm(workspacePath: string, prompt: string, mode: string, team: TeamAssignments, providers: ProvidersState, attachments?: ChatAttachment[], roles?: RolesState, edges?: SwarmEdge[]): Promise<SwarmDispatchResult> {
        this.cancelRequested = false;
        this.dispatchesInFlight++;
        try {
            return await this.doDispatchToSwarm(workspacePath, prompt, mode, team, providers, attachments, roles, edges);
        } finally {
            this.dispatchesInFlight--;
            this.cancelRequested = false;
        }
    }

    private async doDispatchToSwarm(
        workspacePath: string,
        prompt: string,
        mode: string,
        team: TeamAssignments,
        providers: ProvidersState,
        attachments?: ChatAttachment[],
        roles?: RolesState,
        edges?: SwarmEdge[]
    ): Promise<SwarmDispatchResult> {
        const cwd = await this.getEffectiveCwd(workspacePath);
        await this.ensureProjectDocumentationFiles(cwd);
        
        const chatHistory = await this.loadChatHistory(cwd);
        
        // Las Reglas Base (systemPrompt) y la jerarquía pueden venir del frontend o,
        // si no, se recuperan del snapshot persistido globalmente en ~/.fokkus/team_config.json.
        const persisted = await this.loadTeamConfiguration();
        const effectiveRoles = roles ?? persisted?.roles;
        const effectiveEdges = edges ?? persisted?.edges;
        let safePrompt = await this.buildDispatchPrompt(prompt, mode, team, providers, chatHistory, cwd, effectiveRoles, effectiveEdges);

        const tempFiles: string[] = [];
        if (attachments && attachments.length > 0) {
            const attachDir = join(os.tmpdir(), 'fokkus-attachments');
            await fs.mkdir(attachDir, { recursive: true });
            safePrompt += '\n\n[Archivos adjuntos provistos por el usuario]';
            for (const att of attachments) {
                const filePath = join(attachDir, `${Date.now()}_${att.fileName}`);
                const buffer = Buffer.from(att.base64Data, 'base64');
                await fs.writeFile(filePath, buffer);
                tempFiles.push(filePath);
                safePrompt += `\n- ${filePath}`;
            }
        }

        const roleResults: SwarmAgentResult[] = [];

        const teamEnvs: NodeJS.ProcessEnv = { ...process.env };
        let poProvider: DynamicProvider | undefined;
        let poRoleId = '';

        for (const [roleId, providerId] of Object.entries(team)) {
            const provider = providers[providerId];
            if (!provider) {
                roleResults.push(this.skippedAgentResult(roleId, providerId, providerId, `No existe el proveedor asignado (${providerId})`));
                continue;
            }

            if (roleId === 'po' || roleId === 'product-owner') {
                poProvider = provider;
                poRoleId = roleId;
            } else {
                const prefix = `FOKKUS_TEAM_${roleId.toUpperCase().replace(/-/g, '_')}_`;
                if (provider.type === 'cli') {
                    teamEnvs[`${prefix}CMD`] = provider.config.cliCommand || '';
                } else if (provider.type === 'api') {
                    teamEnvs[`${prefix}ENDPOINT`] = provider.config.apiEndpoint || '';
                    teamEnvs[`${prefix}KEY`] = provider.config.apiKey || '';
                    teamEnvs[`${prefix}MODEL`] = provider.config.model || '';
                }
            }
        }

        try {
            if (!poProvider) {
                roleResults.push(this.skippedAgentResult('po', 'unknown', 'unknown', 'No se ha asignado un proveedor al rol de Product Owner (po).'));
            } else if (this.cancelRequested) {
                roleResults.push({
                    roleId: poRoleId,
                    providerId: poProvider.id,
                    providerName: poProvider.name,
                    status: 'cancelled',
                    output: '',
                    error: 'Ejecución detenida por el usuario.'
                });
            } else if (poProvider.type === 'api') {
                const endpoint = (poProvider.config.apiEndpoint || '').trim();
                const model = (poProvider.config.model || '').trim();
                if (!endpoint || !model) {
                    const missing = [!endpoint ? 'apiEndpoint' : '', !model ? 'model' : ''].filter(Boolean).join(' y ');
                    roleResults.push(this.skippedAgentResult(poRoleId, poProvider.id, poProvider.name,
                        `El Product Owner «${poProvider.name}» es de tipo API y le falta configurar ${missing}.`));
                } else {
                    roleResults.push(await this.runApiAgent(poRoleId, poProvider, safePrompt));
                }
            } else if (!poProvider.config.cliCommand || poProvider.config.cliCommand.trim().length === 0) {
                roleResults.push(this.skippedAgentResult(poRoleId, poProvider.id, poProvider.name,
                    `El Product Owner «${poProvider.name}» no tiene un comando CLI configurado.`));
            } else {
                const result = await this.runCliAgent(poRoleId, poProvider, poProvider.config.cliCommand.trim(), safePrompt, cwd, teamEnvs);
                roleResults.push(result);
            }
        } finally {
            for (const tf of tempFiles) {
                try { await fs.unlink(tf); } catch(e) {}
            }
        }

        const result: SwarmDispatchResult = { workspacePath: cwd, roleResults };
        this.onDidDispatchSwarmEmitter.fire(result);
        return result;
    }

    async addProvider(provider: DynamicProvider): Promise<void> {
        const settings = await this.readWorkspaceSettings();
        const orchestrator = this.ensureOrchestratorSection(settings);
        const providers = this.ensureRecord(orchestrator['providers']);
        providers[provider.id] = provider;
        orchestrator['providers'] = providers;
        await this.writeWorkspaceSettings(settings);
    }

    async assignRole(roleId: string, providerId: string): Promise<void> {
        const settings = await this.readWorkspaceSettings();
        const orchestrator = this.ensureOrchestratorSection(settings);
        const team = this.ensureRecord(orchestrator['team']);
        team[roleId] = providerId;
        orchestrator['team'] = team;
        await this.writeWorkspaceSettings(settings);
    }

    async saveTeamConfiguration(config: TeamConfiguration): Promise<void> {
        const teamConfigPath = await this.resolveTeamConfigPath();
        await fs.mkdir(dirname(teamConfigPath), { recursive: true });
        await fs.writeFile(teamConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    }

    /**
     * Garantiza la existencia de los archivos de documentación (Backlog, Plan, Memoria)
     * y el .gitignore para el workspace actual.
     */
    private async ensureProjectDocumentationFiles(cwd: string): Promise<void> {
        
        // 1. Memoria técnica en .fokkus/
        const memoryPath = join(cwd, '.fokkus', 'technical_memory.md');
        try {
            await fs.access(memoryPath);
        } catch {
            await fs.mkdir(dirname(memoryPath), { recursive: true });
            await fs.writeFile(memoryPath, TECHNICAL_MEMORY_TEMPLATE, 'utf8');
        }

        // 2. Backlog e Implementation Plan en la raíz
        const backlogPath = join(cwd, 'backlog.md');
        try {
            await fs.access(backlogPath);
        } catch {
            await fs.writeFile(backlogPath, '# Product Backlog\n\nAquí puedes documentar las historias de usuario de tu proyecto.\n', 'utf8');
        }

        const planPath = join(cwd, 'implementation_plan.md');
        try {
            await fs.access(planPath);
        } catch {
            await fs.writeFile(planPath, '# Plan de Implementación\n\nEste archivo será utilizado por los agentes para proponer planes antes de ejecutarlos.\n', 'utf8');
        }

        // 3. Ignorar la carpeta .fokkus/ en .gitignore
        const gitignorePath = join(cwd, '.gitignore');
        const ignoreEntry = '.fokkus/\n';
        try {
            const content = await fs.readFile(gitignorePath, 'utf8');
            if (!content.includes('.fokkus/')) {
                await fs.appendFile(gitignorePath, `\n# Fokkus IDE\n${ignoreEntry}`);
            }
        } catch {
            await fs.writeFile(gitignorePath, `# Fokkus IDE\n${ignoreEntry}`, 'utf8');
        }
    }

    private ensureOrchestratorSection(settings: Record<string, unknown>): Record<string, unknown> {
        const existing = settings['fokkusOrchestrator'];
        if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
            return existing as Record<string, unknown>;
        }
        const section: Record<string, unknown> = {};
        settings['fokkusOrchestrator'] = section;
        return section;
    }

    private ensureRecord(value: unknown): Record<string, unknown> {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return value as Record<string, unknown>;
        }
        return {};
    }

    private buildAgentPrompt(prompt: string, mode: string): string {
        if (mode === 'plan') {
            return [
                'Modo planificación: NO modifiques ningún archivo del workspace.',
                'Produce únicamente un plan detallado en Markdown con los pasos, archivos afectados y decisiones de diseño.',
                '',
                `Instrucción: ${prompt}`
            ].join('\n');
        }
        return prompt;
    }

    /**
     * Ensambla el prompt final que recibe el agente orquestador (Product Owner).
     * Incluye: sus Reglas Base (systemPrompt), la instrucción del usuario, el
     * contexto transparente del equipo (quién ocupa cada rol y sus reglas) y la
     * jerarquía definida en el Swarm Builder.
     */
    private async buildDispatchPrompt(
        prompt: string,
        mode: string,
        team: TeamAssignments,
        providers: ProvidersState,
        chatHistory: ChatMessage[],
        cwd: string,
        roles?: RolesState,
        edges?: SwarmEdge[]
    ): Promise<string> {
        const sections: string[] = [];

        const primaryRole = this.findPrimaryRole(team, roles);
        if (primaryRole?.systemPrompt && primaryRole.systemPrompt.trim().length > 0) {
            sections.push(`[REGLAS BASE — ${primaryRole.name}]\n${primaryRole.systemPrompt.trim()}`);
        }

        const teamContext = this.buildTeamContext(team, providers, roles);
        if (teamContext.length > 0) {
            sections.push(`[CONTEXTO DEL EQUIPO (Fokkus Swarm)]\n${teamContext.join('\n')}`);
        }

        if (edges && edges.length > 0) {
            const hierarchy = edges.map(edge => `${edge.source} → ${edge.target}`).join('\n');
            sections.push(`[JERARQUÍA DEL EQUIPO]\n${hierarchy}`);
        }

        if (chatHistory && chatHistory.length > 0) {
            const historyText = chatHistory.map(msg => `[${msg.role.toUpperCase()}]: ${msg.content}`).join('\n\n');
            sections.push(`[HISTORIAL DE CONVERSACIÓN RECIENTE]\n${historyText}`);
        }

        // Contexto jerárquico del proyecto: si el backlog está vacío (solo template),
        // se expone la lista de archivos raíz para que el agente investigue el código.
        const backlogPath = join(cwd, 'backlog.md');
        let backlogContent = '';
        try {
            backlogContent = await fs.readFile(backlogPath, 'utf8');
        } catch {
            backlogContent = '';
        }

        const backlogIsTemplate = !backlogContent ||
            backlogContent.trim() === '' ||
            backlogContent.trim() === '# Product Backlog' ||
            backlogContent.trim() === '# Product Backlog\n\nAquí puedes documentar las historias de usuario de tu proyecto.';

        if (backlogContent.trim().length > 0 && !backlogIsTemplate) {
            sections.push(`[BACKLOG DEL PROYECTO]\n${backlogContent.trim()}`);
        } else {
            let rootFiles: string[] = [];
            try {
                const entries = await fs.readdir(cwd);
                rootFiles = entries.filter(name => !name.startsWith('.'));
            } catch {
                rootFiles = [];
            }
            sections.push(
                `[ARCHIVOS EN LA RAÍZ DEL WORKSPACE]\n` +
                (rootFiles.length > 0 ? rootFiles.join('\n') : '(no se pudieron listar los archivos de la raíz)')
            );
        }

        sections.push(
            `[PROTOCOLO DE CONTEXTO JERÁRQUICO]\n` +
            `Directorio del proyecto abierto en el editor: ${cwd}\n` +
            `Si el historial afirma que no hay proyecto o que el workspace está vacío, verifícalo contra el disco antes de repetirlo: el listado de archivos de este prompt es la fuente de verdad.\n` +
            `Para resolver la tarea, consulta las fuentes de contexto en este orden estricto:\n` +
            `1° Historial del Chat (si existe en este prompt).\n` +
            `2° Backlog del proyecto (o, si está vacío, la lista de archivos de la raíz del workspace).\n` +
            `3° El Proyecto en sí: lee e investiga el código fuente real del workspace. Si es necesario, delega en los agentes del equipo (sub-agentes) para tareas específicas.`
        );

        sections.push(this.buildAgentPrompt(prompt, mode));

        sections.push(
            `[DIRECTIVA CRÍTICA DE AISLAMIENTO]\n` +
            `Eres estrictamente el Agente Asignado para este proyecto. Tu objetivo es ayudar a desarrollar el código del proyecto activo.\n` +
            `BAJO NINGUNA CIRCUNSTANCIA debes hablar sobre tu propia arquitectura de agentes, configuración interna de Fokkus IDE, variables de entorno FOKKUS_TEAM_ o diagnosticar el Swarm, a menos que el usuario te lo pida EXPLÍCITAMENTE. Mantén siempre el rol y la inmersión en el proyecto.`
        );

        return sections.join('\n\n');
    }

    private buildTeamContext(team: TeamAssignments, providers: ProvidersState, roles?: RolesState): string[] {
        const lines: string[] = [];
        for (const [roleId, providerId] of Object.entries(team)) {
            const provider = providers[providerId];
            if (!provider) {
                continue;
            }
            const role = roles?.[roleId];
            const roleLabel = role ? `${role.name} (${roleId})` : roleId;
            let line = `- Rol: ${roleLabel} | Agente Asignado: ${provider.name}`;
            if (role?.systemPrompt && role.systemPrompt.trim().length > 0) {
                line += `\n  Reglas Base: ${role.systemPrompt.trim()}`;
            }
            lines.push(line);
        }
        return lines;
    }

    private findPrimaryRole(team: TeamAssignments, roles?: RolesState): DynamicRole | undefined {
        const primaryId = Object.keys(team).find(roleId => roleId === 'po' || roleId === 'product-owner');
        if (!primaryId) {
            return undefined;
        }
        return roles?.[primaryId];
    }



    private skippedAgentResult(roleId: string, providerId: string, providerName: string, reason: string): SwarmAgentResult {
        return { roleId, providerId, providerName, status: 'skipped', output: '', error: reason };
    }

    /**
     * Devuelve `{ distro, linuxPath }` cuando `cwd` apunta a un filesystem de WSL
     * accedido desde Windows (\\wsl.localhost\<distro>\... o file://wsl.localhost/<distro>/...).
     */
    private parseWslPath(cwd: string): { distro: string; linuxPath: string } | undefined {
        if (!cwd) {
            return undefined;
        }
        const uriMatch = cwd.match(/^file:\/\/wsl\.localhost\/([^/]+)(\/.*)?$/i);
        if (uriMatch) {
            return {
                distro: decodeURIComponent(uriMatch[1]),
                linuxPath: uriMatch[2] ? decodeURIComponent(uriMatch[2]) : '/'
            };
        }
        const uncMatch = cwd.match(/^\\\\(wsl\.localhost|wsl\$)\\([^\\]+)(\\.*)?$/i);
        if (uncMatch) {
            return {
                distro: uncMatch[2],
                linuxPath: uncMatch[3] ? uncMatch[3].replace(/\\/g, '/') : '/'
            };
        }
        return undefined;
    }

    /**
     * Añade los flags estándar de `agy` (permisos y --add-dir) a un comando CLI.
     * `targetDir` debe ser el directorio efectivo de trabajo: la ruta Linux cuando
     * el workspace está en WSL, o `cwd` en el resto de casos.
     */
    private prepareCliCommand(cliCommand: string, targetDir: string): string {
        let command = cliCommand;
        if (command.includes('agy')) {
            if (!command.includes('--dangerously-skip-permissions')) {
                command = command.replace('agy', 'agy --dangerously-skip-permissions');
            }
            if (!command.includes('--add-dir')) {
                command = command.replace('agy', `agy --add-dir "${targetDir}"`);
            }
        }
        return command;
    }

    /**
     * Sustituye el marcador `{prompt}` por `"$FOKKUS_SAFE_PROMPT"` (expansión POSIX).
     * Si no hay marcador, el prompt se añade como último argumento.
     */
    private injectPromptShell(command: string): string {
        if (command.includes('"{prompt}"')) {
            return command.replace('"{prompt}"', '"$FOKKUS_SAFE_PROMPT"');
        }
        if (command.includes("'{prompt}'")) {
            return command.replace("'{prompt}'", '"$FOKKUS_SAFE_PROMPT"');
        }
        if (command.includes('{prompt}')) {
            return command.replace('{prompt}', '"$FOKKUS_SAFE_PROMPT"');
        }
        return `${command} "$FOKKUS_SAFE_PROMPT"`;
    }

    private async runCliAgentInWsl(
        roleId: string,
        provider: DynamicProvider,
        command: string,
        distro: string,
        linuxPath: string,
        runEnv: NodeJS.ProcessEnv
    ): Promise<SwarmAgentResult> {
        const wslEnv = { ...runEnv };
        wslEnv.WSLENV = wslEnv.WSLENV
            ? (wslEnv.WSLENV.includes('FOKKUS_SAFE_PROMPT') ? wslEnv.WSLENV : `${wslEnv.WSLENV}:FOKKUS_SAFE_PROMPT/u`)
            : 'FOKKUS_SAFE_PROMPT/u';
        const output = await this.runStreamingProcess(
            'wsl.exe',
            ['-d', distro, '--cd', linuxPath, '--', 'bash', '-lc', command],
            os.homedir(),
            wslEnv,
            false,
            true
        );
        return { roleId, providerId: provider.id, providerName: provider.name, status: 'completed', output };
    }

    private async runCliAgent(roleId: string, provider: DynamicProvider, cliCommand: string, safePrompt: string, cwd: string, env: NodeJS.ProcessEnv): Promise<SwarmAgentResult> {
        try {
            const runEnv = { ...env, FOKKUS_SAFE_PROMPT: safePrompt };

            // Escenario WSL sin Remote-WSL: el backend corre en Windows pero el
            // workspace vive dentro de la distro. El agente debe ejecutarse en Linux
            // y --add-dir debe recibir la ruta POSIX, no la UNC de Windows.
            if (process.platform === 'win32') {
                const wsl = this.parseWslPath(cwd);
                if (wsl) {
                    const wslCommand = this.injectPromptShell(this.prepareCliCommand(cliCommand, wsl.linuxPath));
                    return await this.runCliAgentInWsl(roleId, provider, wslCommand, wsl.distro, wsl.linuxPath, runEnv);
                }
            }

            const finalCommand = this.prepareCliCommand(cliCommand, cwd);

            if (process.platform === 'win32') {
                // cmd.exe no expande "$VAR" y reinterpreta &, |, <, > y saltos de línea del prompt
                // (además de limitar la línea a ~8 KB). En Windows se ejecuta el binario sin shell
                // y el prompt viaja como un argumento más, escapado por Node.
                const [file, ...args] = this.buildWindowsArgv(finalCommand, safePrompt);
                if (/\.(cmd|bat)$/i.test(file)) {
                    return {
                        roleId,
                        providerId: provider.id,
                        providerName: provider.name,
                        status: 'failed',
                        output: '',
                        error: `El comando «${file}» es un script .cmd/.bat. Los agentes en Windows se ejecutan sin cmd.exe: `
                            + 'usa la ruta al .exe o invócalo con su intérprete (node, python).'
                    };
                }
                const output = await this.runStreamingProcess(file, args, cwd, runEnv, false, true);
                return { roleId, providerId: provider.id, providerName: provider.name, status: 'completed', output };
            }

            const command = this.injectPromptShell(finalCommand);
            const output = await this.runStreamingCommand(command, cwd, runEnv, true);
            return { roleId, providerId: provider.id, providerName: provider.name, status: 'completed', output };
        } catch (error) {
            if (error instanceof AgentCancelledError) {
                return {
                    roleId,
                    providerId: provider.id,
                    providerName: provider.name,
                    status: 'cancelled',
                    output: '',
                    error: error.message
                };
            }
            return {
                roleId,
                providerId: provider.id,
                providerName: provider.name,
                status: 'failed',
                output: '',
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Ejecuta al Product Owner vía una API compatible con OpenAI Chat Completions.
     * A diferencia de un PO CLI, solo responde texto (planifica y delega); no
     * ejecuta comandos ni edita archivos por sí mismo.
     */
    private async runApiAgent(roleId: string, provider: DynamicProvider, prompt: string): Promise<SwarmAgentResult> {
        const endpoint = (provider.config.apiEndpoint || '').trim().replace(/\/+$/, '');
        const model = (provider.config.model || '').trim();
        const apiKey = (provider.config.apiKey || '').trim();
        const controller = new AbortController();
        this.activeApiRequests.add(controller);
        try {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }
            const response = await fetch(`${endpoint}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model,
                    messages: [{ role: 'user', content: prompt }],
                    stream: false
                }),
                signal: controller.signal
            });

            if (!response.ok) {
                const bodyText = await response.text();
                let apiMessage = bodyText.trim();
                try {
                    const parsed: unknown = JSON.parse(bodyText);
                    if (parsed && typeof parsed === 'object') {
                        const error = (parsed as { error?: unknown }).error;
                        if (error && typeof error === 'object') {
                            const message = (error as { message?: unknown }).message;
                            if (typeof message === 'string' && message.trim()) {
                                apiMessage = message.trim();
                            }
                        }
                    }
                } catch {
                    // El cuerpo no es JSON; se usa el texto tal cual.
                }
                const truncated = apiMessage.length > 500 ? `${apiMessage.slice(0, 500)}…` : apiMessage;
                return {
                    roleId,
                    providerId: provider.id,
                    providerName: provider.name,
                    status: 'failed',
                    output: '',
                    error: `La API respondió HTTP ${response.status}: ${truncated || 'sin detalle'}`
                };
            }

            const data: unknown = await response.json();
            let content: unknown;
            if (data && typeof data === 'object') {
                const choices = (data as { choices?: unknown }).choices;
                if (Array.isArray(choices) && choices.length > 0) {
                    const first = choices[0];
                    if (first && typeof first === 'object') {
                        const message = (first as { message?: unknown }).message;
                        if (message && typeof message === 'object') {
                            content = (message as { content?: unknown }).content;
                        }
                    }
                }
            }

            if (typeof content !== 'string' || content.trim().length === 0) {
                return {
                    roleId,
                    providerId: provider.id,
                    providerName: provider.name,
                    status: 'failed',
                    output: '',
                    error: 'La API no devolvió contenido.'
                };
            }
            return {
                roleId,
                providerId: provider.id,
                providerName: provider.name,
                status: 'completed',
                output: content.trim()
            };
        } catch (error) {
            if (controller.signal.aborted || this.cancelRequested) {
                return {
                    roleId,
                    providerId: provider.id,
                    providerName: provider.name,
                    status: 'cancelled',
                    output: '',
                    error: 'Ejecución detenida por el usuario.'
                };
            }
            return {
                roleId,
                providerId: provider.id,
                providerName: provider.name,
                status: 'failed',
                output: '',
                error: error instanceof Error ? error.message : String(error)
            };
        } finally {
            this.activeApiRequests.delete(controller);
        }
    }

    async getDesktopEnvironment(): Promise<DesktopEnvironment> {
        return {
            platform: process.platform,
            desktop: process.env.XDG_CURRENT_DESKTOP || ''
        };
    }

    private async resolveWorkspaceRoot(): Promise<string> {
        const workspaceUri = await this.workspaceServer.getMostRecentlyUsedWorkspace();
        if (!workspaceUri) {
            throw new Error('No hay un workspace abierto en Fokkus IDE');
        }
        return FileUri.fsPath(workspaceUri);
    }

    /**
     * Normaliza la ruta del workspace enviada por el frontend a un path de
     * sistema de archivos válido. Si llega una URI `file://` la convierte con
     * FileUri; si llega vacía, resuelve el workspace abierto actualmente.
     */
    private async getEffectiveCwd(workspacePath: string): Promise<string> {
        if (!workspacePath || workspacePath.trim().length === 0) {
            return this.resolveWorkspaceRoot();
        }
        if (workspacePath.startsWith('file://')) {
            return FileUri.fsPath(new URI(workspacePath));
        }
        return workspacePath;
    }

    private async resolveWorkspaceSettingsPath(): Promise<string> {
        const root = await this.resolveWorkspaceRoot();
        return join(root, '.theia', 'settings.json');
    }

    private async resolveTeamConfigPath(): Promise<string> {
        return join(os.homedir(), '.fokkus', 'team_config.json');
    }

    private async resolveChatHistoryPath(workspacePath: string): Promise<string> {
        const cwd = await this.getEffectiveCwd(workspacePath);
        return join(cwd, '.fokkus', 'chat_history.json');
    }

    async saveChatHistory(workspacePath: string, history: ChatMessage[]): Promise<void> {
        const historyPath = await this.resolveChatHistoryPath(workspacePath);
        await fs.mkdir(dirname(historyPath), { recursive: true });
        await fs.writeFile(historyPath, JSON.stringify(history, null, 2), 'utf8');
    }

    async loadChatHistory(workspacePath: string): Promise<ChatMessage[]> {
        const historyPath = await this.resolveChatHistoryPath(workspacePath);
        try {
            const content = await fs.readFile(historyPath, 'utf8');
            return JSON.parse(content) as ChatMessage[];
        } catch {
            return [];
        }
    }

    async clearChatHistory(workspacePath: string): Promise<void> {
        const historyPath = await this.resolveChatHistoryPath(workspacePath);
        try {
            await fs.unlink(historyPath);
        } catch {
            // Ignore if file doesn't exist
        }
    }

    async compactChatHistory(workspacePath: string, summary?: string): Promise<ChatMessage[]> {
        const history = await this.loadChatHistory(workspacePath);
        if (summary) {
            const compacted: ChatMessage[] = [
                { role: 'system', content: 'Historial compactado.', timestamp: Date.now() },
                { role: 'assistant', content: summary, timestamp: Date.now() }
            ];
            await this.saveChatHistory(workspacePath, compacted);
            return compacted;
        }
        if (history.length <= 10) return history;
        const compacted = history.slice(-10);
        await this.saveChatHistory(workspacePath, compacted);
        return compacted;
    }



    private async loadTeamConfiguration(): Promise<TeamConfiguration | undefined> {
        const teamConfigPath = await this.resolveTeamConfigPath();
        try {
            const raw = await fs.readFile(teamConfigPath, 'utf8');
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return undefined;
            }
            return parsed as TeamConfiguration;
        } catch (error) {
            // Todavía no existe un snapshot de equipo para este proyecto.
            return undefined;
        }
    }

    private async readWorkspaceSettings(): Promise<Record<string, unknown>> {
        const settingsPath = await this.resolveWorkspaceSettingsPath();
        try {
            const raw = await fs.readFile(settingsPath, 'utf8');
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (error) {
            // El archivo no existe todavía o no contiene JSON válido: se parte de vacío.
            return {};
        }
    }

    private async writeWorkspaceSettings(settings: Record<string, unknown>): Promise<void> {
        const settingsPath = await this.resolveWorkspaceSettingsPath();
        await fs.mkdir(dirname(settingsPath), { recursive: true });
        await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    }

    /**
     * Separa un comando CLI en argumentos respetando comillas simples y dobles
     * (sin escapes con barra invertida, para no romper rutas de Windows), expande
     * `~` al home del usuario y sustituye `{prompt}`; si no hay marcador, el prompt
     * se añade como último argumento.
     */
    private buildWindowsArgv(command: string, prompt: string): string[] {
        const tokens: string[] = [];
        let current = '';
        let quote: string | undefined;
        let inToken = false;
        for (const ch of command) {
            if (quote) {
                if (ch === quote) {
                    quote = undefined;
                } else {
                    current += ch;
                }
            } else if (ch === '"' || ch === "'") {
                quote = ch;
                inToken = true;
            } else if (/\s/.test(ch)) {
                if (inToken) {
                    tokens.push(current);
                    current = '';
                    inToken = false;
                }
            } else {
                current += ch;
                inToken = true;
            }
        }
        if (inToken) {
            tokens.push(current);
        }

        let hasPlaceholder = false;
        const args = tokens.map(token => {
            if (token === '~' || token.startsWith('~/') || token.startsWith('~\\')) {
                token = join(os.homedir(), token.slice(1));
            }
            if (token.includes('{prompt}')) {
                hasPlaceholder = true;
                token = token.split('{prompt}').join(prompt);
            }
            return token;
        });
        if (!hasPlaceholder) {
            args.push(prompt);
        }
        return args;
    }

    async cancelDispatch(): Promise<void> {
        // Also honoured while the prompt is still being prepared (no process spawned yet).
        if (this.dispatchesInFlight === 0) {
            return;
        }
        this.cancelRequested = true;
        for (const child of this.activeAgentProcesses) {
            this.killProcessTree(child);
        }
        for (const controller of this.activeApiRequests) {
            controller.abort();
        }
    }

    private killProcessTree(child: ChildProcess): void {
        const pid = child.pid;
        if (!pid) {
            return;
        }
        if (process.platform === 'win32') {
            const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
            killer.on('error', () => { /* ignore */ });
            return;
        }
        try {
            process.kill(-pid, 'SIGTERM');
        } catch {
            try {
                child.kill('SIGTERM');
            } catch {
                // El proceso ya terminó.
            }
        }
        const timer = setTimeout(() => {
            if (this.activeAgentProcesses.has(child)) {
                try {
                    process.kill(-pid, 'SIGKILL');
                } catch {
                    try {
                        child.kill('SIGKILL');
                    } catch {
                        // El proceso ya terminó.
                    }
                }
            }
        }, 3000);
        timer.unref();
    }

    private runStreamingCommand(command: string, cwd: string, env?: NodeJS.ProcessEnv, trackAsAgent = false): Promise<string> {
        return this.runStreamingProcess(command, [], cwd, env, true, trackAsAgent);
    }

    private runStreamingProcess(file: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, shell = false, trackAsAgent = false): Promise<string> {
        return new Promise((resolve, reject) => {
            const options: SpawnOptionsWithoutStdio = { cwd, shell };
            if (env) {
                options.env = env;
            }
            if (trackAsAgent && process.platform !== 'win32') {
                options.detached = true;
            }
            const child = spawn(file, args, options);
            if (trackAsAgent) {
                this.activeAgentProcesses.add(child);
            }

            let stdoutData = '';
            let stderrData = '';

            child.stdout.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stdoutData += chunk;
                this.onAgentLogEmitter.fire(chunk);
            });

            child.stderr.on('data', (data: Buffer) => {
                const chunk = data.toString();
                stderrData += chunk;
                this.onAgentLogEmitter.fire(chunk);
            });

            child.on('error', (error: NodeJS.ErrnoException) => {
                this.activeAgentProcesses.delete(child);
                if (!shell && error.code === 'ENOENT') {
                    reject(new Error(`No se encontró el ejecutable «${file}». En Windows los agentes se ejecutan sin cmd.exe: ` +
                        'si el comando es un script .cmd/.bat (por ejemplo, instalado con npm), usa la ruta al .exe o invócalo con su intérprete (node, python).'));
                    return;
                }
                reject(error);
            });

            child.on('close', (code: number) => {
                this.activeAgentProcesses.delete(child);
                const outStr = stdoutData.trim();
                const errStr = stderrData.trim();

                if (trackAsAgent && this.cancelRequested) {
                    reject(new AgentCancelledError());
                    return;
                }

                if (code !== 0) {
                    reject(new Error(errStr || outStr || `Process exited with code ${code}`));
                    return;
                }

                const combined = [outStr, errStr].filter(s => s.length > 0).join('\n\n--- Logs/Errores ---\n');
                resolve(combined || '(El agente no devolvió ninguna salida de texto)');
            });
        });
    }
}
