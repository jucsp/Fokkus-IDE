/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ILogger } from '@theia/core/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
    GmailSourceConfigInput,
    JiraConfigInput,
    SlackSourceConfigInput,
    TargetContainer,
    TargetOptionGroup,
    TargetProviderId,
    TargetProviderStatus,
    TargetSelections,
    TRIAGE_CATEGORIES,
    TRIAGE_DESCRIPTION_MAX_LENGTH,
    TRIAGE_DISCARD_REASON_MAX_LENGTH,
    TRIAGE_TITLE_MAX_LENGTH,
    TriageApproveInput,
    TriageApproveResult,
    TriageCategory,
    TriageClient,
    TriageConfigStatus,
    TriageConnectionTestResult,
    TriageEvent,
    TriageItem,
    TriageItemPatch,
    TriageItemQuery,
    TriagePollingStatus,
    TriagePollResult,
    TriageServer,
    TriageSource,
    TriageSourcePollResult,
    TriageStatus
} from '../../common/triage-protocol';
import { GitCredentialsStore } from '../git-credentials-store';
import { GmailSource } from './sources/gmail-source';
import { SlackSource, SourcePollOutput } from './sources/slack-source';
import { TriageConfigService } from './triage-config';
import { TriageHttpError } from './triage-http';
import { TriagePoller } from './triage-poller';
import { TriageStore } from './triage-store';
import { GitHubTarget } from './targets/github-target';
import { JiraTarget } from './targets/jira-target';
import { PlaneTarget } from './targets/plane-target';
import { buildTicketBody, TargetAdapter } from './targets/target-adapter';

const PROVIDERS: readonly TargetProviderId[] = ['plane', 'jira', 'github'];
const ITEM_ID_MAX = 300;
const OPTION_KINDS = new Set(['state', 'module', 'label', 'issue-type', 'component', 'sprint', 'milestone']);
const NO_CREDENTIALS = 'No hay credenciales configuradas';

function errorMessage(err: unknown, fallback: string): string {
    return err instanceof Error && err.message ? err.message : fallback;
}

function isCategory(value: unknown): value is TriageCategory {
    return typeof value === 'string' && TRIAGE_CATEGORIES.some(c => c.id === value);
}

