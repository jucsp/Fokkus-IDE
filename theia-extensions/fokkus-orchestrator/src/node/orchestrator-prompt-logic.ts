/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ChatMessage } from '../common/fokkus-orchestrator-protocol';

/** Mensajes más cortos que esto y sin verbos técnicos se tratan como conversacionales. */
export const SHORT_PROMPT_MAX_LENGTH = 25;
/** Los patrones de saludo / prueba de audio / agradecimiento solo aplican hasta esta longitud. */
export const CONVERSATIONAL_PATTERN_MAX_LENGTH = 80;
/** Mensajes del historial incluidos en el prompt (4 turnos). */
export const RECENT_HISTORY_MAX_MESSAGES = 8;
/** Longitud máxima de un mensaje del asistente en el historial antes de recortarlo por el medio. */
export const ASSISTANT_MESSAGE_MAX_CHARS = 1200;

export const NO_PENDING_STORIES_NOTE = '(Sin historias pendientes en el backlog)';
export const TRUNCATION_MARKER = '[... contenido intermedio omitido ...]';

const EXACT_REPLIES = new Set([
    'ok', 'okey', 'oka', 'entendido', 'de acuerdo', 'perfecto', 'listo', 'vale', 'bien',
    'si', 'no', 'dale', 'genial', 'excelente', 'perfect', 'nice', 'cool', 'claro', 'obvio',
    'va', 'ya', 'gracias', 'hola', 'hey', 'buenas', 'saludos', 'probando',
    'muchas gracias', 'de una', 'vamos', 'buen dia', 'buenos dias'
]);

const AUDIO_TEST_PATTERN = /\b(probando|prueba de audio|test de audio|prueba de microfono|prueba de mic|test de microfono|test de mic)\b/g;

const CONVERSATIONAL_PATTERNS: RegExp[] = [
    /^(hola|hey|buenas|buenos dias|buenas tardes|buenas noches|saludos|que tal|holi|buen dia)\b/,
    /\b(probando|prueba de audio|test de audio|prueba de microfono|prueba de mic|test de microfono|test de mic)\b/,
    /\b(me escuchas|me escucha|me oyes|me oye|me lees|me lee|escuchas|ecuchas|me copias|me copia)\b/,
    /\b(gracias|muchas gracias|thanks|thank you|te lo agradezco|mil gracias)\b/,
    /\b(como estas|como andas|que tal|estas ahi|sigues ahi|estas por ahi|estas bien|como te va)\b/
];

const TECHNICAL_WORDS = new Set([
    // verbos de acción técnica
    'crea', 'crear', 'modifica', 'modificar', 'cambia', 'cambiar', 'arregla', 'arreglar',
    'corrige', 'corregir', 'compila', 'compilar', 'build', 'implementa', 'implementar',
    'agrega', 'agregar', 'anade', 'anadir', 'elimina', 'eliminar', 'borra', 'borrar',
    'refactoriza', 'refactorizar', 'optimiza', 'optimizar', 'ejecuta', 'ejecutar',
    'corre', 'correr', 'instala', 'instalar', 'despliega', 'desplegar', 'haz', 'haga',
    'genera', 'generar', 'escribe', 'escribir', 'actualiza', 'actualizar', 'revisa',
    'revisar', 'analiza', 'analizar', 'depura', 'depurar', 'debug', 'testea', 'testear',
    'test', 'integra', 'integrar', 'migra', 'migrar', 'configura', 'configurar',
    'publica', 'publicar', 'sube', 'subir', 'commit', 'push', 'deploy', 'deployar',
    'redacta', 'redactar', 'plan', 'disena', 'disenar',
    // reportes de problema que requieren investigación
    'funciona', 'falla', 'fallar', 'error', 'roto', 'rompe', 'romper', 'anda', 'bug',
    'problema', 'tira', 'lanza', 'excepcion', 'exception', 'crash'
]);

