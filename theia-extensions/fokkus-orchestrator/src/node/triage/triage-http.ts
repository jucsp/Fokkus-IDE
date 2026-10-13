/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { resolvePlaneConfig } from '../plane-server';
import { readJiraBaseUrl } from './triage-config';

const DEFAULT_TIMEOUT_MS = 20000;

/** Error HTTP saneado: nunca contiene secretos ni el cuerpo de la petición. */
export class TriageHttpError extends Error {
    status?: number;
    /** Solo en 429: milisegundos que pide esperar el servidor (Retry-After). */
    retryAfterMs?: number;

    constructor(message: string, status?: number, retryAfterMs?: number) {
        super(message);
        this.name = 'TriageHttpError';
        this.status = status;
        this.retryAfterMs = retryAfterMs;
    }
}

export type TriageHttpMethod = 'GET' | 'POST';

export interface TriageHttpRequest {
    method: TriageHttpMethod;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
}

export interface TriageHttpResponse {
    status: number;
    headers: Headers;
    json(): Promise<unknown>;
    text(): Promise<string>;
}

/** Origen permitido de una regla: fijo o resuelto en tiempo de llamada (Plane/Jira dependen de la config). */
interface AllowedOrigin {
    origin: string;
    /** Prefijo de ruta de la base URL configurada (sin `/` final). */
    basePath: string;
    /** Solo Plane: workspace configurado, para fijar la ruta. */
    workspace?: string;
}

interface AllowRule {
    service: string;
    method: TriageHttpMethod;
    resolve(): Promise<AllowedOrigin | undefined>;
    path(origin: AllowedOrigin): RegExp;
}

const UUID = '[0-9a-fA-F-]{36}';
const GH_NAME = '[A-Za-z0-9_.-]+';
const fixed = (origin: string) => async (): Promise<AllowedOrigin> => ({ origin, basePath: '' });

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isLocalHost(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Valida y descompone una base URL configurada: HTTPS (o http solo en localhost). */
function parseConfiguredBase(raw: string | undefined): { origin: string; basePath: string } | undefined {
    if (!raw) {
        return undefined;
    }
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) {
            return undefined;
        }
        return { origin: url.origin, basePath: url.pathname.replace(/\/+$/, '') };
    } catch {
        return undefined;
    }
}

async function planeOrigin(): Promise<AllowedOrigin | undefined> {
    const config = await resolvePlaneConfig();
    const base = parseConfiguredBase(config.baseUrl);
    return base && config.workspace ? { ...base, workspace: config.workspace } : undefined;
}

async function jiraOrigin(): Promise<AllowedOrigin | undefined> {
    return parseConfiguredBase(await readJiraBaseUrl());
}

function planePath(rest: string): (origin: AllowedOrigin) => RegExp {
    return origin => new RegExp(`^${escapeRegExp(origin.basePath)}/api/v1/workspaces/${escapeRegExp(encodeURIComponent(origin.workspace ?? ''))}/${rest}$`);
}

function jiraPath(rest: string): (origin: AllowedOrigin) => RegExp {
    return origin => new RegExp(`^${escapeRegExp(origin.basePath)}${rest}$`);
}

