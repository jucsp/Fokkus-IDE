/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { inject, injectable } from '@theia/core/shared/inversify';
import {
    BitbucketCredentialsInput,
    GitCredentialAccounts,
    GitCredentialsServer,
    GitCredentialsStatus,
    GitCredentialsTestResult,
    GitHubCredentialsInput,
    GitProviderId
} from '../common/git-credentials-protocol';
import { GitCredentialsStore, validateStoredSecret } from './git-credentials-store';

const REQUEST_TIMEOUT_MS = 15000;
const USERNAME_RE = /^[A-Za-z0-9_.@+-]{1,128}$/;

/** Implementación RPC de la sección «Git Providers» (#22). Nunca devuelve ni loguea secretos. */
@injectable()
export class GitCredentialsServerImpl implements GitCredentialsServer {

    constructor(@inject(GitCredentialsStore) protected readonly store: GitCredentialsStore) { }

    async getStatus(): Promise<GitCredentialsStatus> {
        const githubToken = await this.store.resolveGitHubToken();
        const storedGithubToken = await this.store.getStored(GitCredentialAccounts.githubToken);
        const bitbucket = await this.store.resolveBitbucketAccount();
        const storedBitbucketUsername = await this.store.getStored(GitCredentialAccounts.bitbucketUsername);
        const storedBitbucketPassword = await this.store.getStored(GitCredentialAccounts.bitbucketAppPassword);
        const bitbucketFile = await this.store.readLegacyBitbucketFile();
        const githubFile = await this.store.readLegacyGitHubFile();

        const githubLegacyToken = this.fileToken(githubFile.content);
        const bitbucketLegacy = bitbucketFile.credentials;
        const bitbucketLegacyComplete = !!(bitbucketLegacy.username?.trim() && bitbucketLegacy.appPassword?.trim());

        // Con el almacén en memoria la importación se rechaza: no se ofrece.
        const storage = await this.store.storage();
        const legacyImportAvailable = storage !== 'memory' && (
            (!!githubLegacyToken && !storedGithubToken) ||
            (bitbucketLegacyComplete && !(storedBitbucketUsername && storedBitbucketPassword)));

        return {
            storage,
            github: {
                configured: !!githubToken.token,
                source: githubToken.source,
                storedInSecretStorage: !!storedGithubToken
            },
            bitbucket: {
                configured: !!(bitbucket.username && bitbucket.appPassword),
                source: bitbucket.source,
                storedInSecretStorage: !!storedBitbucketPassword,
                ...(bitbucket.username ? { username: bitbucket.username } : {}),
                legacyTokenRepositories: bitbucketLegacy.repositories.map(repo => repo.fullName)
            },
            legacyImportAvailable
        };
    }

    async saveGitHub(input: GitHubCredentialsInput): Promise<GitCredentialsStatus> {
        const token = validateStoredSecret(this.stringInput(input?.token), 'El token de GitHub');
        await this.store.setStored(GitCredentialAccounts.githubToken, token);
        return this.getStatus();
    }

    async clearGitHub(): Promise<GitCredentialsStatus> {
        await this.store.deleteStored(GitCredentialAccounts.githubToken);
        return this.getStatus();
    }

    async saveBitbucket(input: BitbucketCredentialsInput): Promise<GitCredentialsStatus> {
        const username = this.stringInput(input?.username).trim();
        if (!USERNAME_RE.test(username)) {
            throw new Error('El nombre de usuario de Bitbucket no es válido');
        }

        const provided = this.stringInput(input.appPassword).trim();
        let appPassword: string;
        if (provided) {
            appPassword = validateStoredSecret(provided, 'El app password de Bitbucket');
        } else {
            const existing = await this.store.getStored(GitCredentialAccounts.bitbucketAppPassword);
            if (!existing) {
                throw new Error('Falta el app password');
            }
            appPassword = existing;
        }

        await this.store.setStored(GitCredentialAccounts.bitbucketUsername, username);
        await this.store.setStored(GitCredentialAccounts.bitbucketAppPassword, appPassword);
        return this.getStatus();
    }

    async clearBitbucket(): Promise<GitCredentialsStatus> {
        await this.store.deleteStored(GitCredentialAccounts.bitbucketUsername);
        await this.store.deleteStored(GitCredentialAccounts.bitbucketAppPassword);
        return this.getStatus();
    }

    async testConnection(provider: GitProviderId): Promise<GitCredentialsTestResult> {
        return provider === 'github' ? this.testGitHub() : this.testBitbucket();
    }

