/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ChatMessage } from './fokkus-orchestrator-protocol';

export type ApprovalRisk = 'baja' | 'media' | 'alta';
export type ApprovalDecision = 'approved' | 'rejected';
/** Estado determinista de la última solicitud de aprobación del historial. */
export type ApprovalState = 'none' | 'pending' | 'approved' | 'rejected';

export interface ApprovalRequest {
    id: string;
    title: string;
    summary: string;
    risk?: ApprovalRisk;
}

/** Resultado de resolver el estado de aprobación a partir del historial del chat. */
export interface ResolvedApprovalState {
    status: ApprovalState;
    id?: string;
    title?: string;
}

const APPROVAL_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const APPROVAL_RESPONSE_REGEX = /<!--\s*fokkus-approval-response\s+id="([^"]*)"\s+decision="(approved|rejected)"\s*-->/g;

function hashApprovalId(value: string): string {
    let hash = 5381;
    for (let i = 0; i < value.length; i++) {
        hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
}

function sanitizeSingleLine(value: string): string {
    return value.replace(/\r?\n/g, ' ').trim();
}

/**
 * Convierte el bloque de código `fokkus-approval` en una solicitud estructurada.
 * Es tolerante con texto extra alrededor del JSON y nunca lanza.
 */
export function parseApprovalRequest(raw: string): ApprovalRequest {
    const trimmed = raw.trim();
    const fallback: ApprovalRequest = {
        id: `req-${hashApprovalId(trimmed)}`,
        title: 'Solicitud de aprobación',
        summary: trimmed
    };
    if (!trimmed) {
        return fallback;
    }

    let jsonText = trimmed;
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        jsonText = trimmed.slice(firstBrace, lastBrace + 1);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        return fallback;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return fallback;
    }

    const record = parsed as Record<string, unknown>;
    const title = typeof record.title === 'string' && record.title.trim().length > 0
        ? record.title.trim()
        : 'Solicitud de aprobación';
    const summary = typeof record.summary === 'string' ? record.summary : trimmed;

    let risk: ApprovalRisk | undefined;
    if (typeof record.risk === 'string') {
        const normalized = record.risk.toLowerCase();
        if (normalized === 'baja' || normalized === 'media' || normalized === 'alta') {
            risk = normalized;
        }
    }

    const candidateId = typeof record.id === 'string' ? record.id.trim() : '';
    const id = APPROVAL_ID_PATTERN.test(candidateId) ? candidateId : `req-${hashApprovalId(trimmed)}`;

    return { id, title, summary, risk };
}

/** Construye el mensaje de usuario con el que el chat responde a una solicitud de aprobación. */
export function buildApprovalResponse(request: ApprovalRequest, decision: ApprovalDecision, reason?: string): string {
    const title = sanitizeSingleLine(request.title);
    const id = APPROVAL_ID_PATTERN.test(request.id) ? request.id : `req-${hashApprovalId(title)}`;
    const safeReason = (reason ?? '').trim().replace(/-->/g, '--&gt;');
    const header = `<!-- fokkus-approval-response id="${id}" decision="${decision}" -->`;

    if (decision === 'approved') {
        return `${header}\n✅ **Aprobado:** ${title}\n\nContinúa con la operación aprobada.`;
    }

    const reasonLine = safeReason.length > 0 ? `**Motivo:** ${safeReason}\n\n` : '';
    return `${header}\n❌ **Rechazado:** ${title}\n\n${reasonLine}No ejecutes la operación: detente y propone alternativas.`;
}

/** Extrae todas las respuestas de aprobación presentes en el contenido de un mensaje. */
export function parseApprovalResponses(content: string): Array<{ id: string; decision: ApprovalDecision }> {
    return Array.from(content.matchAll(APPROVAL_RESPONSE_REGEX), match => ({ id: match[1], decision: match[2] as ApprovalDecision }));
}

/** Busca la primera respuesta posterior a `requestIndex` que coincida con `requestId`. */
export function resolveApprovalDecision(contents: string[], requestIndex: number, requestId: string): ApprovalDecision | undefined {
    for (let j = requestIndex + 1; j < contents.length; j++) {
        const responses = parseApprovalResponses(contents[j]);
        for (const response of responses) {
            if (response.id === requestId) {
                return response.decision;
            }
        }
    }
    return undefined;
}

/** Elimina los marcadores de respuesta de aprobación para mostrar el mensaje limpio. */
export function stripApprovalResponseMarkers(content: string): string {
    return content.replace(/<!--\s*fokkus-approval-response\s+id="[^"]*"\s+decision="(?:approved|rejected)"\s*-->\s*\n?/g, '');
}

/**
 * Extrae la última solicitud de aprobación (bloque ```fokkus-approval) del
 * contenido crudo de un mensaje. Devuelve `undefined` si no hay ningún bloque.
 * Es tolerante con bloques sin cierre y con JSON inválido (nunca lanza).
 */
export function extractLastApprovalRequest(content: string): ApprovalRequest | undefined {
    if (!content) {
        return undefined;
    }
    const fenceOpen = /```\s*fokkus-approval\b[^\n]*[\r\n]+/g;
    let last: ApprovalRequest | undefined;
    while (fenceOpen.exec(content)) {
        const bodyStart = fenceOpen.lastIndex;
        const closeIndex = content.indexOf('```', bodyStart);
        const body = closeIndex === -1 ? content.slice(bodyStart) : content.slice(bodyStart, closeIndex);
        last = parseApprovalRequest(body);
        if (closeIndex === -1) {
            break;
        }
        fenceOpen.lastIndex = closeIndex + 3;
    }
    return last;
}

/**
 * Calcula de forma determinista el estado de la última solicitud de aprobación
 * emitida por el asistente a partir del historial del chat:
 * - `none`: no existe ninguna solicitud.
 * - `pending`: la solicitud más reciente aún no tiene respuesta del usuario.
 * - `approved` / `rejected`: el usuario respondió a la solicitud más reciente.
 * Nunca lanza, incluso con JSON o bloques malformados.
 */
export function resolveApprovalState(history: ChatMessage[]): ResolvedApprovalState {
    let requestIndex = -1;
    let request: ApprovalRequest | undefined;
    for (let i = 0; i < history.length; i++) {
        const message = history[i];
        if (message.role !== 'assistant') {
            continue;
        }
        const extracted = extractLastApprovalRequest(message.content);
        if (extracted) {
            requestIndex = i;
            request = extracted;
        }
    }

    if (requestIndex < 0 || !request) {
        return { status: 'none' };
    }

    const contents = history.map(message => message.content);
    const decision = resolveApprovalDecision(contents, requestIndex, request.id);
    if (decision === 'approved') {
        // La aprobación solo autoriza el turno que la trae: si después llegó otro mensaje
        // del usuario, es un pedido nuevo y vuelve a necesitar su propio plan aprobado.
        const approvedId = request.id;
        const lastUserIndex = history.map(message => message.role).lastIndexOf('user');
        const lastUserApproves = lastUserIndex > requestIndex && parseApprovalResponses(contents[lastUserIndex])
            .some(response => response.id === approvedId && response.decision === 'approved');
        return lastUserApproves ? { status: 'approved', id: request.id, title: request.title } : { status: 'none' };
    }
    if (decision === 'rejected') {
        return { status: 'rejected', id: request.id, title: request.title };
    }
    return { status: 'pending', id: request.id, title: request.title };
}
