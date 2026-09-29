/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export type ApprovalRisk = 'baja' | 'media' | 'alta';
export type ApprovalDecision = 'approved' | 'rejected';

export interface ApprovalRequest {
    id: string;
    title: string;
    summary: string;
    risk?: ApprovalRisk;
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
