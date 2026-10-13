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
import { TriageConfigService } from '../triage-config';
import { arr, prop, str, triageFetch, triageJson, TriageHttpError } from '../triage-http';
import { apiMessage, hasTriageIdMarker, isOnOrAfterReceivedAt, TargetAdapter, TargetCreateInput, TargetCreateResult, textToAdf, TtlCache } from './target-adapter';

const MAX_PROJECT_PAGES = 5;
const NUMERIC_RE = /^\d+$/;

interface JiraCredentials {
    baseUrl: string;
    authorization: string;
}

class JiraStatusError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

/** Mensaje legible de un error de Jira; incluye los mensajes de validación (nunca contienen credenciales). */
function jiraErrorFromResponse(status: number, body: unknown, action: string): Error {
    if (status === 401) {
        return new Error('Jira rechazó las credenciales (HTTP 401)');
    }
    if (status === 403) {
        return new Error(`Jira denegó el permiso para ${action} (HTTP 403)`);
    }
    if (status === 404) {
        return new Error('Jira no encontró el proyecto o el recurso (HTTP 404)');
    }
    if (status === 429) {
        return new Error('Jira limitó las peticiones (HTTP 429)');
    }
    const messages = [
        ...arr(prop(body, 'errorMessages')).map(m => apiMessage(m)),
        ...Object.values((prop(body, 'errors') as Record<string, unknown> | undefined) ?? {}).map(m => apiMessage(m))
    ].filter(Boolean);
    return new Error(`Jira respondió HTTP ${status} al ${action}${messages.length ? `: ${messages.slice(0, 3).join(' · ')}` : ''}`);
}

/** Destino Jira Cloud (#26 HU-5): Basic email:apiToken, descripción en ADF y sprint opcional. */
export class JiraTarget implements TargetAdapter {
    readonly id = 'jira' as const;
    private readonly containers = new TtlCache<TargetContainer[]>();
    private readonly options = new TtlCache<TargetOptionGroup[]>();

    constructor(protected readonly config: TriageConfigService) { }

    clearCache(): void {
        this.containers.clear();
        this.options.clear();
    }

    async status(): Promise<TargetProviderStatus> {
        const configured = !!(await this.credentials());
        return {
            id: 'jira',
            label: TARGET_PROVIDER_LABELS.jira,
            configured,
            ...(configured ? {} : { message: 'Configura Jira en «Fuentes y conexiones»' }),
            containerLabel: 'Proyecto'
        };
    }