/** Minúsculas, sin tildes ni puntuación y con espacios colapsados. */
export function normalizePromptText(text: string): string {
    return (text || '').toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[¿?¡!.,;:()"']/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Indica si el texto normalizado contiene verbos de acción técnica o reportes de problema. */
export function hasTechnicalActionVerb(normalized: string): boolean {
    return normalized.split(/\s+/).some(word => TECHNICAL_WORDS.has(word));
}

/**
 * Detecta mensajes conversacionales o ligeros (saludos, pruebas de audio,
 * agradecimientos, respuestas breves) para responder directo sin inyectar
 * backlog, lista de archivos ni la directiva rígida de planificación.
 *
 * Un verbo técnico o un mensaje largo siempre ganan: «Hola, crea el login» o
 * «Gracias. Ahora necesito …» son tareas aunque empiecen con un saludo.
 * Una respuesta de la tarjeta de aprobación nunca es conversacional (abre la FASE 2).
 */
export function isConversationalOrSimplePrompt(prompt: string): boolean {
    const raw = (prompt || '').trim();
    if (!raw) {
        return true;
    }
    if (raw.includes('fokkus-approval-response')) {
        return false;
    }
    const normalized = normalizePromptText(raw);
    if (EXACT_REPLIES.has(normalized)) {
        return true;
    }
    // «test de audio» no es una tarea aunque contenga «test».
    if (hasTechnicalActionVerb(normalized.replace(AUDIO_TEST_PATTERN, ' '))) {
        return false;
    }
    if (raw.length < SHORT_PROMPT_MAX_LENGTH) {
        return true;
    }
    if (raw.length > CONVERSATIONAL_PATTERN_MAX_LENGTH) {
        return false;
    }
    return CONVERSATIONAL_PATTERNS.some(pattern => pattern.test(normalized));
}

function indentationOf(line: string): number {
    return line.length - line.trimStart().length;
}

/**
 * Elimina del backlog las historias ya cerradas (`- [x]`) junto con sus líneas
 * anidadas (notas `_Fix vX_`, etc.), conservando títulos de épicas y las
 * historias pendientes (`- [ ]`) con sus detalles.
 */
export function filterActiveBacklog(content: string): string {
    if (!content) {
        return '';
    }
    const kept: string[] = [];
    let pendingCount = 0;
    let hadClosed = false;
    let closedIndent: number | undefined;
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (closedIndent !== undefined && trimmed !== '') {
            if (indentationOf(line) > closedIndent) {
                continue;
            }
            closedIndent = undefined;
        }
        if (/^[-*+]\s*\[[xX]\]/.test(trimmed)) {
            hadClosed = true;
            closedIndent = indentationOf(line);
            continue;
        }
        if (/^[-*+]\s*\[\s\]/.test(trimmed)) {
            pendingCount++;
        }
        kept.push(line);
    }
    const filtered = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (pendingCount === 0 && hadClosed) {
        return filtered.length > 0 ? `${filtered}\n\n${NO_PENDING_STORIES_NOTE}` : NO_PENDING_STORIES_NOTE;
    }
    return filtered;
}

/** Recorta el texto intermedio conservando el inicio y el final cuando excede `maxChars`. */
export function truncateMiddle(text: string, maxChars: number): string {
    if (!text || text.length <= maxChars) {
        return text;
    }
    const half = Math.floor(maxChars / 2);
    const head = text.slice(0, half);
    const tail = text.slice(text.length - half);
    return `${head}\n\n${TRUNCATION_MARKER}\n\n${tail}`;
}

/**
 * Formatea el historial limitando a los últimos `maxMessages` mensajes y
 * recortando por el medio los mensajes del asistente muy largos.
 */
export function formatRecentChatHistory(
    history: ChatMessage[] | undefined,
    maxMessages: number = RECENT_HISTORY_MAX_MESSAGES,
    maxAssistantChars: number = ASSISTANT_MESSAGE_MAX_CHARS
): string {
    if (!history || history.length === 0 || maxMessages <= 0) {
        return '';
    }
    return history.slice(-maxMessages).map(msg => {
        const content = msg.role === 'assistant' ? truncateMiddle(msg.content, maxAssistantChars) : msg.content;
        return `[${msg.role.toUpperCase()}]: ${content}`;
    }).join('\n\n');
}
