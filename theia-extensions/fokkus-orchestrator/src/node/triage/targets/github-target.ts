/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    TARGET_PROVIDER_LABELS,
    TargetContainer,
    TargetOption,
    TargetOptionGroup,
    TargetProviderStatus,
    TriageConnectionTestResult
} from '../../../common/triage-protocol';
import { GitCredentialsStore } from '../../git-credentials-store';
import { arr, prop, str, triageFetch, triageJson, TriageHttpError } from '../triage-http';
import { apiMessage, hasTriageIdMarker, isOnOrAfterReceivedAt, TargetAdapter, TargetCreateInput, TargetCreateResult, TtlCache } from './target-adapter';

const GITHUB_API = 'https://api.github.com';
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_PAGES = 3;

function githubError(err: unknown, action: string): Error {
    if (err instanceof TriageHttpError && err.status !== undefined) {
        if (err.status === 401) {
            return new Error('GitHub rechazó el token (HTTP 401)');
        }
        if (err.status === 403 || err.status === 404) {
            return new Error(`GitHub respondió HTTP ${err.status} al ${action}: el token no tiene acceso`);
        }
        return new Error(`GitHub respondió HTTP ${err.status} al ${action}`);
    }
    return err instanceof Error ? err : new Error(`No se pudo ${action} en GitHub`);
}

/**
 * Destino GitHub Issues (#26 HU-5). La escritura vive SOLO aquí: `github-server.ts` sigue siendo de solo lectura.
 * Token: GitCredentialsStore.resolveGitHubToken() (env > almacén > archivo legado).
 */
export class GitHubTarget implements TargetAdapter {
    readonly id = 'github' as const;
    private readonly containers = new TtlCache<TargetContainer[]>();
    private readonly options = new TtlCache<TargetOptionGroup[]>();

    constructor(protected readonly credentials: GitCredentialsStore) { }

    clearCache(): void {
        this.containers.clear();
        this.options.clear();
    }

    async status(): Promise<TargetProviderStatus> {
        const { token } = await this.credentials.resolveGitHubToken();
        return {
            id: 'github',
            label: TARGET_PROVIDER_LABELS.github,
            configured: !!token,
            ...(token ? {} : { message: 'Configura el token en Preferencias › Git Providers' }),
            containerLabel: 'Repositorio'
        };
    }

    listContainers(): Promise<TargetContainer[]> {
        return this.containers.get('repos', async () => {
            const token = await this.token();
            const repos: TargetContainer[] = [];
            for (let page = 1; page <= MAX_PAGES; page++) {
                const data = await this.get(token, '/user/repos', { per_page: '100', sort: 'updated', page: String(page) }, 'listar los repositorios');
                const list = arr(data);
                for (const repo of list) {
                    const fullName = str(prop(repo, 'full_name'));
                    if (fullName && REPO_RE.test(fullName) && prop(repo, 'has_issues') !== false && prop(repo, 'archived') !== true) {
                        repos.push({ id: fullName, name: fullName });
                    }
                }
                if (list.length < 100) {
                    break;
                }
            }
            return repos;
        });
    }

    listOptions(containerId: string): Promise<TargetOptionGroup[]> {
        this.assertRepo(containerId);
        return this.options.get(containerId, async () => {
            const token = await this.token();
            const [labels, milestones] = await Promise.all([
                this.get(token, `/repos/${containerId}/labels`, { per_page: '100' }, 'listar las etiquetas'),
                this.get(token, `/repos/${containerId}/milestones`, { state: 'open', per_page: '100' }, 'listar los milestones')
            ]);
            const labelOptions: TargetOption[] = arr(labels).map(l => {
                const name = str(prop(l, 'name')) ?? '';
                const color = str(prop(l, 'color')) ?? '';
                return { id: name, name, ...(/^[0-9a-f]{6}$/i.test(color) ? { color } : {}), ...(str(prop(l, 'description')) ? { detail: str(prop(l, 'description')) } : {}) };
            }).filter(l => l.id);
            const milestoneOptions: TargetOption[] = arr(milestones).map(m => {
                const number = prop(m, 'number');
                const due = str(prop(m, 'due_on'));
                return { id: typeof number === 'number' ? String(number) : '', name: str(prop(m, 'title')) ?? '', ...(due ? { detail: `vence ${due.slice(0, 10)}` } : {}) };
            }).filter(m => m.id);
            return [
                { kind: 'label', label: 'Etiquetas', multiple: true, required: false, options: labelOptions },
                { kind: 'milestone', label: 'Milestone', multiple: false, required: false, options: milestoneOptions }
            ];
        });
    }