    listContainers(): Promise<TargetContainer[]> {
        return this.containers.get('projects', async () => {
            const creds = await this.required();
            const projects: TargetContainer[] = [];
            let startAt = 0;
            for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
                const data = await this.get(creds, '/rest/api/3/project/search', { maxResults: '100', startAt: String(startAt) }, 'listar los proyectos');
                const values = arr(prop(data, 'values'));
                for (const project of values) {
                    const id = str(prop(project, 'id'));
                    if (id && NUMERIC_RE.test(id)) {
                        projects.push({ id, name: str(prop(project, 'name')) ?? id, ...(str(prop(project, 'key')) ? { key: str(prop(project, 'key')) } : {}) });
                    }
                }
                startAt += values.length;
                if (prop(data, 'isLast') !== false || values.length === 0) {
                    break;
                }
            }
            return projects;
        });
    }

    listOptions(containerId: string): Promise<TargetOptionGroup[]> {
        this.assertNumeric(containerId, 'proyecto');
        return this.options.get(containerId, async () => {
            const creds = await this.required();
            const [types, project] = await Promise.all([
                this.get(creds, '/rest/api/3/issuetype/project', { projectId: containerId }, 'listar los tipos de issue'),
                this.get(creds, `/rest/api/3/project/${containerId}`, {}, 'leer el proyecto')
            ]);
            const issueTypes: TargetOption[] = arr(types)
                .filter(t => prop(t, 'subtask') !== true)
                .map(t => ({ id: str(prop(t, 'id')) ?? '', name: str(prop(t, 'name')) ?? '' }))
                .filter(t => t.id);
            const defaultType = issueTypes.find(t => /^(task|tarea)$/i.test(t.name));
            const components: TargetOption[] = arr(prop(project, 'components'))
                .map(c => ({ id: str(prop(c, 'id')) ?? '', name: str(prop(c, 'name')) ?? '' }))
                .filter(c => c.id);
            const projectKey = str(prop(project, 'key')) ?? containerId;
            return [
                {
                    kind: 'issue-type', label: 'Tipo de issue', multiple: false, required: true, options: issueTypes,
                    ...(defaultType ? { defaultOptionId: defaultType.id } : {})
                },
                { kind: 'component', label: 'Componentes', multiple: true, required: false, options: components },
                { kind: 'sprint', label: 'Sprint', multiple: false, required: false, options: await this.sprints(creds, projectKey) }
            ];
        });
    }

    async create(input: TargetCreateInput): Promise<TargetCreateResult> {
        this.assertNumeric(input.containerId, 'proyecto');
        const creds = await this.required();
        const issueType = input.selections['issue-type']?.[0];
        if (!issueType) {
            throw new Error('Falta elegir el tipo de issue');
        }
        const existing = await this.findExisting(input, creds);
        if (existing) {
            return existing;
        }
        const components = input.selections.component ?? [];
        const response = await triageFetch({
            method: 'POST',
            url: `${creds.baseUrl}/rest/api/3/issue`,
            headers: this.headers(creds),
            body: JSON.stringify({
                fields: {
                    project: { id: input.containerId },
                    issuetype: { id: issueType },
                    summary: input.title,
                    description: textToAdf(input.body),
                    ...(components.length ? { components: components.map(id => ({ id })) } : {})
                }
            })
        });
        const body = await response.json().catch(() => ({}));
        if (response.status < 200 || response.status >= 300) {
            throw jiraErrorFromResponse(response.status, body, 'crear el issue');
        }
        const key = str(prop(body, 'key'));
        if (!key) {
            throw new Error('Jira no devolvió la clave del issue creado');
        }
        const ticket = { provider: 'jira' as const, containerId: input.containerId, key, url: `${creds.baseUrl}/browse/${encodeURIComponent(key)}` };

        const sprint = input.selections.sprint?.[0];
        if (sprint) {
            try {
                this.assertNumeric(sprint, 'sprint');
                await triageJson({
                    method: 'POST',
                    url: `${creds.baseUrl}/rest/agile/1.0/sprint/${sprint}/issue`,
                    headers: this.headers(creds),
                    body: JSON.stringify({ issues: [key] })
                }, 'Jira');
            } catch {
                return { ticket, warning: 'Ticket creado, pero no se pudo agregar al sprint' };
            }
        }
        return { ticket };
    }

    /** Busca por JQL un issue que ya lleve el marcador de deduplicación; si existe, no se crea. */
    private async findExisting(input: TargetCreateInput, creds: JiraCredentials): Promise<TargetCreateResult | undefined> {
        if (!input.triageId) {
            return undefined;
        }
        try {
            const sinceDate = input.receivedAt && !Number.isNaN(Date.parse(input.receivedAt))
                ? new Date(Date.parse(input.receivedAt) - 5 * 60 * 1000).toISOString().slice(0, 10)
                : undefined;
            const sinceClause = sinceDate ? ` AND created >= "${sinceDate}"` : '';
            const jql = `project = ${input.containerId}${sinceClause} AND description ~ "${input.triageId.replace(/["'\\]/g, ' ')}" ORDER BY created DESC`;
            const data = await this.get(creds, '/rest/api/3/search', { jql, maxResults: '50', fields: 'summary,description,created' }, 'buscar el issue existente');
            for (const issue of arr(prop(data, 'issues'))) {
                const fields = prop(issue, 'fields');
                if (!isOnOrAfterReceivedAt(str(prop(fields, 'created')), input.receivedAt)) {
                    continue;
                }
                if (!hasTriageIdMarker(prop(fields, 'description'), input.triageId)) {
                    continue;
                }
                const key = str(prop(issue, 'key'));
                if (!key) {
                    continue;
                }
                const ticket = { provider: 'jira' as const, containerId: input.containerId, key, url: `${creds.baseUrl}/browse/${encodeURIComponent(key)}` };
                return { ticket, warning: `El ticket ya existía en el backlog (${ticket.key}); se vinculó sin duplicarlo` };
            }
        } catch {
            // Si el GET de search falla, se continúa con la creación normal.
        }
        return undefined;
    }

    async test(): Promise<TriageConnectionTestResult> {
        const creds = await this.credentials();
        if (!creds) {
            return { target: 'jira', ok: false, message: 'No hay credenciales configuradas' };
        }
        try {
            const me = await this.get(creds, '/rest/api/3/myself', {}, 'conectar');
            const name = str(prop(me, 'displayName')) ?? str(prop(me, 'emailAddress')) ?? '';
            if (name) {
                await this.config.rememberIdentity('jira', name);
            }
            return { target: 'jira', ok: true, status: 200, ...(name ? { identity: name } : {}), message: `Conectado a Jira como ${name || 'usuario'}` };
        } catch (err) {
            const status = err instanceof JiraStatusError ? err.status : undefined;
            return { target: 'jira', ok: false, ...(status ? { status } : {}), message: err instanceof Error ? err.message : 'No se pudo conectar con Jira' };
        }
    }

    private async sprints(creds: JiraCredentials, projectKey: string): Promise<TargetOption[]> {
        try {
            const boards = arr(prop(await triageJson({
                method: 'GET',
                url: `${creds.baseUrl}/rest/agile/1.0/board?${new URLSearchParams({ projectKeyOrId: projectKey, maxResults: '50' }).toString()}`,
                headers: this.headers(creds)
            }, 'Jira'), 'values'));
            const options: TargetOption[] = [];
            for (const board of boards.filter(b => str(prop(b, 'type')) === 'scrum').slice(0, 10)) {
                const boardId = prop(board, 'id');
                if (typeof boardId !== 'number') {
                    continue;
                }
                const sprints = arr(prop(await triageJson({
                    method: 'GET',
                    url: `${creds.baseUrl}/rest/agile/1.0/board/${boardId}/sprint?state=active,future`,
                    headers: this.headers(creds)
                }, 'Jira'), 'values'));
                for (const sprint of sprints) {
                    const id = prop(sprint, 'id');
                    if (typeof id === 'number' && !options.some(o => o.id === String(id))) {
                        const state = str(prop(sprint, 'state'));
                        const detail = `${str(prop(board, 'name')) ?? 'Tablero'}${state ? ` · ${state}` : ''}`;
                        options.push({ id: String(id), name: str(prop(sprint, 'name')) ?? String(id), detail });
                    }
                }
            }
            return options;
        } catch (err) {
            // Sin Jira Software o sin permisos de agile: grupo vacío, no error.
            if (err instanceof TriageHttpError && (err.status === 403 || err.status === 404 || err.status === 400)) {
                return [];
            }
            throw err;
        }
    }

    private async get(creds: JiraCredentials, path: string, query: Record<string, string>, action: string): Promise<unknown> {
        const qs = new URLSearchParams(query).toString();
        const response = await triageFetch({ method: 'GET', url: `${creds.baseUrl}${path}${qs ? `?${qs}` : ''}`, headers: this.headers(creds) });
        const body = await response.json().catch(() => ({}));
        if (response.status < 200 || response.status >= 300) {
            const error = jiraErrorFromResponse(response.status, body, action);
            throw new JiraStatusError(error.message, response.status);
        }
        return body;
    }

    private headers(creds: JiraCredentials): Record<string, string> {
        return { Authorization: creds.authorization, Accept: 'application/json', 'Content-Type': 'application/json' };
    }

    private async required(): Promise<JiraCredentials> {
        const creds = await this.credentials();
        if (!creds) {
            throw new Error('Configura Jira en «Fuentes y conexiones»');
        }
        return creds;
    }

    private async credentials(): Promise<JiraCredentials | undefined> {
        const file = await this.config.read();
        const token = (await this.config.resolveJiraApiToken()).value;
        if (!file.jira.baseUrl || !file.jira.email || !token) {
            return undefined;
        }
        return { baseUrl: file.jira.baseUrl, authorization: `Basic ${Buffer.from(`${file.jira.email}:${token}`).toString('base64')}` };
    }

    private assertNumeric(id: string, label: string): void {
        if (typeof id !== 'string' || !NUMERIC_RE.test(id)) {
            throw new Error(`Identificador de ${label} de Jira inválido`);
        }
    }
}
