/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    TargetContainer,
    TargetOptionGroup,
    TargetProviderId,
    TargetProviderStatus,
    TargetSelections,
    TRIAGE_CATEGORIES,
    TriageConnectionTestResult,
    TriageItem,
    TriageTicketRef
} from '../../../common/triage-protocol';

const CACHE_TTL_MS = 60000;

export interface TargetCreateInput {
    containerId: string;
    title: string;
    body: string;
    selections: TargetSelections;
    /** ID de la solicitud de la bandeja, para la deduplicación remota en el destino. */
    triageId?: string;
    /** ISO 8601 de `item.receivedAt`, para filtrar tickets antiguos en la deduplicación. */
    receivedAt?: string;
}

/** Resultado de `create`: el ticket y, si un paso secundario falló (módulo/sprint), un aviso. */
export interface TargetCreateResult {
    ticket: TriageTicketRef;
    warning?: string;
}

/** Destino agnóstico de la Bandeja. La UI solo conoce `TargetOptionGroup`. */
export interface TargetAdapter {
    readonly id: TargetProviderId;
    status(): Promise<TargetProviderStatus>;
    listContainers(): Promise<TargetContainer[]>;
    listOptions(containerId: string): Promise<TargetOptionGroup[]>;
    create(input: TargetCreateInput): Promise<TargetCreateResult>;
    test(): Promise<TriageConnectionTestResult>;
    clearCache(): void;
}

/** Caché simple con TTL de 60 s para contenedores y opciones. */
export class TtlCache<T> {
    private readonly entries = new Map<string, { expires: number; value: Promise<T> }>();

    get(key: string, load: () => Promise<T>): Promise<T> {
        const cached = this.entries.get(key);
        if (cached && cached.expires > Date.now()) {
            return cached.value;
        }
        const value = load();
        this.entries.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
        value.catch(() => this.entries.delete(key));
        return value;
    }

    clear(): void {
        this.entries.clear();
    }
}

export function escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Texto → HTML seguro: párrafos por línea en blanco, `<br>` por salto simple. */
export function textToHtml(text: string): string {
    const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    if (paragraphs.length === 0) {
        return '<p></p>';
    }
    return paragraphs.map(p => `<p>${p.split('\n').map(escapeHtml).join('<br>')}</p>`).join('');
}

export interface AdfNode {
    type: string;
    text?: string;
    content?: AdfNode[];
    version?: number;
}

/** Texto → Atlassian Document Format (párrafos + hardBreak). */
export function textToAdf(text: string): AdfNode {
    const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    const content: AdfNode[] = paragraphs.map(paragraph => {
        const nodes: AdfNode[] = [];
        paragraph.split('\n').forEach((line, index) => {
            if (index > 0) {
                nodes.push({ type: 'hardBreak' });
            }
            if (line) {
                nodes.push({ type: 'text', text: line });
            }
        });
        return { type: 'paragraph', content: nodes };
    });
    return { type: 'doc', version: 1, content: content.length ? content : [{ type: 'paragraph', content: [] }] };
}

function localIso(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return iso;
    }
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Referencia al origen que se añade al final del ticket. El email del autor solo se incluye si la fuente es Gmail. */
export function buildSourceReference(item: TriageItem, categoryId: string): string {
    const origin = item.source === 'slack' ? `Slack ${item.channel}` : item.channel;
    const author = item.source === 'gmail' && item.author.email && item.author.email !== item.author.name
        ? `${item.author.name} <${item.author.email}>`
        : item.author.name;
    const parts = [origin, author, localIso(item.receivedAt), ...(item.permalink ? [item.permalink] : [])];
    const category = TRIAGE_CATEGORIES.find(c => c.id === categoryId)?.label ?? categoryId;
    return `---\nOrigen: ${parts.join(' — ')}\nCategoría: ${category}\nFokkus-Triage-ID: ${item.id}`;
}

/** Arma la descripción final del ticket: referencia completa (si se pide) o solo el marcador de deduplicación. */
export function buildTicketBody(description: string, item: TriageItem, categoryId: string, includeReference: boolean): string {
    if (includeReference) {
        return `${description}\n\n${buildSourceReference(item, categoryId)}`;
    }
    return `${description}\n\n---\nFokkus-Triage-ID: ${item.id}`;
}

/** True si el contenido (texto, HTML, markdown o ADF) lleva el marcador de deduplicación de `triageId`. */
export function hasTriageIdMarker(content: unknown, triageId: string): boolean {
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
    return text.includes(`Fokkus-Triage-ID: ${triageId}`);
}

/** True si `createdIso` es >= `receivedAtIso` (con 5 min de margen), o si falta alguna fecha. */
export function isOnOrAfterReceivedAt(createdIso: string | undefined, receivedAtIso: string | undefined): boolean {
    const created = typeof createdIso === 'string' ? Date.parse(createdIso) : NaN;
    const received = typeof receivedAtIso === 'string' ? Date.parse(receivedAtIso) : NaN;
    if (Number.isNaN(created) || Number.isNaN(received)) {
        return true;
    }
    return created >= received - 5 * 60 * 1000;
}

/** Recorta un mensaje de error de la API para mostrarlo (sin saltos ni textos enormes). */
export function apiMessage(value: unknown, max: number = 200): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}