    async importLegacyCredentials(): Promise<GitCredentialsStatus> {
        const storage = await this.store.storage();
        if (storage === 'memory') {
            throw new Error('El almacén seguro no está disponible; no se importó nada');
        }

        // GitHub: copia el token del archivo al almacén si no hay uno guardado.
        const githubFile = await this.store.readLegacyGitHubFile();
        const githubToken = this.fileToken(githubFile.content);
        if (githubToken) {
            const stored = await this.store.getStored(GitCredentialAccounts.githubToken);
            if (!stored) {
                await this.store.setStored(GitCredentialAccounts.githubToken, githubToken);
            }
        }
        // Reescribe github.json sin la clave `token`, conservando el resto (no toca env).
        if (githubFile.exists && 'token' in githubFile.content) {
            const next: Record<string, unknown> = { ...githubFile.content };
            delete next.token;
            await this.store.writeLegacyGitHubFile(next);
        }

        // Bitbucket: copia el PAR username/appPassword del .env si el almacén no tiene un par completo
        // (copiar solo una mitad mezclaría el usuario de una cuenta con el password de otra).
        const bitbucketFile = await this.store.readLegacyBitbucketFile();
        const legacy = bitbucketFile.credentials;
        const legacyUsername = legacy.username?.trim();
        const legacyPassword = legacy.appPassword?.trim();
        if (legacyUsername && legacyPassword) {
            const storedUsername = await this.store.getStored(GitCredentialAccounts.bitbucketUsername);
            const storedPassword = await this.store.getStored(GitCredentialAccounts.bitbucketAppPassword);
            if (!(storedUsername && storedPassword)) {
                await this.store.setStored(GitCredentialAccounts.bitbucketUsername, legacyUsername);
                await this.store.setStored(GitCredentialAccounts.bitbucketAppPassword, legacyPassword);
            }
        }

        return this.getStatus();
    }

    private async testGitHub(): Promise<GitCredentialsTestResult> {
        const { token } = await this.store.resolveGitHubToken();
        if (!token) {
            return { provider: 'github', ok: false, message: 'No hay credenciales configuradas' };
        }
        const response = await this.fetchGet('https://api.github.com/user', {
            'User-Agent': 'Fokkus-IDE',
            Accept: 'application/json',
            Authorization: `Bearer ${token}`
        });
        if (!response) {
            return { provider: 'github', ok: false, message: 'No se pudo conectar con GitHub' };
        }
        if (response.status === 401) {
            return { provider: 'github', ok: false, status: 401, message: 'Credenciales inválidas o expiradas' };
        }
        if (response.status === 403) {
            return { provider: 'github', ok: false, status: 403, message: 'Sin permisos suficientes (403)' };
        }
        if (!response.ok) {
            return { provider: 'github', ok: false, status: response.status, message: `GitHub respondió ${response.status}` };
        }
        const identity = await this.readIdentity(response, ['login']);
        return { provider: 'github', ok: true, status: response.status, ...(identity ? { identity } : {}), message: 'Conexión correcta' };
    }

    private async testBitbucket(): Promise<GitCredentialsTestResult> {
        const account = await this.store.resolveBitbucketAccount();
        if (!account.username || !account.appPassword) {
            return { provider: 'bitbucket', ok: false, message: 'No hay credenciales configuradas' };
        }
        const basic = Buffer.from(`${account.username}:${account.appPassword}`).toString('base64');
        const response = await this.fetchGet('https://api.bitbucket.org/2.0/user', {
            'User-Agent': 'Fokkus-IDE',
            Accept: 'application/json',
            Authorization: `Basic ${basic}`
        });
        if (!response) {
            return { provider: 'bitbucket', ok: false, message: 'No se pudo conectar con Bitbucket' };
        }
        if (response.status === 401) {
            return { provider: 'bitbucket', ok: false, status: 401, message: 'Credenciales inválidas o expiradas' };
        }
        if (response.status === 403) {
            return { provider: 'bitbucket', ok: false, status: 403, message: 'Sin permisos suficientes (403)' };
        }
        if (!response.ok) {
            return { provider: 'bitbucket', ok: false, status: response.status, message: `Bitbucket respondió ${response.status}` };
        }
        const identity = await this.readIdentity(response, ['username', 'display_name']);
        return { provider: 'bitbucket', ok: true, status: response.status, ...(identity ? { identity } : {}), message: 'Conexión correcta' };
    }

    /** Un único GET con timeout. Devuelve undefined ante error de red o timeout. */
    private async fetchGet(url: string, headers: Record<string, string>): Promise<Response | undefined> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            return await fetch(url, { method: 'GET', headers, signal: controller.signal });
        } catch {
            return undefined;
        } finally {
            clearTimeout(timer);
        }
    }

    /** Lee la identidad (no secreta) de la respuesta JSON, probando `fields` en orden. */
    private async readIdentity(response: Response, fields: string[]): Promise<string | undefined> {
        try {
            const data: unknown = await response.json();
            if (data && typeof data === 'object') {
                const record = data as Record<string, unknown>;
                for (const field of fields) {
                    const value = record[field];
                    if (typeof value === 'string' && value) {
                        return value;
                    }
                }
            }
        } catch {
            // Respuesta no JSON: sin identidad.
        }
        return undefined;
    }

    /** Las entradas llegan por RPC sin garantía de tipo: lo que no sea string cuenta como vacío. */
    private stringInput(value: unknown): string {
        return typeof value === 'string' ? value : '';
    }

    private fileToken(content: Record<string, unknown>): string | undefined {
        const token = content.token;
        return typeof token === 'string' ? token.trim() : undefined;
    }
}
