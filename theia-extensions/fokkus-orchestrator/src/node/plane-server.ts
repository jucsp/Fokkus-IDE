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
import { injectable } from '@theia/core/shared/inversify';
import {
    PlaneConfigInput,
    PlaneConfigStatus,
    PlaneIssue,
    PlaneIssueQuery,
    PlaneMember,
    PlaneModule,
    PlaneProject,
    PlaneServer,
    splitIssueName
} from '../common/plane-protocol';

const CONFIG_DIR = join(os.homedir(), '.fokkus');
const CONFIG_PATH = join(CONFIG_DIR, 'plane.json');
const DEFAULT_BASE_URL = 'https://plane.garagelabs.cl';
const DEFAULT_WORKSPACE = 'garage-labs';
const REQUEST_TIMEOUT_MS = 20000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_CACHE_MAX = 50;
const MAX_PAGES = 50;
const MAX_REDIRECTS = 5;
/** Plane limita la API Key (~60 peticiones/min): cambiar solo el usuario no vuelve a descargar las páginas del proyecto. */
const PAGES_CACHE_TTL_MS = 30000;
const UUID_RE = /^[0-9a-f-]{36}$/i;

interface PlaneConfigFile {
    baseUrl?: string;
    workspace?: string;
    apiKey?: string;
}

interface ResolvedConfig {
    baseUrl: string;
    workspace: string;
    apiKey: string;
}

interface PlaneApiMember {
    id: string;
    first_name?: string;
    last_name?: string;
    email?: string;
    display_name?: string;
}

interface PlaneApiProject {
    id: string;
    name?: string;
    identifier?: string;
}

interface PlaneApiModule {
    id: string;
    name?: string;
    status?: string;
}

interface PlaneApiIssue {
    id: string;
    name?: string;
    description_html?: string;
    estimate_point?: string | null;
    point?: number | null;
    assignees?: string[];
    sequence_id?: number;
    archived_at?: string | null;
    deleted_at?: string | null;
}

@injectable()
export class PlaneServerImpl implements PlaneServer {
    private readonly imageCache = new Map<string, string>();
    private cachedProjects?: PlaneProject[];
    private readonly pagesCache = new Map<string, { expires: number; items: unknown[] }>();

    async getConfig(): Promise<PlaneConfigStatus> {
        const config = await this.resolveConfig();
        return {
            baseUrl: config.baseUrl,
            workspace: config.workspace,
            hasApiKey: !!config.apiKey
        };
    }

    async saveConfig(input: PlaneConfigInput): Promise<PlaneConfigStatus> {
        const baseUrl = this.validateBaseUrl(input.baseUrl);
        const workspace = this.validateWorkspace(input.workspace);
        // Se conserva la key del archivo, nunca la de PLANE_API_KEY: la variable de entorno no se persiste.
        const current = await this.loadConfigFile();
        const apiKey = (input.apiKey ?? '').trim() || (current.apiKey ?? '').trim();

        const file: PlaneConfigFile = { baseUrl, workspace };
        if (apiKey) {
            file.apiKey = apiKey;
        }

        await fs.mkdir(CONFIG_DIR, { recursive: true });
        await fs.writeFile(CONFIG_PATH, JSON.stringify(file, undefined, 4) + '\n', { mode: 0o600 });
        // `mode` solo aplica al crear el archivo; si ya existía con otros permisos, se corrigen.
        await fs.chmod(CONFIG_PATH, 0o600);
        this.cachedProjects = undefined;
        this.imageCache.clear();
        this.pagesCache.clear();

        const resolved = await this.resolveConfig();
        return { baseUrl: resolved.baseUrl, workspace: resolved.workspace, hasApiKey: !!resolved.apiKey };
    }

    async listMembers(): Promise<PlaneMember[]> {
        const raw = await this.getAllPages<PlaneApiMember>('members/');
        return raw.map(member => ({
            id: member.id,
            displayName: member.display_name || member.email || member.id,
            fullName: [member.first_name, member.last_name].filter(Boolean).join(' ').trim() || member.display_name || '',
            email: member.email || ''
        }));
    }

    async listProjects(): Promise<PlaneProject[]> {
        const raw = await this.getAllPages<PlaneApiProject>('projects/');
        this.cachedProjects = raw.map(project => ({
            id: project.id,
            name: project.name ?? '',
            identifier: project.identifier ?? ''
        }));
        return this.cachedProjects;
    }

