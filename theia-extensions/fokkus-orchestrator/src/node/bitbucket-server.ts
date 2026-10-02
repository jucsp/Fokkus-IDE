/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { promises as fs } from 'fs';
import { isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
    BitbucketAllPullRequestsResult,
    BitbucketConfigStatus,
    BitbucketPullRequest,
    BitbucketPullRequestFile,
    BitbucketPullRequestState,
    BitbucketRepo,
    BitbucketRepoError,
    BitbucketServer
} from '../common/bitbucket-protocol';
import { BitbucketCredentials, readBitbucketCredentials } from './bitbucket-credentials';
import { GitCredentialsStore } from './git-credentials-store';

const execFileAsync = promisify(execFile);

const DEFAULT_API_BASE = 'https://api.bitbucket.org/2.0';
const REQUEST_TIMEOUT_MS = 20000;
const CACHE_TTL_MS = 30000;
const DEFAULT_MAX_PAGES = 10;
/** Tope de repositorios a consultar en la vista global de PRs abiertos. */
const ALL_REPOS_MAX = 100;
/** Número máximo de repositorios consultados en paralelo en la vista global. */
const ALL_REPOS_CONCURRENCY = 6;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VALID_STATES: BitbucketPullRequestState[] = ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'];

/** Resuelve la base de la API, admitiendo override http(s) solo para QA con mock. */
function resolveApiBase(): string {
    const override = (process.env.FOKKUS_BITBUCKET_API_BASE ?? '').trim();
    if (!override) {
        return DEFAULT_API_BASE;
    }
    let parsed: URL;
    try {
        parsed = new URL(override);
    } catch {
        throw new Error('FOKKUS_BITBUCKET_API_BASE no es una URL válida');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('FOKKUS_BITBUCKET_API_BASE debe usar http o https');
    }
    return override.replace(/\/+$/, '');
}

const API_BASE = resolveApiBase();
const API_ORIGIN = new URL(API_BASE).origin;

type ApiAuth =
    | { kind: 'token'; credentialVariable: string; token: string }
    | { kind: 'basic'; credentialVariable: string; username: string; password: string };

interface BitbucketApiRepo {
    workspace?: { slug?: string } | null;
    slug?: string;
    full_name?: string;
}

interface BitbucketApiPullRequest {
    id?: number;
    title?: string;
    state?: string;
    author?: { display_name?: string; nickname?: string } | null;
    source?: { branch?: { name?: string } | null } | null;
    destination?: { branch?: { name?: string } | null } | null;
    links?: { html?: { href?: string } } | null;
    summary?: { html?: string } | null;
    created_on?: string;
    updated_on?: string;
    comment_count?: number;
}

interface BitbucketApiFile {
    status?: string;
    old?: { path?: string } | null;
    new?: { path?: string } | null;
    lines_added?: number;
    lines_removed?: number;
}

interface BitbucketApiEnvelope {
    values?: unknown[];
    next?: string;
}

