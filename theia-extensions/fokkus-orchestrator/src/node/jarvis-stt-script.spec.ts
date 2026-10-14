/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { expect } from 'chai';
import { spawnSync } from 'child_process';
import { inferAudioExtension, JARVIS_STT_SCRIPT, normalizeSttLanguage, parseJarvisSttOutput } from './jarvis-stt-script';

describe('jarvis-stt-script', () => {

    describe('parseJarvisSttOutput', () => {
        it('lee el texto o el error del script', () => {
            expect(parseJarvisSttOutput('{"text": "hola Jarvis"}')).to.deep.equal({ text: 'hola Jarvis', error: undefined });
            expect(parseJarvisSttOutput('{"error": "ffmpeg no pudo decodificar el audio"}'))
                .to.deep.equal({ text: undefined, error: 'ffmpeg no pudo decodificar el audio' });
        });

        it('ignora avisos previos y toma la última línea JSON', () => {
            const output = 'Downloading model…\n{"text": "viejo"}\nwarning: algo\n{"text": "nuevo"}\n';
            expect(parseJarvisSttOutput(output)?.text).to.equal('nuevo');
        });

        it('devuelve undefined sin JSON válido y descarta tipos no string', () => {
            expect(parseJarvisSttOutput('Traceback (most recent call last):')).to.equal(undefined);
            expect(parseJarvisSttOutput('{no json')).to.equal(undefined);
            expect(parseJarvisSttOutput('{"text": 42}')).to.deep.equal({ text: undefined, error: undefined });
        });
    });

    describe('normalizeSttLanguage', () => {
        it('reduce a ISO 639-1 y cae a español con valores raros', () => {
            expect(normalizeSttLanguage('es-CL')).to.equal('es');
            expect(normalizeSttLanguage('EN-us')).to.equal('en');
            expect(normalizeSttLanguage(undefined)).to.equal('es');
            expect(normalizeSttLanguage('--evil')).to.equal('es');
            expect(normalizeSttLanguage('fil-PH')).to.equal('es');
        });
    });

    describe('inferAudioExtension', () => {
        it('mapea los contenedores de MediaRecorder', () => {
            expect(inferAudioExtension('audio/webm;codecs=opus')).to.equal('.webm');
            expect(inferAudioExtension('audio/ogg;codecs=opus')).to.equal('.ogg');
            expect(inferAudioExtension('audio/mp4')).to.equal('.m4a');
            expect(inferAudioExtension('')).to.equal('.webm');
        });
    });

    describe('JARVIS_STT_SCRIPT', () => {
        const python = spawnSync('python3', ['--version']);
        const run = (args: string[]) => spawnSync('python3', ['-', ...args], { input: JARVIS_STT_SCRIPT, encoding: 'utf8' });

        it('es Python válido que se ejecuta por stdin', function (): void {
            if (python.error) {
                this.skip();
            }
            const result = run([]);
            expect(result.status).to.equal(1);
            expect(parseJarvisSttOutput(result.stdout)?.error).to.match(/uso:/);
        });

        it('informa por JSON (no con un traceback) si el audio no se puede decodificar', function (): void {
            if (python.error) {
                this.skip();
            }
            const result = run(['/nonexistent/fokkus-audio.webm', 'es']);
            expect(result.status).to.equal(1);
            expect(parseJarvisSttOutput(result.stdout)?.error).to.be.a('string');
        });
    });
});