    async listModules(projectId: string): Promise<PlaneModule[]> {
        this.assertUuid(projectId, 'proyecto');
        const raw = await this.getAllPages<PlaneApiModule>(`projects/${projectId}/modules/`);
        return raw.map(module => ({
            id: module.id,
            name: module.name ?? '',
            ...(module.status ? { status: module.status } : {})
        }));
    }

    async listIssues(query: PlaneIssueQuery): Promise<PlaneIssue[]> {
        this.assertUuid(query.projectId, 'proyecto');
        this.assertUuid(query.assigneeId, 'usuario');

        let path: string;
        if (query.moduleId) {
            this.assertUuid(query.moduleId, 'módulo');
            path = `projects/${query.projectId}/modules/${query.moduleId}/module-issues/`;
        } else {
            path = `projects/${query.projectId}/issues/`;
        }

        const raw = await this.getAllPages<PlaneApiIssue>(path);
        const identifier = await this.getProjectIdentifier(query.projectId);

        const issues: PlaneIssue[] = [];
        for (const issue of raw) {
            if (issue.archived_at || issue.deleted_at) {
                continue;
            }
            if (!Array.isArray(issue.assignees) || !issue.assignees.includes(query.assigneeId)) {
                continue;
            }

            const sequenceId = typeof issue.sequence_id === 'number' ? issue.sequence_id : undefined;
            const fallbackCode = `${identifier}-${sequenceId ?? ''}`;
            const { code, title } = splitIssueName(issue.name ?? '', fallbackCode);

            const estimateRaw = issue.estimate_point ?? issue.point;
            const estimate = (estimateRaw === null || estimateRaw === undefined || estimateRaw === '') // eslint-disable-line no-null/no-null
                ? undefined
                : String(estimateRaw);

            issues.push({
                id: issue.id,
                projectId: query.projectId,
                code,
                title,
                ...(estimate !== undefined ? { estimate } : {}),
                descriptionHtml: issue.description_html ?? '',
                ...(sequenceId !== undefined ? { sequenceId } : {})
            });
        }

        issues.sort((a, b) => (b.sequenceId ?? 0) - (a.sequenceId ?? 0));
        return issues;
    }

    async fetchImage(url: string): Promise<string | undefined> {
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
                return undefined;
            }

            const cached = this.imageCache.get(url);
            if (cached) {
                return cached;
            }

            const config = await this.resolveConfig();
            const planeOrigin = new URL(config.baseUrl).origin;