function isProvider(value: unknown): value is TargetProviderId {
    return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

/**
 * Implementación RPC de la Bandeja Pre-Kanban (#26). Singleton del backend: orquesta config, almacén,
 * fuentes (Slack/Gmail, solo lectura), destinos (Plane/Jira/GitHub) y el sondeo; difunde eventos a
 * todas las ventanas conectadas. Nunca devuelve ni loguea secretos.
 */
@injectable()
export class TriageServerImpl implements TriageServer {
    private readonly clients = new Set<TriageClient>();
    private readonly approving = new Map<string, Promise<TriageApproveResult>>();
    readonly slack: SlackSource;
    readonly gmail: GmailSource;
    readonly adapters: Record<TargetProviderId, TargetAdapter>;
    readonly poller: TriagePoller;

    constructor(
        @inject(TriageConfigService) protected readonly config: TriageConfigService,
        @inject(TriageStore) protected readonly store: TriageStore,
        @inject(GitCredentialsStore) protected readonly gitCredentials: GitCredentialsStore,
        @inject(ILogger) protected readonly logger: ILogger
    ) {
        this.slack = new SlackSource(config, store);
        this.gmail = new GmailSource(config, store);
        this.adapters = { plane: new PlaneTarget(), jira: new JiraTarget(config), github: new GitHubTarget(gitCredentials) };
        this.poller = new TriagePoller({
            runPass: () => this.runPass(),
            isEnabled: () => this.config.isPollingEnabled(),
            persistEnabled: enabled => this.config.setPollingEnabled(enabled),
            onChange: polling => this.broadcast({ kind: 'polling-changed', polling })
        });
        config.onDidChange(() => {
            this.slack.reset();
            this.gmail.reset();
            this.adapters.jira.clearCache();
        });
        gitCredentials.onDidChange(() => this.adapters.github.clearCache());
    }

    // --- Clientes y eventos ----------------------------------------------------------------

    setClient(client: TriageClient | undefined): void {
        if (client) {
            this.clients.add(client);
        }
    }

    addClient(client: TriageClient): void {
        this.clients.add(client);
    }

    removeClient(client: TriageClient): void {
        this.clients.delete(client);
    }

    dispose(): void {
        this.poller.dispose();
    }

    /** Arranca el sondeo (lo llama la BackendApplicationContribution). */
    async startPolling(firstDelayMs?: number): Promise<void> {
        await this.poller.start(firstDelayMs);
    }

    protected broadcast(event: TriageEvent): void {
        for (const client of this.clients) {
            try {
                const result: unknown = client.onTriageEvent(event);
                if (result instanceof Promise) {
                    result.catch(() => undefined);
                }
            } catch {
                // Un cliente caído no debe afectar a los demás.
            }
        }
    }

    // --- Ítems -----------------------------------------------------------------------------

    async getStatus(): Promise<TriageStatus> {
        await this.poller.refreshEnabled();
        return { polling: this.poller.status(), counts: await this.store.counts() };
    }

    async listItems(query?: TriageItemQuery): Promise<TriageItem[]> {
        const status = query?.status;
        const source = query?.source;
        const category = query?.category;
        if (status !== undefined && status !== 'pending' && status !== 'approved' && status !== 'discarded') {
            throw new Error('Estado de filtro inválido');
        }
        if (source !== undefined && source !== 'slack' && source !== 'gmail') {
            throw new Error('Origen de filtro inválido');
        }
        if (category !== undefined && !isCategory(category)) {
            throw new Error('Categoría de filtro inválida');
        }
        const items = await this.store.list();
        return items
            .filter(item => (!status || item.status === status) && (!source || item.source === source) && (!category || item.category === category))
            .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
    }

    async updateItem(itemId: string, patch: TriageItemPatch): Promise<TriageItem> {
        const id = this.itemId(itemId);
        if (!patch || typeof patch !== 'object') {
            throw new Error('Cambios inválidos');
        }
        const title = patch.title === undefined ? undefined : this.title(patch.title);
        const description = patch.description === undefined ? undefined : this.description(patch.description);
        if (patch.category !== undefined && !isCategory(patch.category)) {
            throw new Error('Categoría inválida');
        }
        const category = patch.category;
        const item = await this.store.updateItem(id, current => {
            if (current.status !== 'pending') {
                throw new Error('Solo se pueden editar solicitudes pendientes');
            }
            this.applyEdits(current, title, description, category);
        });
        await this.emitUpdated(item);
        return item;
    }

    async discardItem(itemId: string, reason?: string): Promise<TriageItem> {
        const id = this.itemId(itemId);
        if (reason !== undefined && typeof reason !== 'string') {
            throw new Error('Motivo inválido');
        }
        const trimmed = (reason ?? '').trim();
        if (trimmed.length > TRIAGE_DISCARD_REASON_MAX_LENGTH) {
            throw new Error(`El motivo excede los ${TRIAGE_DISCARD_REASON_MAX_LENGTH} caracteres`);
        }
        if (this.approving.has(id)) {
            throw new Error('La solicitud se está aprobando');
        }
        const item = await this.store.updateItem(id, current => {
            if (current.status !== 'pending') {
                throw new Error('Solo se pueden descartar solicitudes pendientes');
            }
            current.status = 'discarded';
            current.discardReason = trimmed || undefined;
            current.updatedAt = new Date().toISOString();
        });
        await this.emitUpdated(item);
        return item;
    }

    async restoreItem(itemId: string): Promise<TriageItem> {
        const id = this.itemId(itemId);
        const item = await this.store.updateItem(id, current => {
            if (current.status !== 'discarded') {
                throw new Error('Solo se pueden restaurar solicitudes descartadas');
            }
            current.status = 'pending';
            current.discardReason = undefined;
            current.updatedAt = new Date().toISOString();
        });
        await this.emitUpdated(item);
        return item;
    }

    // --- Sondeo ----------------------------------------------------------------------------

    pollNow(): Promise<TriagePollResult> {
        return this.poller.pollNow();
    }

    async setPollingEnabled(enabled: boolean): Promise<TriageStatus> {
        if (typeof enabled !== 'boolean') {
            throw new Error('Valor inválido para el sondeo');
        }
        const polling: TriagePollingStatus = await this.poller.setEnabled(enabled);
        return { polling, counts: await this.store.counts() };
    }

    /** Una pasada por las fuentes habilitadas y configuradas. Una fuente que falla no frena a la otra. */
    protected async runPass(): Promise<TriagePollResult> {
        const startedAt = new Date().toISOString();
        const status = await this.config.getStatus();
        const runs: { source: TriageSource; run: () => Promise<SourcePollOutput> }[] = [];
        if (status.slack.enabled && status.slack.configured) {
            runs.push({ source: 'slack', run: () => this.slack.poll() });
        }
        if (status.gmail.enabled && status.gmail.configured) {
            runs.push({ source: 'gmail', run: () => this.gmail.poll() });
        }

        const sources: TriageSourcePollResult[] = [];
        const created: TriageItem[] = [];
        const updated: TriageItem[] = [];
        for (const { source, run } of runs) {
            try {
                const output = await run();
                sources.push(output.result);
                created.push(...output.created);
                updated.push(...output.updated);
                if (!output.result.ok) {
                    this.logger.warn(`Bandeja: la fuente ${source} terminó con errores`);
                }
            } catch (err) {
                const httpStatus = err instanceof TriageHttpError && err.status ? ` ${err.status}` : '';
                this.logger.warn(`Bandeja: falló la fuente ${source} (${err instanceof Error ? err.name : 'Error'}${httpStatus})`);
                sources.push({ source, ok: false, fetched: 0, created: 0, updated: 0, ignored: 0, error: errorMessage(err, `No se pudo leer ${source}`) });
            }
        }

        if (created.length || updated.length) {
            const counts = await this.store.counts();
            for (const item of updated) {
                this.broadcast({ kind: 'item-updated', item, counts });
            }
            if (created.length) {
                this.broadcast({ kind: 'items-detected', items: created, counts });
            }
        }
        return { startedAt, finishedAt: new Date().toISOString(), sources };
    }

    // --- Configuración ---------------------------------------------------------------------

    getConfig(): Promise<TriageConfigStatus> {
        return this.config.getStatus();
    }

    async saveSlackConfig(input: SlackSourceConfigInput): Promise<TriageConfigStatus> {
        await this.config.saveSlack(input);
        return this.afterConfigChange();
    }

    async clearSlackConfig(): Promise<TriageConfigStatus> {
        await this.config.clearSlack();
        return this.afterConfigChange();
    }

    async saveGmailConfig(input: GmailSourceConfigInput): Promise<TriageConfigStatus> {
        await this.config.saveGmail(input);
        return this.afterConfigChange();
    }

    async clearGmailConfig(): Promise<TriageConfigStatus> {
        await this.config.clearGmail();
        return this.afterConfigChange();
    }

    async saveJiraConfig(input: JiraConfigInput): Promise<TriageConfigStatus> {
        await this.config.saveJira(input);
        return this.afterConfigChange();
    }

    async clearJiraConfig(): Promise<TriageConfigStatus> {
        await this.config.clearJira();
        return this.afterConfigChange();
    }

    private afterConfigChange(): Promise<TriageConfigStatus> {
        return this.config.getStatus();
    }

    async testConnection(target: TriageSource | TargetProviderId): Promise<TriageConnectionTestResult> {
        if (target === 'slack') {
            const token = (await this.config.resolveSlackToken()).value;
            if (!token) {
                return { target, ok: false, message: NO_CREDENTIALS };
            }
            try {
                const { team } = await this.slack.authTest(token);
                if (team) {
                    await this.config.rememberIdentity('slack', team);
                }
                return { target, ok: true, status: 200, ...(team ? { identity: team } : {}), message: `Conectado al workspace ${team || 'de Slack'}` };
            } catch (err) {
                return this.failedTest(target, err, 'No se pudo conectar con Slack');
            }
        }
        if (target === 'gmail') {
            const status = await this.config.getStatus();
            if (!status.gmail.configured) {
                return { target, ok: false, message: NO_CREDENTIALS };
            }
            try {
                const email = await this.gmail.profile();
                if (email) {
                    await this.config.rememberIdentity('gmail', email);
                }
                return { target, ok: true, status: 200, ...(email ? { identity: email } : {}), message: `Conectado a Gmail como ${email || 'la cuenta configurada'}` };
            } catch (err) {
                return this.failedTest(target, err, 'No se pudo conectar con Gmail');
            }
        }
        if (isProvider(target)) {
            return this.adapters[target].test();
        }
        throw new Error('Destino de prueba inválido');
    }

    private failedTest(target: TriageSource, err: unknown, fallback: string): TriageConnectionTestResult {
        const status = err instanceof TriageHttpError ? err.status : undefined;
        return { target, ok: false, ...(status ? { status } : {}), message: errorMessage(err, fallback) };
    }

    // --- Destinos --------------------------------------------------------------------------

    async listTargetProviders(): Promise<TargetProviderStatus[]> {
        return Promise.all(PROVIDERS.map(id => this.adapters[id].status()));
    }

    listTargetContainers(provider: TargetProviderId): Promise<TargetContainer[]> {
        return this.adapter(provider).listContainers();
    }

    listTargetOptions(provider: TargetProviderId, containerId: string): Promise<TargetOptionGroup[]> {
        if (typeof containerId !== 'string' || !containerId) {
            throw new Error('Contenedor inválido');
        }
        return this.adapter(provider).listOptions(containerId);
    }

    approveItem(input: TriageApproveInput): Promise<TriageApproveResult> {
        try {
            return this.startApproval(input);
        } catch (err) {
            return Promise.reject(err);
        }
    }

    /** Validación y lock síncronos: una segunda llamada concurrente ve el lock antes de cualquier await. */
    private startApproval(input: TriageApproveInput): Promise<TriageApproveResult> {
        if (!input || typeof input !== 'object') {
            throw new Error('Datos de aprobación inválidos');
        }
        const id = this.itemId(input.itemId);
        const title = this.title(input.title);
        const description = this.description(input.description);
        if (!isCategory(input.category)) {
            throw new Error('Categoría inválida');
        }
        const target = input.target;
        if (!target || typeof target !== 'object') {
            throw new Error('Falta el destino');
        }
        const adapter = this.adapter(target.provider);
        if (typeof target.containerId !== 'string' || !target.containerId) {
            throw new Error('Falta elegir el contenedor de destino');
        }
        const selections = this.selections(target.selections);
        if (this.approving.has(id)) {
            throw new Error('La solicitud ya se está aprobando');
        }
        const run = this.doApprove(id, title, description, input.category, adapter, target.containerId, selections, input.includeSourceReference !== false);
        this.approving.set(id, run);
        const release = () => {
            this.approving.delete(id);
        };
        run.then(release, release);
        return run;
    }

    private async doApprove(
        id: string, title: string, description: string, category: TriageCategory,
        adapter: TargetAdapter, containerId: string, selections: TargetSelections, includeReference: boolean
    ): Promise<TriageApproveResult> {
        const saved = await this.store.updateItem(id, current => {
            if (current.status !== 'pending') {
                throw new Error('Solo se pueden aprobar solicitudes pendientes');
            }
            this.applyEdits(current, title, description, category);
        });

        let created;
        try {
            const containers = await adapter.listContainers();
            if (!containers.some(c => c.id === containerId)) {
                throw new Error('El contenedor de destino no existe o no es accesible');
            }
            this.validateSelections(await adapter.listOptions(containerId), selections);
            const body = buildTicketBody(description, saved, category, includeReference);
            created = await adapter.create({ containerId, title, body, selections, triageId: saved.id, receivedAt: saved.receivedAt });
        } catch (err) {
            const message = errorMessage(err, 'No se pudo crear el ticket');
            const failed = await this.store.updateItem(id, current => {
                current.lastError = message;
                current.updatedAt = new Date().toISOString();
            });
            await this.emitUpdated(failed);
            throw new Error(message);
        }

        const approvedAt = new Date().toISOString();
        const item = await this.store.updateItem(id, current => {
            current.status = 'approved';
            current.approval = { ticket: created.ticket, approvedAt };
            current.lastError = created.warning;
            current.updatedAt = approvedAt;
        });
        await this.emitUpdated(item);
        return { item, ticket: created.ticket };
    }

    private validateSelections(groups: TargetOptionGroup[], selections: TargetSelections): void {
        for (const [kind, ids] of Object.entries(selections)) {
            if (!ids || ids.length === 0) {
                continue;
            }
            const group = groups.find(g => g.kind === kind);
            if (!group) {
                throw new Error(`El destino no admite «${kind}»`);
            }
            if (!group.multiple && ids.length > 1) {
                throw new Error(`Solo se puede elegir una opción en «${group.label}»`);
            }
            for (const optionId of ids) {
                if (!group.options.some(o => o.id === optionId)) {
                    throw new Error(`La opción elegida en «${group.label}» ya no existe`);
                }
            }
        }
        for (const group of groups) {
            if (group.required && !(selections[group.kind]?.length)) {
                throw new Error(`Falta elegir «${group.label}»`);
            }
        }
    }

    // --- Validación ------------------------------------------------------------------------

    private adapter(provider: unknown): TargetAdapter {
        if (!isProvider(provider)) {
            throw new Error('Proveedor de destino inválido');
        }
        return this.adapters[provider];
    }

    private itemId(value: unknown): string {
        if (typeof value !== 'string' || !value || value.length > ITEM_ID_MAX) {
            throw new Error('Identificador de solicitud inválido');
        }
        return value;
    }

    private title(value: unknown): string {
        if (typeof value !== 'string') {
            throw new Error('El título es obligatorio');
        }
        const title = value.trim();
        if (!title) {
            throw new Error('El título es obligatorio');
        }
        if (title.length > TRIAGE_TITLE_MAX_LENGTH) {
            throw new Error(`El título excede los ${TRIAGE_TITLE_MAX_LENGTH} caracteres`);
        }
        return title;
    }

    private description(value: unknown): string {
        if (typeof value !== 'string') {
            throw new Error('Descripción inválida');
        }
        if (value.length > TRIAGE_DESCRIPTION_MAX_LENGTH) {
            throw new Error(`La descripción excede los ${TRIAGE_DESCRIPTION_MAX_LENGTH} caracteres`);
        }
        return value;
    }

    private selections(value: unknown): TargetSelections {
        if (value === undefined) {
            return {};
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Selecciones de destino inválidas');
        }
        const result: TargetSelections = {};
        for (const [kind, ids] of Object.entries(value as Record<string, unknown>)) {
            if (!OPTION_KINDS.has(kind) || !Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id || id.length > 300)) {
                throw new Error('Selecciones de destino inválidas');
            }
            result[kind as keyof TargetSelections] = [...new Set(ids as string[])];
        }
        return result;
    }

    private applyEdits(item: TriageItem, title?: string, description?: string, category?: TriageCategory): void {
        let changed = false;
        if (title !== undefined && title !== item.title) {
            item.title = title;
            changed = true;
        }
        if (description !== undefined && description !== item.description) {
            item.description = description;
            changed = true;
        }
        if (category !== undefined && category !== item.category) {
            item.category = category;
            changed = true;
        }
        if (changed) {
            item.edited = true;
            item.updatedAt = new Date().toISOString();
        }
    }

    private async emitUpdated(item: TriageItem): Promise<void> {
        this.broadcast({ kind: 'item-updated', item, counts: await this.store.counts() });
    }
}
