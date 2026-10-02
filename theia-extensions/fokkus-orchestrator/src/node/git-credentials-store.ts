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
import { InMemoryCredentialsProvider, KeyStoreServiceImpl } from '@theia/core/lib/node/key-store-server';
import {
    GIT_CREDENTIAL_MAX_LENGTH,
    GIT_CREDENTIALS_KEYSTORE_SERVICE,
    GitCredentialAccounts,
    GitCredentialSource,
    GitCredentialsStorage
} from '../common/git-credentials-protocol';
import { BitbucketCredentials, readBitbucketCredentials } from './bitbucket-credentials';

/** Caracteres prohibidos en un secreto: espacios en blanco y controles (\x00-\x1f, \x7f). */
const SECRET_FORBIDDEN_RE = /[\s\x00-\x1f\x7f]/;

/** Rutas de archivos legados resueltas en tiempo de llamada (los tests cambian HOME). */
function githubLegacyPath(): string {
    return join(os.homedir(), '.fokkus', 'github.json');
}

function bitbucketLegacyPath(): string {
    const override = (process.env.FOKKUS_BITBUCKET_CREDENTIALS_FILE ?? '').trim();
    return override || join(os.homedir(), '.bitbucket_credentials.env');
}

/**
 * Subconjunto de `KeyStoreService` que usa el almacén, más la detección de
 * persistencia. Permite inyectar un keytar falso en los tests unitarios.
 */
export interface CredentialKeystore {
    getPassword(service: string, account: string): Promise<string | undefined>;
    setPassword(service: string, account: string, password: string): Promise<void>;
    deletePassword(service: string, account: string): Promise<boolean>;
    isPersistent(): Promise<boolean>;
}

/**
 * Subclase de `KeyStoreServiceImpl` que expone si el proveedor subyacente es el
 * respaldo en memoria (keytar no disponible) o el almacén del sistema operativo.
 */
@injectable()
export class FokkusKeyStore extends KeyStoreServiceImpl implements CredentialKeystore {
    async isPersistent(): Promise<boolean> {
        const impl = await this.getKeytar();
        return !(impl instanceof InMemoryCredentialsProvider);
    }
}

/** Valida un secreto antes de guardarlo. Errores en español y sin el valor. */
export function validateStoredSecret(raw: string, label: string): string {
    const value = raw.trim();
    if (!value) {
        throw new Error(`${label} es obligatorio`);
    }
    if (value.length > GIT_CREDENTIAL_MAX_LENGTH) {
        throw new Error(`${label} excede los ${GIT_CREDENTIAL_MAX_LENGTH} caracteres permitidos`);
    }
    if (SECRET_FORBIDDEN_RE.test(value)) {
        throw new Error(`${label} contiene espacios o caracteres de control`);
    }
    return value;
}

/**
 * Almacén de credenciales de los proveedores Git (#22). Guarda los secretos en el
 * almacén del sistema operativo (a través de `FokkusKeyStore`) y resuelve la
 * credencial efectiva con precedencia env > almacén > archivo legado.
 */
@injectable()
export class GitCredentialsStore {
    private storageKind: GitCredentialsStorage | undefined;
    private readonly cachedValues = new Map<string, string | undefined>();
    private readonly onDidChangeEmitter = new Emitter<void>();

    /** Se dispara tras cada set/delete del almacén para que los servidores limpien sus cachés. */
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    constructor(
        @inject(FokkusKeyStore) protected readonly keyStore: CredentialKeystore,
        @inject(ILogger) protected readonly logger: ILogger
    ) { }

    /** Resuelve (y cachea) si el almacén persiste en disco o solo en memoria. */
    async storage(): Promise<GitCredentialsStorage> {
        if (this.storageKind) {
            return this.storageKind;
        }
        let persistent = false;
        try {
            persistent = await this.keyStore.isPersistent();
        } catch (err) {
            this.logKeytarError(err);
            persistent = false;
        }
        this.storageKind = persistent ? 'os-keychain' : 'memory';
        return this.storageKind;
    }

    async getStored(account: string): Promise<string | undefined> {
        if (this.cachedValues.has(account)) {
            return this.cachedValues.get(account);
        }
        try {
            const value = await this.keyStore.getPassword(GIT_CREDENTIALS_KEYSTORE_SERVICE, account);
            this.cachedValues.set(account, value);
            return value;
        } catch (err) {
            this.logKeytarError(err);
            throw new Error('No se pudo acceder al almacén de credenciales del sistema');
        }
    }