    async create(input: TargetCreateInput): Promise<TargetCreateResult> {
        this.assertRepo(input.containerId);
        const token = await this.token();
        const existing = await this.findExisting(input, token);
        if (existing) {
            return existing;
        }
        const labels = input.selections.label ?? [];
        const milestone = input.selections.milestone?.[0];
        const response = await triageFetch({
            method: 'POST',
            url: `${GITHUB_API}/repos/${input.containerId}/issues`,
            headers: this.headers(token),
            body: JSON.stringify({
                title: input.title,
                body: input.body,
                ...(labels.length ? { labels } : {}),
                ...(milestone ? { milestone: Number(milestone) } : {})
            })
        });
        const body = await response.json().catch(() => ({}));
        if (response.status === 403 || response.status === 404) {
            throw new Error(`El token de GitHub no tiene permiso para crear issues en ${input.containerId}`);
        }
        if (response.status === 401) {
            throw new Error('GitHub rechazó el token (HTTP 401)');
        }
        if (response.status < 200 || response.status >= 300) {
            const message = apiMessage(prop(body, 'message'));
            throw new Error(`GitHub respondió HTTP ${response.status} al crear el issue${message ? `: ${message}` : ''}`);
        }
        const number = prop(body, 'number');
        const url = str(prop(body, 'html_url'));
        if (typeof number !== 'number' || !url || !url.startsWith('https://')) {
            throw new Error('GitHub no devolvió el número del issue creado');
        }
        return { ticket: { provider: 'github', containerId: input.containerId, key: `${input.containerId}#${number}`, url } };
    }

    /** Busca en el repo un issue que ya lleve el marcador de deduplicación; si existe, no se crea. */
    private async findExisting(input: TargetCreateInput, token: string): Promise<TargetCreateResult | undefined> {
        if (!input.triageId) {
            return undefined;
        }
        try {
            const query: Record<string, string> = {
                state: 'all', per_page: '100', sort: 'created', direction: 'desc',
                ...(input.receivedAt ? { since: input.receivedAt } : {})
            };
            const data = await this.get(token, `/repos/${input.containerId}/issues`, query, 'buscar el issue existente');
            for (const issue of arr(data)) {
                if (prop(issue, 'pull_request')) {
                    continue;
                }
                if (!isOnOrAfterReceivedAt(str(prop(issue, 'created_at')), input.receivedAt)) {
                    continue;
                }
                if (!hasTriageIdMarker(prop(issue, 'body'), input.triageId)) {
                    continue;
                }
                const number = prop(issue, 'number');
                const url = str(prop(issue, 'html_url'));
                if (typeof number !== 'number' || !url || !url.startsWith('https://')) {
                    continue;
                }
                const ticket = { provider: 'github' as const, containerId: input.containerId, key: `${input.containerId}#${number}`, url };
                return { ticket, warning: `El ticket ya existía en el backlog (${ticket.key}); se vinculó sin duplicarlo` };
            }
        } catch {
            // Si el GET de issues falla, se continúa con la creación normal.
        }
        return undefined;
    }

    async test(): Promise<TriageConnectionTestResult> {
        const { token } = await this.credentials.resolveGitHubToken();
        if (!token) {
            return { target: 'github', ok: false, message: 'No hay credenciales configuradas' };
        }
        try {
            const user = await this.get(token, '/user', {}, 'conectar');
            const login = str(prop(user, 'login')) ?? '';
            return { target: 'github', ok: true, status: 200, ...(login ? { identity: login } : {}), message: `Conectado a GitHub como ${login || 'usuario'}` };
        } catch (err) {
            const status = err instanceof TriageHttpError ? err.status : undefined;
            return { target: 'github', ok: false, ...(status ? { status } : {}), message: githubError(err, 'conectar').message };
        }
    }

    private async get(token: string, path: string, query: Record<string, string>, action: string): Promise<unknown> {
        const qs = new URLSearchParams(query).toString();
        try {
            return await triageJson({ method: 'GET', url: `${GITHUB_API}${path}${qs ? `?${qs}` : ''}`, headers: this.headers(token) }, 'GitHub');
        } catch (err) {
            const error = githubError(err, action);
            throw err instanceof TriageHttpError ? new TriageHttpError(error.message, err.status) : error;
        }
    }

    private headers(token: string): Record<string, string> {
        return {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json'
        };
    }

    private async token(): Promise<string> {
        const { token } = await this.credentials.resolveGitHubToken();
        if (!token) {
            throw new Error('Configura el token en Preferencias › Git Providers');
        }
        return token;
    }

    private assertRepo(id: string): void {
        if (typeof id !== 'string' || !REPO_RE.test(id)) {
            throw new Error('Repositorio de GitHub inválido');
        }
    }
}
