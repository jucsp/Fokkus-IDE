/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { promises as fs } from 'fs';
import * as os from 'os';
import { join } from 'path';
import { ILogger } from '@theia/core/lib/common';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
    GmailSourceConfigInput,
    JiraConfigInput,
    SlackSourceConfigInput,
    TRIAGE_DEFAULT_GMAIL_QUERY,
    TRIAGE_KEYSTORE_SERVICE,
    TriageConfigStatus,
    TriageCredentialAccounts,
    TriageSecretSource
} from '../../common/triage-protocol';
import { CredentialKeystore, FokkusKeyStore, validateStoredSecret } from '../git-credentials-store';

const SLACK_TOKEN_RE = /^xox[bp]-[A-Za-z0-9-]{10,}$/;
const SLACK_CHANNEL_RE = /^[CGD][A-Z0-9]{6,}$/;
const MAX_CHANNELS = 50;
const GMAIL_CLIENT_ID_RE = /\.apps\.googleusercontent\.com$/;
const GMAIL_QUERY_MAX = 500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function triageConfigPath(): string {
    return join(os.homedir(), '.fokkus', 'triage.json');
}

export interface TriageConfigFile {
    pollingEnabled: boolean;
    slack: { enabled: boolean; channelIds: string[]; teamName?: string };
    gmail: { enabled: boolean; clientId: string; query: string; account?: string };
    jira: { baseUrl: string; email: string; accountName?: string };
    internalDomains?: string[];
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function section(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

/** Normaliza el JSON leído de disco (tolerante a campos ausentes o de otro tipo). */
export function normalizeTriageConfig(raw: unknown): TriageConfigFile {
    const root = section(raw);
    const slack = section(root.slack);
    const gmail = section(root.gmail);
    const jira = section(root.jira);
    const file: TriageConfigFile = {
        pollingEnabled: root.pollingEnabled !== false,
        slack: { enabled: slack.enabled === true, channelIds: stringArray(slack.channelIds), teamName: optionalString(slack.teamName) },
        gmail: {
            enabled: gmail.enabled === true,
            clientId: typeof gmail.clientId === 'string' ? gmail.clientId : '',
            query: typeof gmail.query === 'string' && gmail.query.trim() ? gmail.query : TRIAGE_DEFAULT_GMAIL_QUERY,
            account: optionalString(gmail.account)
        },
        jira: {
            baseUrl: typeof jira.baseUrl === 'string' ? jira.baseUrl : '',
            email: typeof jira.email === 'string' ? jira.email : '',
            accountName: optionalString(jira.accountName)
        }
    };
    if (Array.isArray(root.internalDomains)) {
        file.internalDomains = stringArray(root.internalDomains).map(d => d.trim().toLowerCase()).filter(Boolean);
    }
    return file;
}

async function readConfigFile(): Promise<{ file: TriageConfigFile; corrupt: boolean }> {
    try {
        const raw = await fs.readFile(triageConfigPath(), 'utf8');
        return { file: normalizeTriageConfig(JSON.parse(raw)), corrupt: false };
    } catch (err) {
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
        return { file: normalizeTriageConfig({}), corrupt: !missing };
    }
}

/** Base URL de Jira configurada (la usa la lista blanca HTTP para fijar el host). */
export async function readJiraBaseUrl(): Promise<string | undefined> {
    const { file } = await readConfigFile();
    return file.jira.baseUrl || undefined;
}

/** Escritura atómica con permisos 0600: tmp → rename → chmod. */
export async function writeJsonAtomic(target: string, content: unknown): Promise<void> {
    await fs.mkdir(join(target, '..'), { recursive: true });
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(content, undefined, 2) + '\n', { mode: 0o600 });
    await fs.rename(tmp, target);
    await fs.chmod(target, 0o600);
}

function inputString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

export interface ResolvedSecret {
    value?: string;
    source: TriageSecretSource;
}

/**
 * Config de la Bandeja: lo no secreto en ~/.fokkus/triage.json y los secretos en el almacén
 * del sistema (servicio `fokkus-ide.triage`), con precedencia env > almacén.
 */
@injectable()
export class TriageConfigService {
    private storageKind: 'os-keychain' | 'memory' | undefined;
    private readonly cachedSecrets = new Map<string, string | undefined>();
    private writeQueue: Promise<unknown> = Promise.resolve();
    private readonly onDidChangeEmitter = new Emitter<void>();

