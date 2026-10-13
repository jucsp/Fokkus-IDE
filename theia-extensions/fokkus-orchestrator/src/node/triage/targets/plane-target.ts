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
import { resolvePlaneConfig, ResolvedPlaneConfig } from '../../plane-server';
import { arr, prop, str, triageJson, TriageHttpError } from '../triage-http';
import { hasTriageIdMarker, isOnOrAfterReceivedAt, TargetAdapter, TargetCreateInput, TargetCreateResult, textToHtml, TtlCache } from './target-adapter';

const UUID_RE = /^[0-9a-f-]{36}$/i;
const MAX_PAGES = 10;

function planeError(err: unknown, action: string): Error {
    if (err instanceof TriageHttpError && err.status !== undefined) {
        if (err.status === 401 || err.status === 403) {
            return new Error(`Plane rechazó la API Key (HTTP ${err.status})`);
        }
        if (err.status === 404) {
            return new Error('Plane no encontró el proyecto o el recurso (HTTP 404)');
        }
        if (err.status === 429) {
            return new Error('Plane limitó las peticiones (HTTP 429). Espera un minuto y reintenta.');
        }
        return new Error(`Plane respondió HTTP ${err.status} al ${action}`);
    }
    return err instanceof Error ? err : new Error(`No se pudo ${action} en Plane`);
}

/** Destino Plane (#26 HU-5). Reutiliza la config de «Plane Backlog» (resolvePlaneConfig). */
export class PlaneTarget implements TargetAdapter {
    readonly id = 'plane' as const;
    private readonly containers = new TtlCache<TargetContainer[]>();
    private readonly options = new TtlCache<TargetOptionGroup[]>();

    clearCache(): void {
        this.containers.clear();
        this.options.clear();
    }

    async status(): Promise<TargetProviderStatus> {
        const config = await resolvePlaneConfig();
        return {
            id: 'plane',
            label: TARGET_PROVIDER_LABELS.plane,
            configured: !!config.apiKey,
            ...(config.apiKey ? {} : { message: 'Configura Plane en el panel Plane Backlog' }),
            containerLabel: 'Proyecto'
        };
    }

    listContainers(): Promise<TargetContainer[]> {
        return this.containers.get('projects', async () => {
            const projects = await this.getAll(await this.config(), 'projects/', 'listar los proyectos');
            return projects
                .map(p => ({ id: str(prop(p, 'id')) ?? '', name: str(prop(p, 'name')) ?? '', key: str(prop(p, 'identifier')) || undefined }))
                .filter(p => UUID_RE.test(p.id))
                .map(p => ({ id: p.id, name: p.name || p.id, ...(p.key ? { key: p.key } : {}) }));
        });
    }

    listOptions(containerId: string): Promise<TargetOptionGroup[]> {
        this.assertUuid(containerId);
        return this.options.get(containerId, async () => {
            const config = await this.config();
            const [states, modules, labels] = await Promise.all([
                this.getAll(config, `projects/${containerId}/states/`, 'listar los estados'),
                this.getAll(config, `projects/${containerId}/modules/`, 'listar los módulos'),
                this.getAll(config, `projects/${containerId}/labels/`, 'listar las etiquetas')
            ]);
            const sortedStates = [...states].sort((a, b) => Number(prop(a, 'sequence') ?? 0) - Number(prop(b, 'sequence') ?? 0));
            const stateOptions: TargetOption[] = sortedStates.map(s => this.option(s, str(prop(s, 'group'))));
            const defaultState = sortedStates.find(s => prop(s, 'default') === true)
                ?? sortedStates.find(s => str(prop(s, 'group')) === 'backlog')
                ?? sortedStates.find(s => str(prop(s, 'group')) === 'unstarted');
            const moduleOptions = modules
                .filter(m => !prop(m, 'archived_at'))
                .map(m => this.option(m, str(prop(m, 'status'))));
            return [
                {
                    kind: 'state', label: 'Estado', multiple: false, required: false, options: stateOptions,
                    ...(defaultState && str(prop(defaultState, 'id')) ? { defaultOptionId: str(prop(defaultState, 'id')) } : {})
                },
                { kind: 'module', label: 'Módulo', multiple: false, required: false, options: moduleOptions },
                { kind: 'label', label: 'Etiquetas', multiple: true, required: false, options: labels.map(l => this.option(l)) }
            ];
        });
    }

