/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { expect } from 'chai';
import {
    computeRmsLevel,
    isFatalRecognitionError,
    JARVIS_RMS_GAIN,
    JARVIS_SPEECH_RMS_THRESHOLD,
    parseStoredJarvisConfig,
    shouldAutoListen,
    shouldCloseMicrophone,
    shouldReleaseMicrophone
} from './jarvis-logic';
import { DEFAULT_JARVIS_CONFIG } from './jarvis-protocol';

/** Onda cuadrada de bytes centrada en 128 con amplitud `amplitude` (RMS exacto = amplitude / 128). */
function squareWave(amplitude: number, length: number = 256): Uint8Array {
    const data = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
        data[i] = i % 2 === 0 ? 128 + amplitude : 128 - amplitude;
    }
    return data;
}

describe('jarvis-logic', () => {

    describe('computeRmsLevel', () => {
        it('devuelve 0 en silencio y con muestras vacías', () => {
            expect(computeRmsLevel(squareWave(0))).to.equal(0);
            expect(computeRmsLevel([])).to.equal(0);
        });

        it('con ganancia 1 da el RMS crudo que usa la detección de voz del STT local', () => {
            expect(computeRmsLevel(squareWave(32), 1)).to.be.closeTo(0.25, 1e-9);
        });

        it('aplica JARVIS_RMS_GAIN por defecto y recorta a 1', () => {
            expect(computeRmsLevel(squareWave(16))).to.be.closeTo(0.125 * JARVIS_RMS_GAIN, 1e-9);
            expect(computeRmsLevel(squareWave(127))).to.equal(1);
        });

        it('el umbral de voz separa el ruido de fondo de la voz normal', () => {
            const noise = computeRmsLevel(squareWave(2), 1);
            const voice = computeRmsLevel(squareWave(20), 1);
            expect(noise).to.be.below(JARVIS_SPEECH_RMS_THRESHOLD);
            expect(voice).to.be.above(JARVIS_SPEECH_RMS_THRESHOLD);
        });
    });

    describe('parseStoredJarvisConfig', () => {
        it('usa los valores por defecto si no hay nada guardado o el JSON está roto', () => {
            expect(parseStoredJarvisConfig(undefined)).to.deep.equal(DEFAULT_JARVIS_CONFIG);
            expect(parseStoredJarvisConfig('{roto')).to.deep.equal(DEFAULT_JARVIS_CONFIG);
        });

        it('tolera configuraciones parciales', () => {
            const config = parseStoredJarvisConfig(JSON.stringify({ gamingMode: !DEFAULT_JARVIS_CONFIG.gamingMode }));
            expect(config.gamingMode).to.equal(!DEFAULT_JARVIS_CONFIG.gamingMode);
            expect(config.voiceLang).to.equal(DEFAULT_JARVIS_CONFIG.voiceLang);
        });
    });

    describe('auto-escucha', () => {
        const base = { enabled: true, muted: false, microphoneBlocked: false, state: 'idle' as const, appFocused: true, gamingMode: false };

        it('re-arma solo en idle, con foco o en Modo Gaming', () => {
            expect(shouldAutoListen(base)).to.equal(true);
            expect(shouldAutoListen({ ...base, state: 'thinking' })).to.equal(false);
            expect(shouldAutoListen({ ...base, appFocused: false })).to.equal(false);
            expect(shouldAutoListen({ ...base, appFocused: false, gamingMode: true })).to.equal(true);
        });

        it('no re-arma con el micrófono bloqueado (sin micrófono o permiso denegado)', () => {
            expect(shouldAutoListen({ ...base, microphoneBlocked: true })).to.equal(false);
        });

        it('suelta el micrófono al perder el foco fuera de Modo Gaming', () => {
            expect(shouldReleaseMicrophone({ ...base, state: 'listening', appFocused: false })).to.equal(true);
            expect(shouldReleaseMicrophone({ ...base, state: 'listening', appFocused: false, gamingMode: true })).to.equal(false);
        });

        it('cierra el micrófono abierto entre turnos (thinking/speaking/idle) sin foco, silenciado o desactivado', () => {
            for (const state of ['idle', 'thinking', 'speaking'] as const) {
                expect(shouldCloseMicrophone({ ...base, state, appFocused: false })).to.equal(true);
                expect(shouldCloseMicrophone({ ...base, state, muted: true })).to.equal(true);
                expect(shouldCloseMicrophone({ ...base, state, enabled: false })).to.equal(true);
                expect(shouldCloseMicrophone({ ...base, state })).to.equal(false);
                expect(shouldCloseMicrophone({ ...base, state, appFocused: false, gamingMode: true })).to.equal(false);
            }
        });
    });

    describe('isFatalRecognitionError', () => {
        it("'network' no es fatal: activa el STT local en vez de bloquear el micrófono", () => {
            expect(isFatalRecognitionError('network')).to.equal(false);
            expect(isFatalRecognitionError('not-allowed')).to.equal(true);
        });
    });
});