/** Parsea URLs de `git remote get-url origin` de bitbucket.org y devuelve `workspace/slug`. */
export function parseBitbucketRemote(url: string): string | undefined {
    const clean = url.trim().replace(/\.git$/, '');
    let match = clean.match(/^https:\/\/(?:[^@/]+@)?bitbucket\.org\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/);
    if (match) {
        return `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
    }
    match = clean.match(/^git@bitbucket\.org:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (match) {
        return `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
    }
    match = clean.match(/^ssh:\/\/git@bitbucket\.org\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (match) {
        return `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
    }
    return undefined;
}

@injectable()
export class BitbucketServerImpl implements BitbucketServer {
    private readonly pagesCache = new Map<string, { expires: number; items: unknown[] }>();

    constructor(@inject(GitCredentialsStore) protected readonly credentialsStore: GitCredentialsStore) {
        this.credentialsStore.onDidChange(() => this.pagesCache.clear());
    }

    async getConfig(): Promise<BitbucketConfigStatus> {
        const { exists, credentials } = await this.resolveEffectiveBitbucketCredentials();
        const hasAccount = !!(credentials.username && credentials.appPassword);
        const status: BitbucketConfigStatus = {
            hasCredentials: exists || hasAccount,
            hasAppPassword: hasAccount,
            tokenRepositories: credentials.repositories.map(repo => repo.fullName)
        };
        if (credentials.username) {
            status.username = credentials.username;
        }
        return status;
    }

    async detectRepository(workspaceRoot: string): Promise<string | undefined> {
        try {
            let dir = workspaceRoot;
            if (dir.startsWith('file://')) {
                dir = fileURLToPath(dir);
            }
            if (!isAbsolute(dir)) {
                return undefined;
            }
            const stat = await fs.stat(dir);
            if (!stat.isDirectory()) {
                return undefined;
            }
            const result = await execFileAsync('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 5000 });
            const remote = String(result.stdout ?? '').trim();
            if (!remote) {
                return undefined;
            }
            return parseBitbucketRemote(remote);
        } catch {
            return undefined;
        }
    }

    async listRepositories(): Promise<BitbucketRepo[]> {
        const { credentials } = await this.resolveEffectiveBitbucketCredentials();
        const byFullName = new Map<string, BitbucketRepo>();

        // Los repos con token propio ganan siempre ante un eventual duplicado descubierto por app password.
        for (const repo of credentials.repositories) {
            if (!byFullName.has(repo.fullName)) {
                byFullName.set(repo.fullName, {
                    fullName: repo.fullName,
                    workspace: repo.workspace,
                    slug: repo.slug,
                    auth: 'token',
                    credentialVariable: repo.variable
                });
            }
        }

        if (credentials.username && credentials.appPassword) {
            try {
                const auth: ApiAuth = {
                    kind: 'basic',
                    credentialVariable: 'BITBUCKET_APP_PASSWORD',
                    username: credentials.username,
                    password: credentials.appPassword
                };
                const url = this.buildUrl('/repositories', [['role', 'member'], ['pagelen', '100']]);
                const raw = await this.apiGet<BitbucketApiRepo>(url, auth);
                for (const repo of raw) {
                    const fullName = this.repoFullName(repo);
                    if (!fullName || byFullName.has(fullName)) {
                        continue;
                    }
                    const [workspace, slug] = fullName.split('/');
                    byFullName.set(fullName, {
                        fullName,
                        workspace,
                        slug,
                        auth: 'app-password',
                        credentialVariable: 'BITBUCKET_APP_PASSWORD'
                    });
                }
            } catch (err) {
                // El descubrimiento por app password es opcional: si falla se ignora sin secretos.
                console.warn('No se pudieron descubrir repositorios de Bitbucket con app password', err instanceof Error ? err.message : String(err));
            }
        }

        return [...byFullName.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
    }

    async listPullRequests(repo: string, state: BitbucketPullRequestState | 'ALL'): Promise<BitbucketPullRequest[]> {
        const normalized = this.assertRepo(repo);
        const safeState = this.assertState(state);
        const [workspace, slug] = normalized.split('/');
        const auth = await this.resolveRepoAuth(normalized);

        const query: Array<[string, string]> = [['pagelen', '50']];
        if (safeState === 'ALL') {
            for (const item of VALID_STATES) {
                query.push(['state', item]);
            }
        } else {
            query.push(['state', safeState]);
        }

        const url = this.buildUrl(`/repositories/${workspace}/${slug}/pullrequests`, query);
        const raw = await this.apiGet<BitbucketApiPullRequest>(url, auth);
        return raw.map(pr => this.mapPullRequest(pr, normalized));
    }

    async listOpenPullRequestsAllRepos(): Promise<BitbucketAllPullRequestsResult> {
        const repos = (await this.listRepositories()).slice(0, ALL_REPOS_MAX);
        const errors: BitbucketRepoError[] = [];

        const batches = await this.runPool(repos, async repo => {
            try {
                const [workspace, slug] = repo.fullName.split('/');
                const auth = await this.resolveRepoAuth(repo.fullName);
                const url = this.buildUrl(`/repositories/${workspace}/${slug}/pullrequests`, [['pagelen', '50'], ['state', 'OPEN']]);
                const raw = await this.apiGet<BitbucketApiPullRequest>(url, auth);
                return raw.map(pr => this.mapPullRequest(pr, repo.fullName));
            } catch (err) {
                errors.push(this.toRepoError(repo.fullName, err));
                return [];
            }
        }, ALL_REPOS_CONCURRENCY);

        const pullRequests = batches.flat();
        pullRequests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return { pullRequests, errors };
    }

    async listPullRequestFiles(repo: string, pullRequestId: number): Promise<BitbucketPullRequestFile[]> {
        const normalized = this.assertRepo(repo);
        this.assertPositiveInt(pullRequestId, 'id de pull request');
        const [workspace, slug] = normalized.split('/');
        const auth = await this.resolveRepoAuth(normalized);
        const url = this.buildUrl(`/repositories/${workspace}/${slug}/pullrequests/${pullRequestId}/diffstat`, [['pagelen', '100']]);
        const raw = await this.apiGet<BitbucketApiFile>(url, auth);
        return raw.map(file => this.mapFile(file));
    }

    /**
     * Credenciales efectivas de Bitbucket: los tokens por repo del `.env` (sin cambios)
     * más el usuario/app password con precedencia env > almacén seguro > archivo legado.
     */
    private async resolveEffectiveBitbucketCredentials(): Promise<{ exists: boolean; credentials: BitbucketCredentials }> {
        const { exists, credentials } = await readBitbucketCredentials();
        const account = await this.credentialsStore.resolveBitbucketAccount();
        if (account.username) {
            credentials.username = account.username;
            credentials.variables.BITBUCKET_USERNAME = account.username;
        }
        if (account.appPassword) {
            credentials.appPassword = account.appPassword;
            credentials.variables.BITBUCKET_APP_PASSWORD = account.appPassword;
        }
        return { exists, credentials };
    }

    /** Resuelve las credenciales de un repo: token propio (Bearer) o app password (Basic). */
    private async resolveRepoAuth(repo: string): Promise<ApiAuth> {
        const { credentials } = await this.resolveEffectiveBitbucketCredentials();
        const repoCredential = credentials.repositories.find(item => item.fullName === repo);
        if (repoCredential) {
            return { kind: 'token', credentialVariable: repoCredential.variable, token: repoCredential.token };
        }
        if (credentials.username && credentials.appPassword) {
            return {
                kind: 'basic',
                credentialVariable: 'BITBUCKET_APP_PASSWORD',
                username: credentials.username,
                password: credentials.appPassword
            };
        }
        throw new Error(`Sin credenciales de Bitbucket para ${repo}`);
    }

    /** Único punto que usa `fetch`: todas las llamadas a Bitbucket son GET y pasan por aquí. */
    private async apiGet<T>(url: string, auth: ApiAuth): Promise<T[]> {
        const cacheKey = `${auth.credentialVariable}::${url}`;
        const cached = this.pagesCache.get(cacheKey);
        if (cached && cached.expires > Date.now()) {
            return cached.items as T[];
        }

        const items: T[] = [];
        let next: string | undefined = url;

        for (let page = 0; page < DEFAULT_MAX_PAGES && next; page++) {
            this.assertSameOrigin(next);
            let response: Response;
            try {
                response = await fetch(next, {
                    method: 'GET',
                    headers: this.authHeaders(auth),
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
                });
            } catch (err) {
                throw new Error(`No se pudo conectar con Bitbucket: ${err instanceof Error ? err.message : String(err)}`);
            }

            const data = await this.readEnvelope(response);
            this.assertOk(response, data);
            if (Array.isArray(data.values)) {
                items.push(...(data.values as T[]));
            }
            next = this.nextLink(data.next);
        }

        this.pagesCache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, items });
        return items;
    }

    private async readEnvelope(response: Response): Promise<BitbucketApiEnvelope> {
        try {
            return await response.json() as BitbucketApiEnvelope;
        } catch {
            return {};
        }
    }

    private assertOk(response: Response, data: BitbucketApiEnvelope): void {
        if (response.ok) {
            return;
        }
        const errorMessage = (data as { error?: { message?: string } }).error?.message;
        const message = errorMessage || response.statusText || 'Error de Bitbucket';
        throw Object.assign(new Error(`Bitbucket ${response.status}: ${message}`), { status: response.status });
    }

    private nextLink(next?: string): string | undefined {
        if (!next) {
            return undefined;
        }
        try {
            const parsed = new URL(next);
            if (parsed.origin !== API_ORIGIN) {
                return undefined;
            }
            return parsed.href;
        } catch {
            return undefined;
        }
    }

    private assertSameOrigin(url: string): void {
        let origin: string;
        try {
            origin = new URL(url).origin;
        } catch {
            throw new Error('URL de Bitbucket inválida');
        }
        if (origin !== API_ORIGIN) {
            throw new Error('URL de Bitbucket no permitida');
        }
    }

    private authHeaders(auth: ApiAuth): Record<string, string> {
        if (auth.kind === 'token') {
            return {
                Authorization: `Bearer ${auth.token}`,
                'User-Agent': 'Fokkus-IDE',
                Accept: 'application/json'
            };
        }
        const basic = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
        return {
            Authorization: `Basic ${basic}`,
            'User-Agent': 'Fokkus-IDE',
            Accept: 'application/json'
        };
    }

    private buildUrl(path: string, query?: Array<[string, string]>): string {
        if (!query || query.length === 0) {
            return `${API_BASE}${path}`;
        }
        const queryString = query.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
        return `${API_BASE}${path}?${queryString}`;
    }

    private repoFullName(repo: BitbucketApiRepo): string | undefined {
        // `full_name` puede traer el nombre visible del repo; se prefieren los slugs.
        const fullName = repo.workspace?.slug && repo.slug ? `${repo.workspace.slug}/${repo.slug}` : repo.full_name;
        if (!fullName || !REPO_RE.test(fullName)) {
            return undefined;
        }
        return fullName.toLowerCase();
    }

    private mapPullRequest(pr: BitbucketApiPullRequest, repo: string): BitbucketPullRequest {
        const rawState = (pr.state ?? 'OPEN').toUpperCase();
        const state: BitbucketPullRequestState = VALID_STATES.includes(rawState as BitbucketPullRequestState)
            ? rawState as BitbucketPullRequestState
            : 'OPEN';
        return {
            id: pr.id ?? 0,
            repo,
            title: pr.title ?? '',
            state,
            author: pr.author?.display_name ?? pr.author?.nickname ?? '',
            sourceBranch: pr.source?.branch?.name ?? '',
            destinationBranch: pr.destination?.branch?.name ?? '',
            htmlUrl: pr.links?.html?.href ?? '',
            descriptionHtml: pr.summary?.html ?? '',
            createdAt: pr.created_on ?? '',
            updatedAt: pr.updated_on ?? '',
            commentCount: pr.comment_count ?? 0
        };
    }

    private mapFile(file: BitbucketApiFile): BitbucketPullRequestFile {
        const newPath = file.new?.path;
        const oldPath = file.old?.path;
        const path = newPath ?? oldPath ?? '';
        return {
            path,
            ...(newPath && oldPath && oldPath !== newPath ? { oldPath } : {}),
            status: file.status ?? '',
            linesAdded: file.lines_added ?? 0,
            linesRemoved: file.lines_removed ?? 0
        };
    }

    private toRepoError(repo: string, err: unknown): BitbucketRepoError {
        const status = (err as { status?: number } | undefined)?.status;
        return {
            repo,
            ...(typeof status === 'number' ? { status } : {}),
            message: err instanceof Error ? err.message : String(err)
        };
    }

    /** Ejecuta `worker` sobre `items` limitando a `concurrency` promesas simultáneas, sin dependencias. */
    private async runPool<T, R>(items: T[], worker: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
        const results = new Array<R>(items.length);
        let nextIndex = 0;
        const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                results[index] = await worker(items[index]);
            }
        });
        await Promise.all(workers);
        return results;
    }

    private assertRepo(repo: string): string {
        // `.` o `..` como segmento alterarían la ruta de la API al normalizar la URL.
        if (typeof repo !== 'string' || !REPO_RE.test(repo) || repo.split('/').some(part => /^\.+$/.test(part))) {
            throw new Error('Repositorio inválido, usa workspace/slug');
        }
        return repo.toLowerCase();
    }

    private assertState(state: BitbucketPullRequestState | 'ALL'): BitbucketPullRequestState | 'ALL' {
        if (state !== 'ALL' && !VALID_STATES.includes(state)) {
            throw new Error('Estado inválido, usa OPEN, MERGED, DECLINED, SUPERSEDED o ALL');
        }
        return state;
    }

    private assertPositiveInt(value: number, label: string): void {
        if (!Number.isInteger(value) || value <= 0) {
            throw new Error(`El ${label} debe ser un entero positivo`);
        }
    }
}