/** Lista blanca: todo lo que no esté aquí (host + método + ruta) se rechaza antes de tocar la red. */
const ALLOWLIST: readonly AllowRule[] = [
    {
        service: 'Slack', method: 'GET', resolve: fixed('https://slack.com'),
        path: () => /^\/api\/(auth\.test|conversations\.history|conversations\.replies|conversations\.info|users\.info|chat\.getPermalink)$/
    },
    { service: 'Google', method: 'POST', resolve: fixed('https://oauth2.googleapis.com'), path: () => /^\/token$/ },
    {
        service: 'Gmail', method: 'GET', resolve: fixed('https://gmail.googleapis.com'),
        path: () => /^\/gmail\/v1\/users\/me\/(profile|labels|threads|threads\/[A-Za-z0-9]+|messages\/[A-Za-z0-9]+)$/
    },
    {
        service: 'GitHub', method: 'GET', resolve: fixed('https://api.github.com'),
        path: () => new RegExp(`^/(user|user/repos|repos/${GH_NAME}/${GH_NAME}/(labels|milestones|issues))$`)
    },
    { service: 'GitHub', method: 'POST', resolve: fixed('https://api.github.com'), path: () => new RegExp(`^/repos/${GH_NAME}/${GH_NAME}/issues$`) },
    { service: 'Plane', method: 'GET', resolve: planeOrigin, path: planePath(`projects/(${UUID}/(states|modules|labels|issues)/)?`) },
    { service: 'Plane', method: 'POST', resolve: planeOrigin, path: planePath(`projects/${UUID}/(issues|modules/${UUID}/module-issues)/`) },
    {
        service: 'Jira', method: 'GET', resolve: jiraOrigin,
        path: jiraPath('/rest/(api/3/(myself|search|search/jql|project/search|project/[A-Za-z0-9_-]+|issuetype/project)|agile/1\\.0/(board|board/\\d+/sprint))')
    },
    { service: 'Jira', method: 'POST', resolve: jiraOrigin, path: jiraPath('/rest/(api/3/issue|agile/1\\.0/sprint/\\d+/issue)') }
];

/** Devuelve el servicio (para mensajes) si la petición está permitida; si no, lanza. */
export async function assertAllowed(method: string, rawUrl: string): Promise<string> {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new TriageHttpError('Operación de red no permitida');
    }
    if (!url.username && !url.password && !url.hash) {
        for (const rule of ALLOWLIST) {
            if (rule.method !== method) {
                continue;
            }
            const origin = await rule.resolve();
            if (origin && origin.origin === url.origin && rule.path(origin).test(url.pathname)) {
                return rule.service;
            }
        }
    }
    throw new TriageHttpError('Operación de red no permitida');
}

function parseRetryAfter(value: string | null): number | undefined { // eslint-disable-line no-null/no-null
    if (!value) {
        return undefined;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.round(seconds * 1000);
    }
    const date = Date.parse(value);
    return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Única puerta de red de la Bandeja. Valida la lista blanca, no sigue redirecciones y corta por timeout. */
export async function triageFetch(req: TriageHttpRequest): Promise<TriageHttpResponse> {
    const method = req.method;
    if (method !== 'GET' && method !== 'POST') {
        throw new TriageHttpError('Operación de red no permitida');
    }
    const service = await assertAllowed(method, req.url);
    let response: Response;
    try {
        response = await fetch(req.url, {
            method,
            headers: { ...(req.headers ?? {}), 'User-Agent': 'Fokkus-IDE' },
            ...(method === 'POST' && req.body !== undefined ? { body: req.body } : {}),
            redirect: 'error',
            signal: AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        });
    } catch {
        throw new TriageHttpError(`No se pudo conectar con ${service}`);
    }
    return {
        status: response.status,
        headers: response.headers,
        json: async () => {
            try {
                return await response.json();
            } catch {
                throw new TriageHttpError(`${service} devolvió una respuesta que no es JSON`, response.status);
            }
        },
        text: () => response.text()
    };
}

/**
 * GET/POST que exige 2xx y devuelve el JSON. En 429 expone retryAfterMs; el resto de códigos
 * se convierten en `TriageHttpError` con el status, para que cada fuente/destino elija el mensaje.
 */
export async function triageJson(req: TriageHttpRequest, service: string): Promise<unknown> {
    const response = await triageFetch(req);
    if (response.status === 429) {
        throw new TriageHttpError(`${service} limitó las peticiones (HTTP 429)`, 429, parseRetryAfter(response.headers.get('retry-after')));
    }
    if (response.status < 200 || response.status >= 300) {
        throw new TriageHttpError(`${service} respondió HTTP ${response.status}`, response.status);
    }
    if (response.status === 204) {
        return {};
    }
    return response.json();
}

/** Lee una propiedad de un objeto desconocido. */
export function prop(value: unknown, key: string): unknown {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
}

export function str(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

export function arr(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}
