/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { expect } from 'chai';
import { ChatMessage } from '../common/fokkus-orchestrator-protocol';
import {
    filterActiveBacklog,
    formatRecentChatHistory,
    hasTechnicalActionVerb,
    isConversationalOrSimplePrompt,
    NO_PENDING_STORIES_NOTE,
    normalizePromptText,
    TRUNCATION_MARKER,
    truncateMiddle
} from './orchestrator-prompt-logic';

function message(role: ChatMessage['role'], content: string, timestamp: number = 0): ChatMessage {
    return { role, content, timestamp };
}

describe('orchestrator-prompt-logic', () => {

    describe('normalizePromptText', () => {
        it('quita tildes, signos y espacios repetidos', () => {
            expect(normalizePromptText('  ¿Cómo   ESTÁS?  ')).to.equal('como estas');
        });
    });

    describe('hasTechnicalActionVerb', () => {
        it('detecta verbos técnicos por palabra completa', () => {
            expect(hasTechnicalActionVerb('crea el login')).to.equal(true);
            expect(hasTechnicalActionVerb('no funciona')).to.equal(true);
            expect(hasTechnicalActionVerb('como andas')).to.equal(false);
            expect(hasTechnicalActionVerb('creatividad')).to.equal(false);
        });
    });

    describe('isConversationalOrSimplePrompt', () => {
        it('trata como conversacionales los saludos, pruebas de audio y agradecimientos', () => {
            for (const prompt of [
                '', '   ', 'Hola', 'ok', 'Sí', 'Muchas gracias!', 'Probando. Ecuchas.',
                '¿Me escuchas?', 'Test de audio', 'Prueba de micrófono, uno dos tres',
                'Buenos días, ¿cómo estás hoy? Espero que todo vaya muy bien por ahí.'
            ]) {
                expect(isConversationalOrSimplePrompt(prompt), prompt).to.equal(true);
            }
        });

        it('trata como conversacional un mensaje corto sin verbos técnicos', () => {
            expect(isConversationalOrSimplePrompt('¿Qué hora es?')).to.equal(true);
        });

        it('un verbo técnico gana aunque el mensaje empiece con un saludo o un agradecimiento', () => {
            for (const prompt of [
                'Hola, crea el componente de login', 'Gracias. Ahora arregla el bug del sidebar',
                'compila', 'no funciona', 'haz commit', '¿Me escuchas? Revisa el backlog'
            ]) {
                expect(isConversationalOrSimplePrompt(prompt), prompt).to.equal(false);
            }
        });

        it('un mensaje largo no es conversacional aunque contenga un saludo', () => {
            const prompt = 'Hola equipo, necesito que el panel lateral muestre los iconos de la bandeja ' +
                'con un tamaño mayor y que el contador de pendientes sea visible en modo oscuro.';
            expect(prompt.length).to.be.greaterThan(80);
            expect(isConversationalOrSimplePrompt(prompt)).to.equal(false);
        });

        it('un mensaje medio sin saludo ni verbo técnico no es conversacional', () => {
            expect(isConversationalOrSimplePrompt('Necesito el listado de módulos del proyecto')).to.equal(false);
        });

        it('la respuesta de la tarjeta de aprobación nunca es conversacional', () => {
            expect(isConversationalOrSimplePrompt('<!-- fokkus-approval-response id="a1" decision="approved" -->')).to.equal(false);
            expect(isConversationalOrSimplePrompt('<!-- fokkus-approval-response id="a1" decision="rejected" -->\nok')).to.equal(false);
        });
    });

    describe('filterActiveBacklog', () => {
        it('devuelve vacío si no hay contenido', () => {
            expect(filterActiveBacklog('')).to.equal('');
        });

        it('quita las historias cerradas con sus notas anidadas y conserva las pendientes', () => {
            const backlog = [
                '# Product Backlog',
                '',
                '## Épica 1',
                '- [x] #1 Cerrada.',
                '  - _Fix v1.0.1:_ detalle largo de la cerrada.',
                '    - sub-nota más profunda.',
                '- [ ] #2 Pendiente.',
                '  - _Problema:_ detalle de la pendiente.',
                '* [X] #3 Cerrada con asterisco.',
                '',
                '## Épica 2',
                '- [ ] #4 Otra pendiente.'
            ].join('\n');
            const result = filterActiveBacklog(backlog);
            expect(result).to.equal([
                '# Product Backlog',
                '',
                '## Épica 1',
                '- [ ] #2 Pendiente.',
                '  - _Problema:_ detalle de la pendiente.',
                '',
                '## Épica 2',
                '- [ ] #4 Otra pendiente.'
            ].join('\n'));
        });

        it('una línea al mismo nivel tras una cerrada se conserva', () => {
            const result = filterActiveBacklog('- [x] #1 cerrada\n  - nota\nTexto libre\n- [ ] #2 pendiente');
            expect(result).to.equal('Texto libre\n- [ ] #2 pendiente');
        });

        it('una línea en blanco no corta la omisión de las notas de una cerrada', () => {
            const result = filterActiveBacklog('- [x] #1 cerrada\n\n  - nota tras blanco\n- [ ] #2 pendiente');
            expect(result).to.equal('- [ ] #2 pendiente');
        });

        it('avisa cuando no quedan historias pendientes', () => {
            expect(filterActiveBacklog('## Épica\n- [x] #1 cerrada')).to.equal(`## Épica\n\n${NO_PENDING_STORIES_NOTE}`);
            expect(filterActiveBacklog('- [x] #1 cerrada\n  - nota')).to.equal(NO_PENDING_STORIES_NOTE);
        });

        it('un backlog sin casillas se devuelve recortado e intacto', () => {
            expect(filterActiveBacklog('\n# Backlog\nNotas libres\n')).to.equal('# Backlog\nNotas libres');
        });

        it('acepta saltos de línea CRLF', () => {
            expect(filterActiveBacklog('- [x] a\r\n  - nota\r\n- [ ] b')).to.equal('- [ ] b');
        });
    });

    describe('truncateMiddle', () => {
        it('no toca textos cortos', () => {
            expect(truncateMiddle('abc', 10)).to.equal('abc');
            expect(truncateMiddle('', 10)).to.equal('');
        });

        it('conserva inicio y final de los textos largos', () => {
            const text = 'A'.repeat(50) + 'M'.repeat(100) + 'Z'.repeat(50);
            const result = truncateMiddle(text, 100);
            expect(result.startsWith('A'.repeat(50))).to.equal(true);
            expect(result.endsWith('Z'.repeat(50))).to.equal(true);
            expect(result).to.contain(TRUNCATION_MARKER);
            expect(result).to.not.contain('M');
        });
    });

    describe('formatRecentChatHistory', () => {
        it('devuelve vacío sin historial', () => {
            expect(formatRecentChatHistory(undefined)).to.equal('');
            expect(formatRecentChatHistory([])).to.equal('');
            expect(formatRecentChatHistory([message('user', 'hola')], 0)).to.equal('');
        });

        it('se queda con los últimos 8 mensajes por defecto', () => {
            const history = Array.from({ length: 12 }, (_, i) => message(i % 2 ? 'assistant' : 'user', `m${i}`, i));
            const result = formatRecentChatHistory(history);
            expect(result.split('\n\n')).to.have.length(8);
            expect(result.startsWith('[USER]: m4')).to.equal(true);
            expect(result.endsWith('[ASSISTANT]: m11')).to.equal(true);
        });

        it('recorta solo los mensajes largos del asistente', () => {
            const long = 'x'.repeat(5000);
            const result = formatRecentChatHistory([message('user', long), message('assistant', long)]);
            expect(result).to.contain(`[USER]: ${long}`);
            expect(result.split(TRUNCATION_MARKER)).to.have.length(2);
            expect(result.length).to.be.lessThan(5000 + 1200 + 200);
        });
    });
});