    async create(input: TargetCreateInput): Promise<TargetCreateResult> {
        this.assertUuid(input.containerId);
        const config = await this.config();
        const existing = await this.findExisting(input, config);
        if (existing) {
            return existing;
        }
        const state = input.selections.state?.[0];
        const labels = input.selections.label ?? [];
        const moduleId = input.selections.module?.[0];
        let created: unknown;
        try {
            created = await triageJson({
                method: 'POST',
                url: this.url(config, `projects/${input.containerId}/issues/`),
                headers: this.headers(config),
                body: JSON.stringify({
                    name: input.title,
                    description_html: textToHtml(input.body),
                    ...(state ? { state } : {}),
                    ...(labels.length ? { labels } : {})
                })
            }, 'Plane');
        } catch (err) {
            throw planeError(err, 'crear el ticket');
        }
        const id = str(prop(created, 'id'));
        if (!id) {
            throw new Error('Plane no devolvió el id del ticket creado');
        }
        const sequence = prop(created, 'sequence_id');
        const identifier = (await this.listContainers().catch((): TargetContainer[] => [])).find(p => p.id === input.containerId)?.key;
        const key = identifier && typeof sequence === 'number' ? `${identifier}-${sequence}` : (typeof sequence === 'number' ? `#${sequence}` : id.slice(0, 8));
        const ticket = {
            provider: 'plane' as const,
            containerId: input.containerId,
            key,
            url: `${config.baseUrl}/${encodeURIComponent(config.workspace)}/projects/${input.containerId}/issues/${id}`
        };

        if (moduleId) {
            try {
                this.assertUuid(moduleId);
                await triageJson({
                    method: 'POST',
                    url: this.url(config, `projects/${input.containerId}/modules/${moduleId}/module-issues/`),
                    headers: this.headers(config),
                    body: JSON.stringify({ issues: [id] })
                }, 'Plane');
            } catch {
                return { ticket, warning: 'Ticket creado, pero no se pudo agregar al módulo' };
            }
        }
        return { ticket };
    }

    /** Busca en el proyecto un issue que ya lleve el marcador de deduplicación; si existe, no se crea. */
    private async findExisting(input: TargetCreateInput, config: ResolvedPlaneConfig): Promise<TargetCreateResult | undefined> {
        if (!input.triageId) {
            return undefined;
        }
        try {
            const issues = await this.getIssuePages(config, input.containerId, input.receivedAt);
            for (const issue of issues) {
                if (!isOnOrAfterReceivedAt(str(prop(issue, 'created_at')), input.receivedAt)) {
                    continue;
                }
                const content = prop(issue, 'description_html') ?? prop(issue, 'description_stripped') ?? prop(issue, 'description');
                if (!hasTriageIdMarker(content, input.triageId)) {
                    continue;
                }
                const id = str(prop(issue, 'id')) ?? '';
                const sequence = prop(issue, 'sequence_id');
                const identifier = (await this.listContainers().catch((): TargetContainer[] => [])).find(p => p.id === input.containerId)?.key;
                const key = identifier && typeof sequence === 'number' ? `${identifier}-${sequence}` : (typeof sequence === 'number' ? `#${sequence}` : id.slice(0, 8));
                const ticket = {
                    provider: 'plane' as const,
                    containerId: input.containerId,
                    key,
                    url: `${config.baseUrl}/${encodeURIComponent(config.workspace)}/projects/${input.containerId}/issues/${id}`
                };
                return { ticket, warning: `El ticket ya existía en el backlog (${ticket.key}); se vinculó sin duplicarlo` };
            }
        } catch {
            // Si el GET de issues falla (p. ej. 404 en un mock), se continúa con la creación normal.
        }
        return undefined;
    }

