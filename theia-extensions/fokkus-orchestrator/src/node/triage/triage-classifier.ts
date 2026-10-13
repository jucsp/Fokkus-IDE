/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { TRIAGE_CATEGORIES, TriageCategory, TriageSource } from '../../common/triage-protocol';

/**
 * Clasificador determinista de la Bandeja (#26). Función pura, sin I/O: puntúa por palabras clave
 * y por si el remitente es interno o externo. Punto de extensión para un clasificador LLM futuro.
 */
export interface ClassifyInput {
    source: TriageSource;
    channel: string;
    subject: string;
    text: string;
    authorEmail?: string;
    authorIsInternal: boolean;
}

export interface ClassifyResult {
    category: TriageCategory;
    confidence: number;
    reason: string;
}

interface CategoryRule {
    category: TriageCategory;
    /** 'any' = cualquier remitente; 'internal'/'external' = solo puntúa con ese tipo de remitente. */
    author: 'any' | 'internal' | 'external';
    keywords: readonly string[];
}

/**
 * Palabras clave ya normalizadas (minúsculas, sin tildes). Las que terminan en espacio exigen ese espacio.
 * Las escritas en mayúsculas (`TODO`) se buscan en el texto original, respetando mayúsculas.
 */
const RULES: readonly CategoryRule[] = [
    {
        category: 'support', author: 'any',
        keywords: ['error', 'falla', 'fallo', 'caido', 'caida', 'no funciona', 'no carga', 'bug', 'incidente', 'urgente', '500', 'timeout',
            'bloqueado', 'bloqueada', 'no puedo ingresar', 'no puedo acceder', 'down', 'broken']
    },
    {
        category: 'team-ticket', author: 'internal',
        keywords: ['crear ticket', 'crear un ticket', 'tarea', 'registrar', 'backlog', 'hu ', 'historia de usuario', 'bug encontrado', 'mejora',
            'refactor', 'TODO', 'pendiente para']
    },
    {
        category: 'client-query', author: 'external',
        keywords: ['avance', 'plazo', 'entrega', 'cambio', 'alcance', 'ambiente', 'deploy', 'version', 'sprint', 'reunion']
    },
    {
        category: 'company-query', author: 'internal',
        keywords: ['comercial', 'gerencia', 'administracion', 'facturacion', 'rrhh', 'contabilidad', 'propuesta', 'cotizacion interna']
    },
    {
        category: 'general-client-query', author: 'external',
        keywords: ['cotizacion', 'precio', 'informacion', 'consulta', 'servicios', 'presupuesto', 'demo']
    }
];

const MAX_REASON_KEYWORDS = 5;

export function normalizeText(value: string): string {
    return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const isCaseSensitive = (keyword: string): boolean => keyword !== keyword.toLowerCase();

const KEYWORD_RES = new Map<string, RegExp>(RULES.flatMap(rule => rule.keywords.map(keyword => {
    // `hu ` conserva su espacio final para no confundirse con palabras como «hubo».
    const body = escapeRegExp(keyword.trimEnd()) + (keyword.endsWith(' ') ? '\\s' : '');
    return [keyword, new RegExp(`(^|[^A-Za-z0-9])${body}(?![A-Za-z0-9])`)] as [string, RegExp];
})));

function matches(normalized: string, original: string, keyword: string): boolean {
    const re = KEYWORD_RES.get(keyword);
    return !!re && re.test(isCaseSensitive(keyword) ? original : normalized);
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

export function classify(input: ClassifyInput): ClassifyResult {
    const original = `${input.subject ?? ''}\n${input.text ?? ''}`;
    const text = normalizeText(original);
    const authorLabel = input.authorIsInternal ? 'remitente interno' : 'remitente externo';

    const scored = RULES.map(rule => {
        const applies = rule.author === 'any' || (rule.author === 'internal') === input.authorIsInternal;
        const found = applies ? rule.keywords.filter(keyword => matches(text, original, keyword)) : [];
        return { category: rule.category, score: found.length, found };
    });

    const support = scored[0];
    let winner = support;
    if (support.score < 2) {
        const order = (category: TriageCategory) => TRIAGE_CATEGORIES.findIndex(c => c.id === category);
        winner = [...scored].sort((a, b) => b.score - a.score || order(a.category) - order(b.category))[0];
    }

    if (winner.score === 0) {
        return {
            category: input.authorIsInternal ? 'company-query' : 'general-client-query',
            confidence: 0.3,
            reason: `sin palabras clave · ${authorLabel}`
        };
    }

    const second = Math.max(0, ...scored.filter(s => s !== winner).map(s => s.score));
    const confidence = round2(Math.min(0.95, Math.max(0.3, 0.35 + 0.15 * (winner.score - second))));
    const keywords = winner.found.slice(0, MAX_REASON_KEYWORDS).map(k => k.trim()).join(', ');
    return { category: winner.category, confidence, reason: `palabras clave: ${keywords} · ${authorLabel}` };
}

/** Dominio interno = el del email o un subdominio de alguno de `internalDomains`. */
export function isInternal(email: string | undefined, internalDomains: readonly string[]): boolean {
    const domain = (email ?? '').trim().toLowerCase().split('@')[1];
    if (!domain) {
        return false;
    }
    return internalDomains.some(d => {
        const internal = d.trim().toLowerCase();
        return !!internal && (domain === internal || domain.endsWith(`.${internal}`));
    });
}