    /** Se dispara tras guardar o borrar cualquier sección (los adaptadores limpian su caché). */
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    constructor(
        @inject(FokkusKeyStore) protected readonly keyStore: CredentialKeystore,
        @inject(ILogger) protected readonly logger: ILogger
    ) { }

    async read(): Promise<TriageConfigFile> {
        const { file, corrupt } = await readConfigFile();
        if (corrupt) {
            this.logger.error('triage.json no es válido: se usa la configuración por defecto');
        }
        return file;
    }

    /** Modifica triage.json de forma serializada. */
    update(mutator: (file: TriageConfigFile) => void): Promise<TriageConfigFile> {
        const next = this.writeQueue.then(async () => {
            const file = await this.read();
            mutator(file);
            await writeJsonAtomic(triageConfigPath(), file);
            return file;
        });
        this.writeQueue = next.catch(() => undefined);
        return next;
    }

    async storage(): Promise<'os-keychain' | 'memory'> {
        if (!this.storageKind) {
            let persistent = false;
            try {
                persistent = await this.keyStore.isPersistent();
            } catch (err) {
                this.logKeystoreError(err);
            }
            this.storageKind = persistent ? 'os-keychain' : 'memory';
        }
        return this.storageKind;
    }

    async getStored(account: string): Promise<string | undefined> {
        if (this.cachedSecrets.has(account)) {
            return this.cachedSecrets.get(account);
        }
        try {
            const value = (await this.keyStore.getPassword(TRIAGE_KEYSTORE_SERVICE, account))?.trim() || undefined;
            this.cachedSecrets.set(account, value);
            return value;
        } catch (err) {
            this.logKeystoreError(err);
            throw new Error('No se pudo acceder al almacén de credenciales del sistema');
        }
    }

    private async setStored(account: string, value: string): Promise<void> {
        try {
            await this.keyStore.setPassword(TRIAGE_KEYSTORE_SERVICE, account, value);
        } catch (err) {
            this.logKeystoreError(err);
            throw new Error('No se pudo acceder al almacén de credenciales del sistema');
        }
        this.cachedSecrets.set(account, value);
    }

    private async deleteStored(account: string): Promise<void> {
        try {
            await this.keyStore.deletePassword(TRIAGE_KEYSTORE_SERVICE, account);
        } catch (err) {
            this.logKeystoreError(err);
            throw new Error('No se pudo acceder al almacén de credenciales del sistema');
        }
        this.cachedSecrets.delete(account);
    }

    private async resolveSecret(envNames: string[], account: string): Promise<ResolvedSecret> {
        for (const name of envNames) {
            const value = (process.env[name] ?? '').trim();
            if (value) {
                return { value, source: 'env' };
            }
        }
        const stored = await this.getStored(account);
        return stored ? { value: stored, source: 'secret-storage' } : { source: 'none' };
    }

    resolveSlackToken(): Promise<ResolvedSecret> {
        return this.resolveSecret(['SLACK_TOKEN', 'FOKKUS_SLACK_TOKEN'], TriageCredentialAccounts.slackToken);
    }

    resolveGmailClientSecret(): Promise<ResolvedSecret> {
        return this.resolveSecret(['GMAIL_CLIENT_SECRET'], TriageCredentialAccounts.gmailClientSecret);
    }

    resolveGmailRefreshToken(): Promise<ResolvedSecret> {
        return this.resolveSecret(['GMAIL_REFRESH_TOKEN'], TriageCredentialAccounts.gmailRefreshToken);
    }

    resolveJiraApiToken(): Promise<ResolvedSecret> {
        return this.resolveSecret(['JIRA_API_TOKEN'], TriageCredentialAccounts.jiraApiToken);
    }