    async setStored(account: string, value: string): Promise<void> {
        try {
            await this.keyStore.setPassword(GIT_CREDENTIALS_KEYSTORE_SERVICE, account, value);
        } catch (err) {
            this.logKeytarError(err);
            throw new Error('No se pudo acceder al almacén de credenciales del sistema');
        }
        this.cachedValues.set(account, value);
        this.onDidChangeEmitter.fire();
    }

    async deleteStored(account: string): Promise<void> {
        try {
            await this.keyStore.deletePassword(GIT_CREDENTIALS_KEYSTORE_SERVICE, account);
        } catch (err) {
            this.logKeytarError(err);
            throw new Error('No se pudo acceder al almacén de credenciales del sistema');
        }
        this.cachedValues.delete(account);
        this.onDidChangeEmitter.fire();
    }

    /** Token efectivo de GitHub: env > almacén seguro > ~/.fokkus/github.json > none. */
    async resolveGitHubToken(): Promise<{ token?: string; source: GitCredentialSource }> {
        const envToken = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
        if (envToken) {
            return { token: envToken, source: 'env' };
        }
        const stored = (await this.getStored(GitCredentialAccounts.githubToken))?.trim();
        if (stored) {
            return { token: stored, source: 'secret-storage' };
        }
        const legacy = await this.readLegacyGitHubToken();
        if (legacy) {
            return { token: legacy, source: 'legacy-file' };
        }
        return { source: 'none' };
    }

    /**
     * Cuenta efectiva de Bitbucket, por PAR usuario+app password:
     * env > almacén seguro > .env legado. Si solo hay usuario suelto, se reporta
     * con source 'none'.
     */
    async resolveBitbucketAccount(): Promise<{ username?: string; appPassword?: string; source: GitCredentialSource }> {
        const envUsername = (process.env.BITBUCKET_USERNAME || '').trim();
        const envPassword = (process.env.BITBUCKET_APP_PASSWORD || '').trim();
        if (envUsername && envPassword) {
            return { username: envUsername, appPassword: envPassword, source: 'env' };
        }
        const storedUsername = (await this.getStored(GitCredentialAccounts.bitbucketUsername))?.trim();
        const storedPassword = (await this.getStored(GitCredentialAccounts.bitbucketAppPassword))?.trim();
        if (storedUsername && storedPassword) {
            return { username: storedUsername, appPassword: storedPassword, source: 'secret-storage' };
        }
        const { credentials } = await this.readLegacyBitbucketFile();
        const legacyUsername = credentials.username?.trim();
        const legacyPassword = credentials.appPassword?.trim();
        if (legacyUsername && legacyPassword) {
            return { username: legacyUsername, appPassword: legacyPassword, source: 'legacy-file' };
        }
        const username = envUsername || storedUsername || legacyUsername;
        return username ? { username, source: 'none' } : { source: 'none' };
    }

    /** Lee ~/.fokkus/github.json. Tolerante a errores de lectura o JSON. */
    async readLegacyGitHubFile(): Promise<{ exists: boolean; content: Record<string, unknown> }> {
        try {
            const raw = await fs.readFile(githubLegacyPath(), 'utf8');
            const parsed: unknown = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return { exists: true, content: parsed as Record<string, unknown> };
            }
            return { exists: true, content: {} };
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.logger.error(`No se pudo leer el archivo legado de GitHub: ${err instanceof Error ? err.name : 'Error'}`);
            }
            return { exists: false, content: {} };
        }
    }

    /** Reescribe ~/.fokkus/github.json con permisos 0600 (se usa al importar). */
    async writeLegacyGitHubFile(content: Record<string, unknown>): Promise<void> {
        const target = githubLegacyPath();
        await fs.mkdir(join(os.homedir(), '.fokkus'), { recursive: true });
        await fs.writeFile(target, JSON.stringify(content, undefined, 4) + '\n', { mode: 0o600 });
        await fs.chmod(target, 0o600);
    }

    /** Lee ~/.bitbucket_credentials.env en tiempo de llamada. Tolerante a errores. */
    async readLegacyBitbucketFile(): Promise<{ exists: boolean; credentials: BitbucketCredentials }> {
        try {
            return await readBitbucketCredentials(bitbucketLegacyPath());
        } catch (err) {
            this.logger.error(`No se pudo leer el archivo legado de Bitbucket: ${err instanceof Error ? err.name : 'Error'}`);
            return { exists: false, credentials: { variables: {}, repositories: [] } };
        }
    }

    private async readLegacyGitHubToken(): Promise<string | undefined> {
        const { content } = await this.readLegacyGitHubFile();
        const candidate = content.token;
        return typeof candidate === 'string' ? candidate.trim() : undefined;
    }

    private logKeytarError(err: unknown): void {
        const name = err instanceof Error ? err.name : 'Error';
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Error del almacén de credenciales (${name}): ${message}`);
    }
}