            // Las redirecciones se siguen a mano: fetch solo quita `Authorization` al cambiar de origen,
            // así que con redirect 'follow' la X-Api-Key llegaría también al destino (p. ej. un bucket S3).
            let target = parsed;
            let response: Awaited<ReturnType<typeof fetch>> | undefined;
            for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
                const headers: Record<string, string> = { Accept: 'image/*' };
                if (target.origin === planeOrigin && config.apiKey) {
                    headers['X-Api-Key'] = config.apiKey;
                }
                response = await fetch(target.href, {
                    method: 'GET',
                    headers,
                    redirect: 'manual',
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
                });
                const location = response.headers.get('location');
                if (response.status < 300 || response.status >= 400 || !location) {
                    break;
                }
                target = new URL(location, target);
                if (target.protocol !== 'https:' && target.protocol !== 'http:') {
                    return undefined;
                }
                response = undefined;
            }
            if (!response || !response.ok) {
                return undefined;
            }

            const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
            if (!mime.startsWith('image/')) {
                return undefined;
            }

            const contentLength = Number(response.headers.get('content-length') || '0');
            if (contentLength > MAX_IMAGE_BYTES) {
                return undefined;
            }

            const buffer = new Uint8Array(await response.arrayBuffer());
            if (buffer.byteLength > MAX_IMAGE_BYTES) {
                return undefined;
            }

            const dataUri = `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`;
            return this.cacheImage(url, dataUri);
        } catch {
            return undefined;
        }
    }

    private async resolveConfig(): Promise<ResolvedConfig> {
        const file = await this.loadConfigFile();
        return {
            baseUrl: (process.env.PLANE_BASE_URL || file.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, ''),
            workspace: (process.env.PLANE_WORKSPACE || file.workspace || DEFAULT_WORKSPACE).trim(),
            apiKey: (process.env.PLANE_API_KEY || file.apiKey || '').trim()
        };
    }

    private async loadConfigFile(): Promise<PlaneConfigFile> {
        try {
            const raw = await fs.readFile(CONFIG_PATH, 'utf8');
            const parsed: unknown = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                return parsed as PlaneConfigFile;
            }
        } catch {
            // Sin archivo o JSON corrupto: usar valores por defecto.
        }
        return {};
    }

    private validateBaseUrl(raw: string): string {
        const baseUrl = (raw || '').trim().replace(/\/+$/, '');
        let parsed: URL;
        try {
            parsed = new URL(baseUrl);
        } catch {
            throw new Error('La Base URL de Plane no es válida');
        }

        const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
        if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
            throw new Error('La Base URL debe usar https (o http solo en localhost)');
        }
        return baseUrl;
    }

    private validateWorkspace(raw: string): string {
        const workspace = (raw || '').trim();
        if (!/^[a-z0-9_-]+$/i.test(workspace)) {
            throw new Error('El workspace solo admite letras, números, guiones y guiones bajos');
        }
        return workspace;
    }

    private assertUuid(id: string, label: string): void {
        if (!UUID_RE.test(id)) {
            throw new Error(`Identificador inválido para ${label}`);
        }
    }

    private buildApiUrl(config: ResolvedConfig, path: string, query?: Record<string, string>): string {
        const base = `${config.baseUrl}/api/v1/workspaces/${encodeURIComponent(config.workspace)}/${path}`;
        if (!query || Object.keys(query).length === 0) {
            return base;
        }
        return `${base}?${new URLSearchParams(query).toString()}`;
    }

    private async getJson(path: string, query?: Record<string, string>): Promise<unknown> {
        const config = await this.resolveConfig();
        if (!config.apiKey) {
            throw new Error('Falta configurar la API Key de Plane');
        }

        const url = this.buildApiUrl(config, path, query);
        let response: Awaited<ReturnType<typeof fetch>>;
        try {
            response = await fetch(url, {
                method: 'GET',
                headers: { 'X-Api-Key': config.apiKey, Accept: 'application/json' },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            });
        } catch (err) {
            throw new Error(`No se pudo conectar con Plane: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (response.status === 429) {
            throw new Error('Plane limitó las peticiones (HTTP 429). Espera un minuto y vuelve a aplicar los filtros.');
        }
        if (response.status === 401 || response.status === 403) {
            throw new Error(`Plane rechazó la API Key (HTTP ${response.status})`);
        }
        if (!response.ok) {
            throw new Error(`Plane respondió HTTP ${response.status} en ${path}`);
        }
        try {
            return await response.json();
        } catch {
            throw new Error(`Plane devolvió una respuesta que no es JSON en ${path}`);
        }
    }

    private async getAllPages<T>(path: string): Promise<T[]> {
        const cached = this.pagesCache.get(path);
        if (cached && cached.expires > Date.now()) {
            return cached.items as T[];
        }
        const items = await this.fetchAllPages<T>(path);
        this.pagesCache.set(path, { expires: Date.now() + PAGES_CACHE_TTL_MS, items });
        return items;
    }

    private async fetchAllPages<T>(path: string): Promise<T[]> {
        const items: T[] = [];
        let cursor: string | undefined;
        let pages = 0;

        while (true) {
            pages++;
            if (pages > MAX_PAGES) {
                break;
            }

            const query: Record<string, string> = { per_page: '100' };
            if (cursor) {
                query.cursor = cursor;
            }

            const data: unknown = await this.getJson(path, query);
            if (Array.isArray(data)) {
                items.push(...(data as T[]));
                break;
            }

            if (data && typeof data === 'object') {
                const page = data as { results?: unknown; next_cursor?: unknown; next_page_results?: unknown };
                if (Array.isArray(page.results)) {
                    items.push(...(page.results as T[]));
                }
                if (page.next_page_results === true && typeof page.next_cursor === 'string' && page.next_cursor) {
                    cursor = page.next_cursor;
                    continue;
                }
            }
            break;
        }

        return items;
    }

    private async getProjectIdentifier(projectId: string): Promise<string> {
        let identifier = this.cachedProjects?.find(project => project.id === projectId)?.identifier;
        if (identifier === undefined) {
            try {
                this.cachedProjects = await this.listProjects();
                identifier = this.cachedProjects.find(project => project.id === projectId)?.identifier;
            } catch {
                // Sin identificador el código cae a `-<sequence_id>`; se reintenta en la próxima consulta.
            }
        }
        return identifier ?? '';
    }

    private cacheImage(url: string, dataUri: string): string {
        if (this.imageCache.size >= IMAGE_CACHE_MAX) {
            const oldest = this.imageCache.keys().next().value;
            if (oldest !== undefined) {
                this.imageCache.delete(oldest);
            }
        }
        this.imageCache.set(url, dataUri);
        return dataUri;
    }
}
