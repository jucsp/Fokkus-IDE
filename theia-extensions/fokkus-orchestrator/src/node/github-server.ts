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
import { join, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { injectable } from '@theia/core/shared/inversify';
import {
    GitHubColumn,
    GitHubConfigInput,
    GitHubConfigStatus,
    GitHubIssue,
    GitHubIssueQuery,
    GitHubIssueResult,
    GitHubLabel,
    GitHubMilestone,
    GitHubProject,
    GitHubPullRequest,
    GitHubPullRequestFile,
    GitHubRepo,
    GitHubServer,
    GitHubUser
} from '../common/github-protocol';

const execFileAsync = promisify(execFile);

const CONFIG_DIR = join(os.homedir(), '.fokkus');
const CONFIG_PATH = join(CONFIG_DIR, 'github.json');
const API_BASE = 'https://api.github.com';
const API_ORIGIN = new URL(API_BASE).origin;
const REQUEST_TIMEOUT_MS = 20000;
const CACHE_TTL_MS = 30000;
const DEFAULT_MAX_PAGES = 10;
const REPOS_MAX_PAGES = 3;
const FILES_MAX_PAGES = 3;
/** Tope de repositorios a consultar en la vista global de PRs abiertos. */
const ALL_REPOS_MAX = 100;
/** Número máximo de repositorios consultados en paralelo en la vista global. */
const ALL_REPOS_CONCURRENCY = 6;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PROJECT_ID_RE = /^[A-Za-z0-9_=-]+$/;
const GRAPHQL_MUTATION_RE = /\bmutation\b/i;

/** Mapa razonable de los colores del enum de GraphQL (ProjectV2) a hexadecimales. */
const GRAPHQL_COLORS: Record<string, string> = {
    GRAY: '#6e7781',
    BLUE: '#0969da',
    GREEN: '#1a7f37',
    YELLOW: '#9a6700',
    ORANGE: '#bc4c00',
    RED: '#cf222e',
    PINK: '#bf3989',
    PURPLE: '#8250df'
};

interface GitHubConfigFile {
    token?: string;
}

interface GitHubApiRepo {
    full_name?: string;
    owner?: { login?: string } | null;
    name?: string;
    private?: boolean;
}

interface GitHubApiUser {
    login?: string;
    avatar_url?: string;
}

interface GitHubApiLabel {
    name?: string;
    color?: string;
}

interface GitHubApiMilestone {
    number: number;
    title?: string;
}

interface GitHubApiIssue {
    node_id?: string;
    number: number;
    title?: string;
    state?: string;
    body_html?: string;
    html_url?: string;
    user?: { login?: string } | null;
    assignees?: Array<{ login?: string }> | null;
    labels?: Array<{ name?: string; color?: string }> | null;
    milestone?: { title?: string } | null;
    updated_at?: string;
    pull_request?: Record<string, unknown> | null;
}

interface GitHubApiPull {
    number: number;
    title?: string;
    state?: string;
    draft?: boolean;
    user?: { login?: string } | null;
    head?: { ref?: string } | null;
    base?: { ref?: string } | null;
    html_url?: string;
    body_html?: string;
    created_at?: string;
    updated_at?: string;
    merged_at?: string | null;
}

interface GitHubApiFile {
    filename?: string;
    status?: string;
    additions?: number;
    deletions?: number;
}

interface GraphQLProjectNode {
    id?: string;
    number?: number;
    title?: string;
    closed?: boolean;
}

interface GraphQLProjectsResponse {
    data?: {
        repository?: { projectsV2?: { nodes?: Array<GraphQLProjectNode> } };
        repositoryOwner?: { projectsV2?: { nodes?: Array<GraphQLProjectNode> } };
    };
}

interface GraphQLStatusOption {
    id?: string;
    name?: string;
    color?: string;
}

interface GraphQLProjectV2Response {
    data?: {
        node?: {
            field?: { options?: Array<GraphQLStatusOption> } | null;
            items?: {
                pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
                nodes?: Array<{
                    content?: { id?: string } | null;
                    fieldValueByName?: { optionId?: string } | null;
                }>;
            };
        } | null;
    };
}

@injectable()
export class GitHubServerImpl implements GitHubServer {
    private readonly pagesCache = new Map<string, { expires: number; items: unknown[] }>();

    async getConfig(): Promise<GitHubConfigStatus> {
        const tokenSource = await this.resolveTokenSource();
        const token = await this.resolveToken();
        const status: GitHubConfigStatus = { hasToken: !!token, tokenSource };
        if (token) {
            try {
                const user = await this.getJson<GitHubApiUser>('/user');
                if (user.login) {
                    status.login = user.login;
                }
            } catch {
                // Token inválido o sin red: no se lanza, simplemente no se conoce el login.
            }
        }
        return status;
    }

    async saveConfig(input: GitHubConfigInput): Promise<GitHubConfigStatus> {
        // Se conserva el token del archivo si no se envía uno nuevo: las variables de entorno no se persisten.
        const current = await this.loadConfigFile();
        const token = (input.token ?? '').trim() || (current.token ?? '').trim();

        const file: GitHubConfigFile = {};
        if (token) {
            file.token = token;
        }

        await fs.mkdir(CONFIG_DIR, { recursive: true });
        await fs.writeFile(CONFIG_PATH, JSON.stringify(file, undefined, 4) + '\n', { mode: 0o600 });
        // `mode` solo aplica al crear el archivo; si ya existía con otros permisos, se corrigen.
        await fs.chmod(CONFIG_PATH, 0o600);
        this.pagesCache.clear();

        return this.getConfig();
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
            return this.parseGitHubRemote(remote);
        } catch {
            return undefined;
        }
    }

    async listRepositories(): Promise<GitHubRepo[]> {
        const raw = await this.fetchAllPages<GitHubApiRepo>(
            '/user/repos',
            { sort: 'updated', affiliation: 'owner,collaborator,organization_member' },
            REPOS_MAX_PAGES
        );
        return raw.map(repo => ({
            fullName: repo.full_name ?? '',
            owner: repo.owner?.login ?? '',
            name: repo.name ?? '',
            private: !!repo.private
        }));
    }

    async listAssignees(repo: string): Promise<GitHubUser[]> {
        this.assertRepo(repo);
        const raw = await this.fetchAllPages<GitHubApiUser>(`/repos/${repo}/assignees`);
        return raw.map(user => ({
            login: user.login ?? '',
            ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {})
        }));
    }

    async listLabels(repo: string): Promise<GitHubLabel[]> {
        this.assertRepo(repo);
        const raw = await this.fetchAllPages<GitHubApiLabel>(`/repos/${repo}/labels`);
        return raw.map(label => ({
            name: label.name ?? '',
            ...(label.color ? { color: label.color } : {})
        }));
    }

    async listMilestones(repo: string): Promise<GitHubMilestone[]> {
        this.assertRepo(repo);
        const raw = await this.fetchAllPages<GitHubApiMilestone>(`/repos/${repo}/milestones`, { state: 'all' });
        return raw.map(milestone => ({ number: milestone.number, title: milestone.title ?? '' }));
    }

    async listProjects(repo: string): Promise<GitHubProject[]> {
        this.assertRepo(repo);
        const [owner = '', name = ''] = repo.split('/');

        const query = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    projectsV2(first: 50) { nodes { id number title closed } }
  }
  repositoryOwner(login: $owner) {
    ... on User { projectsV2(first: 50) { nodes { id number title closed } } }
    ... on Organization { projectsV2(first: 50) { nodes { id number title closed } } }
  }
}`;

        const data = await this.graphql(query, { owner, name }) as GraphQLProjectsResponse;
        const byId = new Map<string, GitHubProject>();
        const addNodes = (nodes?: Array<GraphQLProjectNode>): void => {
            for (const node of nodes ?? []) {
                if (!node.id || node.closed) {
                    continue;
                }
                if (!byId.has(node.id)) {
                    byId.set(node.id, { id: node.id, number: node.number ?? 0, title: node.title ?? '' });
                }
            }
        };

        addNodes(data.data?.repository?.projectsV2?.nodes);
        addNodes(data.data?.repositoryOwner?.projectsV2?.nodes);
        return [...byId.values()];
    }

    async listIssues(query: GitHubIssueQuery): Promise<GitHubIssueResult> {
        this.assertRepo(query.repo);
        const state = this.assertState(query.state);

        const params: Record<string, string> = { state };
        if (query.assignee) {
            params.assignee = query.assignee;
        }
        if (query.label) {
            params.labels = query.label;
        }
        if (query.milestone !== undefined) {
            this.assertPositiveInt(query.milestone, 'milestone');
            params.milestone = String(query.milestone);
        }

        const raw = await this.fetchAllPages<GitHubApiIssue>(`/repos/${query.repo}/issues`, params);
        // La API de issues mezcla PRs: se descartan los items con `pull_request`.
        const issues = raw.filter(item => !item.pull_request);

        let columns: GitHubColumn[];
        let projectItems: Map<string, string | undefined> | undefined;

        if (query.projectId) {
            this.assertProjectId(query.projectId);
            const project = await this.fetchProjectColumns(query.projectId);
            columns = project.columns;
            projectItems = project.items;
        } else {
            columns = [
                { id: 'open', name: 'Abierto', color: '#3fb950' },
                { id: 'closed', name: 'Cerrado', color: '#a371f7' }
            ];
        }

        const mapped: GitHubIssue[] = [];
        let hasUnassigned = false;

        for (const item of issues) {
            let columnId: string;
            if (projectItems) {
                if (!projectItems.has(item.node_id ?? '')) {
                    continue;
                }
                columnId = projectItems.get(item.node_id ?? '') ?? '__none__';
                if (columnId === '__none__') {
                    hasUnassigned = true;
                }
            } else {
                columnId = item.state === 'closed' ? 'closed' : 'open';
            }
            mapped.push(this.mapIssue(item, columnId));
        }

        if (hasUnassigned) {
            columns = [...columns, { id: '__none__', name: 'Sin estado' }];
        }

        mapped.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return { columns, issues: mapped };
    }

    async listPullRequests(repo: string, state: 'open' | 'closed' | 'all'): Promise<GitHubPullRequest[]> {
        this.assertRepo(repo);
        this.assertState(state);
        const raw = await this.fetchAllPages<GitHubApiPull>(`/repos/${repo}/pulls`, { state, sort: 'updated', direction: 'desc' });
        return raw.map(pr => this.mapPull(pr, repo));
    }

    async listOpenPullRequestsAllRepos(): Promise<GitHubPullRequest[]> {
        const repos = await this.listRepositories();
        const scoped = repos.slice(0, ALL_REPOS_MAX);

        const batches = await this.runPool(scoped, async repo => {
            try {
                const raw = await this.fetchAllPages<GitHubApiPull>(
                    `/repos/${repo.fullName}/pulls`,
                    { state: 'open', sort: 'updated', direction: 'desc' },
                    1
                );
                return raw.map(pr => this.mapPull(pr, repo.fullName));
            } catch {
                // Un repo que falle (404/403/limitado) se ignora y no tumba el resto.
                return [];
            }
        }, ALL_REPOS_CONCURRENCY);

        const all = batches.flat();
        all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return all;
    }

    async listPullRequestFiles(repo: string, pullNumber: number): Promise<GitHubPullRequestFile[]> {
        this.assertRepo(repo);
        this.assertPositiveInt(pullNumber, 'número de pull request');
        const raw = await this.fetchAllPages<GitHubApiFile>(`/repos/${repo}/pulls/${pullNumber}/files`, undefined, FILES_MAX_PAGES);
        return raw.map(file => ({
            filename: file.filename ?? '',
            status: file.status ?? '',
            additions: file.additions ?? 0,
            deletions: file.deletions ?? 0
        }));
    }

    private mapIssue(item: GitHubApiIssue, columnId: string): GitHubIssue {
        return {
            id: item.node_id ?? '',
            number: item.number,
            code: `#${item.number}`,
            title: item.title ?? '',
            state: item.state === 'closed' ? 'closed' : 'open',
            bodyHtml: item.body_html ?? '',
            htmlUrl: item.html_url ?? '',
            author: item.user?.login ?? '',
            assignees: (item.assignees ?? []).map(assignee => assignee.login ?? ''),
            labels: (item.labels ?? []).map(label => ({
                name: label.name ?? '',
                ...(label.color ? { color: label.color } : {})
            })),
            ...(item.milestone?.title ? { milestone: item.milestone.title } : {}),
            updatedAt: item.updated_at ?? '',
            columnId
        };
    }

    private mapPull(pr: GitHubApiPull, repo: string): GitHubPullRequest {
        return {
            number: pr.number,
            repo,
            title: pr.title ?? '',
            state: pr.merged_at ? 'merged' : (pr.state === 'closed' ? 'closed' : 'open'),
            draft: !!pr.draft,
            author: pr.user?.login ?? '',
            headRef: pr.head?.ref ?? '',
            baseRef: pr.base?.ref ?? '',
            htmlUrl: pr.html_url ?? '',
            bodyHtml: pr.body_html ?? '',
            createdAt: pr.created_at ?? '',
            updatedAt: pr.updated_at ?? ''
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

    private async fetchProjectColumns(projectId: string): Promise<{ columns: GitHubColumn[]; items: Map<string, string | undefined> }> {
        const columns: GitHubColumn[] = [];
        const items = new Map<string, string | undefined>();
        let cursor: string | undefined;

        for (let page = 0; page < DEFAULT_MAX_PAGES; page++) {
            const query = `query($id: ID!, $cursor: String) {
  node(id: $id) {
    ... on ProjectV2 {
      field(name: "Status") {
        ... on ProjectV2SingleSelectField {
          options { id name color }
        }
      }
      items(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          content { ... on Issue { id } }
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { optionId }
          }
        }
      }
    }
  }
}`;

            const variables: Record<string, unknown> = {
                id: projectId,
                cursor: cursor ?? null // eslint-disable-line no-null/no-null
            };
            const data = await this.graphql(query, variables) as GraphQLProjectV2Response;
            const node = data.data?.node;
            if (!node) {
                break;
            }

            if (page === 0 && node.field?.options) {
                for (const option of node.field.options) {
                    columns.push({
                        id: option.id ?? '',
                        name: option.name ?? '',
                        ...(this.graphqlColor(option.color) ? { color: this.graphqlColor(option.color) } : {})
                    });
                }
            }

            const nodes = node.items?.nodes ?? [];
            for (const item of nodes) {
                const nodeId = item.content?.id;
                if (nodeId) {
                    items.set(nodeId, item.fieldValueByName?.optionId);
                }
            }

            const pageInfo = node.items?.pageInfo;
            if (pageInfo?.hasNextPage && pageInfo.endCursor) {
                cursor = pageInfo.endCursor;
                continue;
            }
            break;
        }

        return { columns, items };
    }

    private graphqlColor(color?: string): string | undefined {
        if (!color) {
            return undefined;
        }
        return GRAPHQL_COLORS[color];
    }

    private parseGitHubRemote(remote: string): string | undefined {
        const clean = remote.replace(/\.git$/, '');

        let match = clean.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/);
        if (match) {
            return `${match[1]}/${match[2]}`;
        }

        match = clean.match(/^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
        if (match) {
            return `${match[1]}/${match[2]}`;
        }

        match = clean.match(/^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
        if (match) {
            return `${match[1]}/${match[2]}`;
        }

        return undefined;
    }

    private async resolveTokenSource(): Promise<'env' | 'file' | 'none'> {
        if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) {
            return 'env';
        }
        const file = await this.loadConfigFile();
        return file.token ? 'file' : 'none';
    }

    private async resolveToken(): Promise<string> {
        const envToken = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
        if (envToken) {
            return envToken;
        }
        const file = await this.loadConfigFile();
        return (file.token ?? '').trim();
    }

    private async loadConfigFile(): Promise<GitHubConfigFile> {
        try {
            const raw = await fs.readFile(CONFIG_PATH, 'utf8');
            const parsed: unknown = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                return parsed as GitHubConfigFile;
            }
        } catch {
            // Sin archivo o JSON corrupto: no hay token de archivo.
        }
        return {};
    }

    private assertRepo(repo: string): void {
        // `.` o `..` como segmento alterarían la ruta de la API al normalizar la URL.
        if (typeof repo !== 'string' || !REPO_RE.test(repo) || repo.split('/').some(part => /^\.+$/.test(part))) {
            throw new Error('Repositorio inválido, usa owner/nombre');
        }
    }

    private assertState(state: string): 'open' | 'closed' | 'all' {
        if (state !== 'open' && state !== 'closed' && state !== 'all') {
            throw new Error('Estado inválido, usa open, closed o all');
        }
        return state;
    }

    private assertProjectId(id: string): void {
        if (!PROJECT_ID_RE.test(id)) {
            throw new Error('Identificador de proyecto inválido');
        }
    }

    private assertPositiveInt(value: number, label: string): void {
        if (!Number.isInteger(value) || value <= 0) {
            throw new Error(`El ${label} debe ser un entero positivo`);
        }
    }

    private async getJson<T>(path: string, query?: Record<string, string>): Promise<T> {
        const response = await this.request(path, query);
        try {
            return await response.json() as T;
        } catch {
            throw new Error(`GitHub devolvió una respuesta que no es JSON en ${path}`);
        }
    }

    private async fetchAllPages<T>(path: string, query?: Record<string, string>, maxPages: number = DEFAULT_MAX_PAGES): Promise<T[]> {
        const cacheKey = this.buildCacheKey(path, query);
        const cached = this.pagesCache.get(cacheKey);
        if (cached && cached.expires > Date.now()) {
            return cached.items as T[];
        }

        const items: T[] = [];
        const params: Record<string, string> = { per_page: '100', ...(query ?? {}) };
        let next: string | undefined = this.buildUrl(path, params);

        for (let page = 0; page < maxPages && next; page++) {
            const response = await this.requestUrl(next);
            const data: unknown = await response.json();
            if (Array.isArray(data)) {
                items.push(...(data as T[]));
            }
            next = this.nextLink(response);
        }

        this.pagesCache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, items });
        return items;
    }

    private async request(path: string, query?: Record<string, string>): Promise<Response> {
        return this.requestUrl(this.buildUrl(path, query));
    }

    private async requestUrl(url: string): Promise<Response> {
        const token = await this.resolveToken();
        if (!token) {
            throw new Error('Falta configurar el token de GitHub');
        }

        const path = new URL(url).pathname;
        let response: Awaited<ReturnType<typeof fetch>>;
        try {
            response = await fetch(url, {
                method: 'GET',
                headers: this.authHeaders(token),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
        } catch (err) {
            throw new Error(`No se pudo conectar con GitHub: ${err instanceof Error ? err.message : String(err)}`);
        }

        this.assertOk(response, path);
        return response;
    }

    private async graphql(query: string, variables?: Record<string, unknown>): Promise<unknown> {
        if (GRAPHQL_MUTATION_RE.test(query)) {
            throw new Error('Operación no permitida: la integración con GitHub es de solo lectura.');
        }

        const token = await this.resolveToken();
        if (!token) {
            throw new Error('Falta configurar el token de GitHub');
        }

        let response: Awaited<ReturnType<typeof fetch>>;
        try {
            response = await fetch(`${API_BASE}/graphql`, {
                method: 'POST',
                headers: { ...this.authHeaders(token), 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, variables }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
        } catch (err) {
            throw new Error(`No se pudo conectar con GitHub: ${err instanceof Error ? err.message : String(err)}`);
        }

        this.assertOk(response, '/graphql');

        const data: unknown = await response.json();
        const errors = (data as { errors?: unknown[] } | undefined)?.errors;
        if (Array.isArray(errors) && errors.length > 0) {
            const first = errors[0] as { message?: string } | undefined;
            throw new Error(first?.message || 'GitHub GraphQL devolvió un error');
        }
        return data;
    }

    private assertOk(response: Response, path: string): void {
        if (response.status === 401) {
            throw new Error('GitHub rechazó el token (HTTP 401)');
        }
        const remaining = response.headers.get('x-ratelimit-remaining');
        if (response.status === 429 || (response.status === 403 && remaining === '0')) {
            throw new Error('GitHub limitó las peticiones (límite alcanzado). Espera un rato y vuelve a intentarlo.');
        }
        if (response.status === 404) {
            throw new Error(`GitHub respondió HTTP 404 en ${path} (¿repositorio correcto y token con acceso?)`);
        }
        if (!response.ok) {
            throw new Error(`GitHub respondió HTTP ${response.status} en ${path}`);
        }
    }

    private nextLink(response: Response): string | undefined {
        const link = response.headers.get('link');
        if (!link) {
            return undefined;
        }
        const match = link.match(/<([^>]+)>\s*;\s*rel="next"/);
        if (!match) {
            return undefined;
        }
        try {
            const parsed = new URL(match[1]);
            if (parsed.origin !== API_ORIGIN) {
                return undefined;
            }
            return parsed.href;
        } catch {
            return undefined;
        }
    }

    private buildUrl(path: string, query?: Record<string, string>): string {
        const base = `${API_BASE}${path}`;
        if (!query || Object.keys(query).length === 0) {
            return base;
        }
        return `${base}?${new URLSearchParams(query).toString()}`;
    }

    private buildCacheKey(path: string, query?: Record<string, string>): string {
        if (!query || Object.keys(query).length === 0) {
            return path;
        }
        const sorted = Object.keys(query).sort().map(key => `${key}=${query[key]}`).join('&');
        return `${path}?${sorted}`;
    }

    private authHeaders(token: string): Record<string, string> {
        return {
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'Fokkus-IDE',
            Accept: 'application/vnd.github.html+json'
        };
    }
}
