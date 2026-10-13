/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { TriageItem, TriageReplyDraft, TriageTicketRef } from '../../common/triage-protocol';

function greetingName(item: TriageItem): string {
    const name = (item.author.name ?? '').trim();
    if (!name || name === item.author.email) {
        return '';
    }
    // Quita apellidos si el nombre es compuesto: deja solo el primer token visible.
    const first = name.split(/\s+/)[0];
    return first ? first.replace(/[^A-Za-zÁÉÍÓÚÜÑáéíóúüñ'-]+$/g, '') : '';
}

/** Destinatario visible para la UI. */
export function recipientFor(item: TriageItem): string {
    if (item.source === 'gmail') {
        return item.author.email ?? item.author.name ?? '';
    }
    return item.channel || 'Slack';
}

/** Asunto propuesto. En Slack es informativo (el envío real usa el hilo). */
export function subjectFor(item: TriageItem): string {
    const base = item.originalSubject || item.title;
    return base.startsWith('Re:') ? base : `Re: ${base}`;
}

/**
 * Borrador de respuesta al solicitante en español profesional (#29): saludo, confirmación del ticket
 * con su clave y enlace, y una nota breve del curso del requerimiento. Función pura, sin I/O.
 */
export function generateReplyDraft(item: TriageItem, ticket: TriageTicketRef): TriageReplyDraft {
    const name = greetingName(item);
    const saludo = name ? `Hola ${name},` : 'Hola,';
    const lines = [
        saludo,
        '',
        `Gracias por escribirnos. Hemos registrado tu solicitud con el identificador ${ticket.key} y nuestro equipo ya la está revisando.`,
        '',
        `Puedes consultar el avance en cualquier momento en este enlace: ${ticket.url}`,
        '',
        'Te mantendremos al tanto de los próximos pasos. Si tienes información adicional, responde a este mismo hilo.',
        '',
        'Saludos cordiales,',
        'Equipo de soporte'
    ];
    return {
        itemId: item.id,
        source: item.source,
        recipient: recipientFor(item),
        subject: subjectFor(item),
        body: lines.join('\n'),
        ticketKey: ticket.key,
        ticketUrl: ticket.url
    };
}

/** Extrae `channelId` y `threadTs` del id `slack:<canal>:<ts>`. Lanza si el id no es válido. */
export function slackParts(itemId: string): { channelId: string; threadTs: string } {
    const parts = itemId.split(':');
    if (parts.length < 3 || parts[0] !== 'slack') {
        throw new Error('El identificador de la solicitud no corresponde a Slack');
    }
    return { channelId: parts[1], threadTs: parts.slice(2).join(':') };
}

/** Extrae el `threadId` del id `gmail:<threadId>`. Lanza si el id no es válido. */
export function gmailThreadId(itemId: string): string {
    const prefix = 'gmail:';
    if (!itemId.startsWith(prefix) || itemId.length <= prefix.length) {
        throw new Error('El identificador de la solicitud no corresponde a Gmail');
    }
    return itemId.slice(prefix.length);
}