    async getStatus(): Promise<TriageConfigStatus> {
        const file = await this.read();
        const slackToken = await this.resolveSlackToken();
        const gmailSecret = await this.resolveGmailClientSecret();
        const gmailRefresh = await this.resolveGmailRefreshToken();
        const jiraToken = await this.resolveJiraApiToken();
        return {
            storage: await this.storage(),
            slack: {
                enabled: file.slack.enabled,
                configured: !!slackToken.value && file.slack.channelIds.length > 0,
                tokenSource: slackToken.source,
                channelIds: file.slack.channelIds,
                ...(file.slack.teamName ? { teamName: file.slack.teamName } : {})
            },
            gmail: {
                enabled: file.gmail.enabled,
                configured: !!file.gmail.clientId && !!gmailSecret.value && !!gmailRefresh.value,
                clientId: file.gmail.clientId,
                clientSecretSource: gmailSecret.source,
                refreshTokenSource: gmailRefresh.source,
                query: file.gmail.query,
                ...(file.gmail.account ? { account: file.gmail.account } : {})
            },
            jira: {
                configured: !!file.jira.baseUrl && !!file.jira.email && !!jiraToken.value,
                baseUrl: file.jira.baseUrl,
                email: file.jira.email,
                apiTokenSource: jiraToken.source,
                ...(file.jira.accountName ? { accountName: file.jira.accountName } : {})
            }
        };
    }