    /** Página los issues del proyecto y corta si toda la página ya es anterior a `receivedAt`. */
    private async getIssuePages(config: ResolvedPlaneConfig, containerId: string, receivedAt?: string): Promise<unknown[]> {
        const items: unknown[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
            const data = await triageJson({
                method: 'GET',
                url: this.url(config, `projects/${containerId}/issues/`, { per_page: '100', ...(cursor ? { cursor } : {}) }),
                headers: this.headers(config)
            }, 'Plane');
            if (Array.isArray(data)) {
                items.push(...data);
                break;
            }
            const results = arr(prop(data, 'results'));
            items.push(...results);
            if (receivedAt && results.length > 0 && results.every(issue => !isOnOrAfterReceivedAt(str(prop(issue, 'created_at')), receivedAt))) {
                break;
            }
            const next = str(prop(data, 'next_cursor'));
            if (prop(data, 'next_page_results') !== true || !next) {
                break;
            }
            cursor = next;
        }
        return items;
    }

    async test(): Promise<TriageConnectionTestResult> {
        const config = await resolvePlaneConfig();
        if (!config.apiKey) {
            return { target: 'plane', ok: false, message: 'No hay credenciales configuradas' };
        }
        try {
            await triageJson({ method: 'GET', url: this.url(config, 'projects/', { per_page: '1' }), headers: this.headers(config) }, 'Plane');
            return { target: 'plane', ok: true, status: 200, identity: config.workspace, message: `Conectado al workspace ${config.workspace}` };
        } catch (err) {
            const status = err instanceof TriageHttpError ? err.status : undefined;
            return { target: 'plane', ok: false, ...(status ? { status } : {}), message: planeError(err, 'conectar').message };
        }
    }

    private async config(): Promise<ResolvedPlaneConfig> {
        const config = await resolvePlaneConfig();
        if (!config.apiKey) {
            throw new Error('Configura Plane en el panel Plane Backlog');
        }
        return config;
    }

    private option(raw: unknown, detail?: string): TargetOption {
        const color = (str(prop(raw, 'color')) ?? '').replace(/^#/, '');
        return {
            id: str(prop(raw, 'id')) ?? '',
            name: str(prop(raw, 'name')) ?? '',
            ...(/^[0-9a-f]{3,8}$/i.test(color) ? { color } : {}),
            ...(detail ? { detail } : {})
        };
    }

    private url(config: ResolvedPlaneConfig, path: string, query?: Record<string, string>): string {
        const base = `${config.baseUrl}/api/v1/workspaces/${encodeURIComponent(config.workspace)}/${path}`;
        return query ? `${base}?${new URLSearchParams(query).toString()}` : base;
    }

    private headers(config: ResolvedPlaneConfig): Record<string, string> {
        return { 'X-Api-Key': config.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' };
    }

    private async getAll(config: ResolvedPlaneConfig, path: string, action: string): Promise<unknown[]> {
        const items: unknown[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
            let data: unknown;
            try {
                data = await triageJson({
                    method: 'GET',
                    url: this.url(config, path, { per_page: '100', ...(cursor ? { cursor } : {}) }),
                    headers: this.headers(config)
                }, 'Plane');
            } catch (err) {
                throw planeError(err, action);
            }
            if (Array.isArray(data)) {
                items.push(...data);
                break;
            }
            items.push(...arr(prop(data, 'results')));
            const next = str(prop(data, 'next_cursor'));
            if (prop(data, 'next_page_results') !== true || !next) {
                break;
            }
            cursor = next;
        }
        return items;
    }

    private assertUuid(id: string): void {
        if (typeof id !== 'string' || !UUID_RE.test(id)) {
            throw new Error('Identificador de Plane inválido');
        }
    }
}
