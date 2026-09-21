/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import { dirname, join } from 'path';
import { FileUri } from '@theia/core/lib/common/file-uri';
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

@injectable()
export class FokkusOrchestratorServerImpl implements FokkusOrchestratorServer {

    @inject(WorkspaceServer)
    protected readonly workspaceServer: WorkspaceServer;

    protected readonly onDidDispatchSwarmEmitter = new Emitter<SwarmDispatchResult>();
    readonly onDidDispatchSwarm: Event<SwarmDispatchResult> = this.onDidDispatchSwarmEmitter.event;

    protected readonly onAgentLogEmitter = new Emitter<string>();
    readonly onAgentLog: Event<string> = this.onAgentLogEmitter.event;

    async executeTask(task: string): Promise<string> {
        // Fase 4 (infraestructura base): responde con un pong de verificación.
        // La ejecución real de agentes se implementará sobre esta interfaz.
        return `pong: ${task}`;
    }

    async getWorkspaceDiff(): Promise<string> {
        const cwd = await this.resolveWorkspaceRoot();
        return this.runStreamingCommand('git diff', cwd);
    }

    async approveDiff(): Promise<void> {
        const cwd = await this.resolveWorkspaceRoot();
        await this.runStreamingCommand('git add . && git commit -m "Aprobado vía Fokkus Swarm"', cwd);
    }

    async rejectDiff(): Promise<void> {
        const cwd = await this.resolveWorkspaceRoot();
        await this.runStreamingCommand('git reset --hard && git clean -fd', cwd);
    }

    async dispatchToSwarm(workspacePath: string, prompt: string, mode: string, team: TeamAssignments, providers: ProvidersState, attachments?: ChatAttachment[], roles?: RolesState, edges?: SwarmEdge[]): Promise<SwarmDispatchResult> {
        const cwd = workspacePath || await this.resolveWorkspaceRoot();
        await this.ensureProjectDocumentationFiles(cwd);
        
        const chatHistory = await this.loadChatHistory(cwd);
        
        // Las Reglas Base (systemPrompt) y la jerarquía pueden venir del frontend o,
        // si no, se recuperan del snapshot persistido globalmente en ~/.fokkus/team_config.json.
        const persisted = await this.loadTeamConfiguration();
        const effectiveRoles = roles ?? persisted?.roles;
        const effectiveEdges = edges ?? persisted?.edges;
        let safePrompt = this.buildDispatchPrompt(prompt, mode, team, providers, chatHistory, effectiveRoles, effectiveEdges);

        const tempFiles: string[] = [];
        if (attachments && attachments.length > 0) {
            const attachDir = '/tmp/fokkus-attachments';
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
            } else if (poProvider.type !== 'cli' || !poProvider.config.cliCommand || poProvider.config.cliCommand.trim().length === 0) {
                const reason = poProvider.type === 'api'
                    ? `El Product Owner «${poProvider.name}» es de tipo API; el orquestador principal debe ser de tipo CLI en esta arquitectura.`
                    : `El Product Owner «${poProvider.name}» no tiene un comando CLI configurado.`;
                roleResults.push(this.skippedAgentResult(poRoleId, poProvider.id, poProvider.name, reason));
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
    private buildDispatchPrompt(
        prompt: string,
        mode: string,
        team: TeamAssignments,
        providers: ProvidersState,
        chatHistory: ChatMessage[],
        roles?: RolesState,
        edges?: SwarmEdge[]
    ): string {
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

    private async runCliAgent(roleId: string, provider: DynamicProvider, cliCommand: string, safePrompt: string, cwd: string, env: NodeJS.ProcessEnv): Promise<SwarmAgentResult> {
        try {
            const runEnv = { ...env, FOKKUS_SAFE_PROMPT: safePrompt };
            let finalCommand = cliCommand;

            if (finalCommand.includes('agy')) {
                if (!finalCommand.includes('--dangerously-skip-permissions')) {
                    finalCommand = finalCommand.replace('agy', 'agy --dangerously-skip-permissions');
                }
                if (!finalCommand.includes('--add-dir')) {
                    finalCommand = finalCommand.replace('agy', `agy --add-dir "${cwd}"`);
                }
            }

            if (finalCommand.includes('"{prompt}"')) {
                finalCommand = finalCommand.replace('"{prompt}"', '"$FOKKUS_SAFE_PROMPT"');
            } else if (finalCommand.includes("'{prompt}'")) {
                finalCommand = finalCommand.replace("'{prompt}'", '"$FOKKUS_SAFE_PROMPT"');
            } else if (finalCommand.includes('{prompt}')) {
                finalCommand = finalCommand.replace('{prompt}', '"$FOKKUS_SAFE_PROMPT"');
            } else {
                finalCommand = `${cliCommand} "$FOKKUS_SAFE_PROMPT"`;
            }

            require('fs').writeFileSync('/tmp/fokkus-last-command.txt', finalCommand, 'utf8');

            const output = await this.runStreamingCommand(finalCommand, cwd, runEnv);
            return { roleId, providerId: provider.id, providerName: provider.name, status: 'completed', output };
        } catch (error) {
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

    private async resolveWorkspaceSettingsPath(): Promise<string> {
        const root = await this.resolveWorkspaceRoot();
        return join(root, '.theia', 'settings.json');
    }

    private async resolveTeamConfigPath(): Promise<string> {
        return join(os.homedir(), '.fokkus', 'team_config.json');
    }

    private async resolveChatHistoryPath(workspacePath: string): Promise<string> {
        const cwd = workspacePath || await this.resolveWorkspaceRoot();
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

    private runStreamingCommand(command: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
        return new Promise((resolve, reject) => {
            const options: any = { cwd, shell: true };
            if (env) {
                options.env = env;
            }
            const child = spawn(command, [], options);

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

            child.on('error', (error: Error) => {
                reject(error);
            });

            child.on('close', (code: number) => {
                const outStr = stdoutData.trim();
                const errStr = stderrData.trim();
                
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