    async saveSlack(input: SlackSourceConfigInput): Promise<void> {
        const enabled = input?.enabled === true;
        const token = inputString(input?.token).trim();
        if (token && !SLACK_TOKEN_RE.test(token)) {
            throw new Error('El token de Slack debe empezar por xoxb- o xoxp-');
        }
        if (input?.channelIds !== undefined && !Array.isArray(input.channelIds)) {
            throw new Error('La lista de canales no es válida');
        }
        const channelIds: string[] = [];
        for (const raw of input?.channelIds ?? []) {
            const id = inputString(raw).trim().replace(/^#/, '');
            if (!SLACK_CHANNEL_RE.test(id)) {
                throw new Error(`Canal inválido: ${id.slice(0, 40)}`);
            }
            if (!channelIds.includes(id)) {
                channelIds.push(id);
            }
        }
        if (channelIds.length > MAX_CHANNELS) {
            throw new Error(`Se admiten como máximo ${MAX_CHANNELS} canales`);
        }
        if (enabled && !token && !(await this.resolveSlackToken()).value) {
            throw new Error('Falta el token de Slack');
        }
        if (token) {
            await this.setStored(TriageCredentialAccounts.slackToken, token);
        }
        await this.update(file => {
            file.slack.enabled = enabled;
            file.slack.channelIds = channelIds;
            if (token) {
                file.slack.teamName = undefined;
            }
        });
        this.onDidChangeEmitter.fire();
    }

    async clearSlack(): Promise<void> {
        await this.deleteStored(TriageCredentialAccounts.slackToken);
        await this.update(file => {
            file.slack = { enabled: false, channelIds: [] };
        });
        this.onDidChangeEmitter.fire();
    }

    async saveGmail(input: GmailSourceConfigInput): Promise<void> {
        const enabled = input?.enabled === true;
        const clientId = inputString(input?.clientId).trim();
        if ((enabled || clientId) && !GMAIL_CLIENT_ID_RE.test(clientId)) {
            throw new Error('El client id de Gmail debe terminar en .apps.googleusercontent.com');
        }
        const clientSecret = inputString(input?.clientSecret).trim();
        const refreshToken = inputString(input?.refreshToken).trim();
        const secret = clientSecret ? validateStoredSecret(clientSecret, 'El client secret de Gmail') : undefined;
        const refresh = refreshToken ? validateStoredSecret(refreshToken, 'El refresh token de Gmail') : undefined;
        const query = inputString(input?.query).trim();
        if (query.length > GMAIL_QUERY_MAX) {
            throw new Error(`La búsqueda de Gmail excede los ${GMAIL_QUERY_MAX} caracteres`);
        }
        if (enabled && !secret && !(await this.resolveGmailClientSecret()).value) {
            throw new Error('Falta el client secret de Gmail');
        }
        if (enabled && !refresh && !(await this.resolveGmailRefreshToken()).value) {
            throw new Error('Falta el refresh token de Gmail');
        }
        if (secret) {
            await this.setStored(TriageCredentialAccounts.gmailClientSecret, secret);
        }
        if (refresh) {
            await this.setStored(TriageCredentialAccounts.gmailRefreshToken, refresh);
        }
        await this.update(file => {
            if (secret || refresh || file.gmail.clientId !== clientId) {
                file.gmail.account = undefined;
            }
            file.gmail.enabled = enabled;
            file.gmail.clientId = clientId;
            file.gmail.query = query || TRIAGE_DEFAULT_GMAIL_QUERY;
        });
        this.onDidChangeEmitter.fire();
    }

    async clearGmail(): Promise<void> {
        await this.deleteStored(TriageCredentialAccounts.gmailClientSecret);
        await this.deleteStored(TriageCredentialAccounts.gmailRefreshToken);
        await this.update(file => {
            file.gmail = { enabled: false, clientId: '', query: TRIAGE_DEFAULT_GMAIL_QUERY };
        });
        this.onDidChangeEmitter.fire();
    }

    async saveJira(input: JiraConfigInput): Promise<void> {
        const baseUrl = this.validateJiraBaseUrl(inputString(input?.baseUrl));
        const email = inputString(input?.email).trim();
        if (!EMAIL_RE.test(email) || email.length > 254) {
            throw new Error('El email de Jira no es válido');
        }
        const provided = inputString(input?.apiToken).trim();
        const apiToken = provided ? validateStoredSecret(provided, 'El API token de Jira') : undefined;
        if (!apiToken && !(await this.resolveJiraApiToken()).value) {
            throw new Error('Falta el API token de Jira');
        }
        if (apiToken) {
            await this.setStored(TriageCredentialAccounts.jiraApiToken, apiToken);
        }
        await this.update(file => {
            if (apiToken || file.jira.baseUrl !== baseUrl || file.jira.email !== email) {
                file.jira.accountName = undefined;
            }
            file.jira.baseUrl = baseUrl;
            file.jira.email = email;
        });
        this.onDidChangeEmitter.fire();
    }

    async clearJira(): Promise<void> {
        await this.deleteStored(TriageCredentialAccounts.jiraApiToken);
        await this.update(file => {
            file.jira = { baseUrl: '', email: '' };
        });
        this.onDidChangeEmitter.fire();
    }

    async isPollingEnabled(): Promise<boolean> {
        return (await this.read()).pollingEnabled;
    }

    async setPollingEnabled(enabled: boolean): Promise<void> {
        await this.update(file => {
            file.pollingEnabled = enabled;
        });
    }

    /** Guarda la identidad obtenida en una prueba o un sondeo (no secreta). */
    async rememberIdentity(target: 'slack' | 'gmail' | 'jira', identity: string): Promise<void> {
        const current = await this.read();
        const known = target === 'slack' ? current.slack.teamName : target === 'gmail' ? current.gmail.account : current.jira.accountName;
        if (known === identity) {
            return;
        }
        await this.update(file => {
            if (target === 'slack') {
                file.slack.teamName = identity;
            } else if (target === 'gmail') {
                file.gmail.account = identity;
            } else {
                file.jira.accountName = identity;
            }
        });
    }

    private validateJiraBaseUrl(raw: string): string {
        const value = raw.trim().replace(/\/+$/, '');
        let url: URL;
        try {
            url = new URL(value);
        } catch {
            throw new Error('La URL de Jira no es válida');
        }
        if (url.protocol !== 'https:') {
            throw new Error('La URL de Jira debe usar https://');
        }
        if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
            throw new Error('La URL de Jira debe ser solo el sitio, sin ruta ni parámetros (p. ej. https://empresa.atlassian.net)');
        }
        return url.origin;
    }

    private logKeystoreError(err: unknown): void {
        this.logger.error(`Error del almacén de credenciales de la Bandeja (${err instanceof Error ? err.name : 'Error'})`);
    }
}
