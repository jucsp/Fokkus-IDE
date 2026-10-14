/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DEFAULT_JARVIS_CONFIG, JarvisConfig, JarvisState } from './jarvis-protocol';

/**
 * Lógica pura de Jarvis (Issue #27, Fase 3): sin DOM ni Theia, para poder probarla en Node.
 * La usan el servicio de audio (RMS, persistencia), el controlador (auto-escucha, click-through)
 * y la burbuja (forma, colores, posición).
 */

// -------------------------------------------------------------------------------------------------
// Audio
// -------------------------------------------------------------------------------------------------

/** Ganancia aplicada al RMS: la voz normal ronda 0.05-0.2 de RMS y la animación necesita 0..1. */
export const JARVIS_RMS_GAIN = 4;

/** RMS crudo (sin ganancia) por encima del cual se considera que el usuario está hablando. */
export const JARVIS_SPEECH_RMS_THRESHOLD = 0.05;

function clamp01(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.min(1, Math.max(0, value));
}

/** RMS de una muestra en el dominio del tiempo (`getByteTimeDomainData`, 128 = silencio) normalizado a [0, 1]. */
export function computeRmsLevel(samples: ArrayLike<number>, gain: number = JARVIS_RMS_GAIN): number {
    if (samples.length === 0) {
        return 0;
    }
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
        const value = (samples[i] - 128) / 128;
        sum += value * value;
    }
    return clamp01(Math.sqrt(sum / samples.length) * gain);
}

/** Suavizado ataque/caída: sube rápido con la voz y cae despacio para que la gota no parpadee. */
export function smoothAudioLevel(previous: number, target: number, attack: number = 0.55, release: number = 0.12): number {
    const from = clamp01(previous);
    const to = clamp01(target);
    const factor = to > from ? attack : release;
    return clamp01(from + (to - from) * factor);
}

// -------------------------------------------------------------------------------------------------
// Persistencia
// -------------------------------------------------------------------------------------------------

/**
 * Lee la configuración guardada en localStorage. Acepta configuraciones parciales o de versiones
 * anteriores: cada campo con el tipo correcto se conserva y el resto toma el valor por defecto.
 */
export function parseStoredJarvisConfig(raw: string | null | undefined): JarvisConfig {
    const config: JarvisConfig = { ...DEFAULT_JARVIS_CONFIG };
    if (!raw) {
        return config;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return config;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return config;
    }
    const candidate = parsed as Partial<Record<keyof JarvisConfig, unknown>>;
    if (typeof candidate.enabled === 'boolean') {
        config.enabled = candidate.enabled;
    }
    if (typeof candidate.voiceLang === 'string' && candidate.voiceLang.trim().length > 0) {
        config.voiceLang = candidate.voiceLang.trim();
    }
    if (typeof candidate.gamingMode === 'boolean') {
        config.gamingMode = candidate.gamingMode;
    }
    if (typeof candidate.continuousListening === 'boolean') {
        config.continuousListening = candidate.continuousListening;
    }
    return config;
}

// -------------------------------------------------------------------------------------------------
// Políticas del controlador
// -------------------------------------------------------------------------------------------------

export interface JarvisListenContext {
    /** Jarvis activado por el usuario (botón de la barra de estado / comando). */
    enabled: boolean;
    muted: boolean;
    microphoneBlocked: boolean;
    state: JarvisState;
    gamingMode: boolean;
    /** true si la ventana del IDE tiene el foco. */
    appFocused: boolean;
}

/**
 * ¿Hay que (re)armar el micrófono? Solo desde `idle`: nunca interrumpe un turno en curso.
 * Con el IDE en segundo plano solo se escucha en Modo Gaming.
 */
export function shouldAutoListen(context: JarvisListenContext): boolean {
    return context.enabled
        && !context.muted
        && !context.microphoneBlocked
        && context.state === 'idle'
        && (context.appFocused || context.gamingMode);
}

/** ¿Hay que soltar el micrófono? Al perder el foco fuera de Modo Gaming, o al desactivar Jarvis. */
export function shouldReleaseMicrophone(context: JarvisListenContext): boolean {
    if (!context.enabled || context.muted) {
        return context.state === 'listening';
    }
    return context.state === 'listening' && !context.appFocused && !context.gamingMode;
}

export interface JarvisMouseMode {
    ignore: boolean;
    forward: boolean;
}

/**
 * Click-through de la ventana overlay. En Modo Gaming la ventana es transparente al ratón por
 * completo (no roba clics al juego); si no, solo captura el ratón mientras el cursor está sobre la
 * burbuja, y el resto del rectángulo transparente deja pasar los clics.
 *
 * `forwardSupported`: Electron solo reenvía `mousemove` con la ventana ignorada en Windows y macOS.
 * En Linux no se detectaría el hover, así que fuera de Modo Gaming la ventana captura siempre.
 */
export function resolveOverlayMouseMode(gamingMode: boolean, hoveringBubble: boolean, forwardSupported: boolean = true): JarvisMouseMode {
    if (gamingMode) {
        return { ignore: true, forward: forwardSupported };
    }
    if (!forwardSupported || hoveringBubble) {
        return { ignore: false, forward: false };
    }
    return { ignore: true, forward: true };
}

/** Tras cuántos errores seguidos (sin ningún resultado entre medias) se deja de re-armar la escucha. */
export const JARVIS_MAX_CONSECUTIVE_RECOGNITION_ERRORS = 3;

// -------------------------------------------------------------------------------------------------
// Presentación
// -------------------------------------------------------------------------------------------------

export interface JarvisTheme {
    /** Colores del gradiente radial: centro, medio, borde. */
    core: string;
    mid: string;
    edge: string;
    glow: string;
    /** Frecuencia de la pulsación en reposo (Hz). */
    pulseHz: number;
    /** Amplitud de la pulsación (fracción del radio). */
    pulseDepth: number;
    /** Deformación base de la gota (fracción del radio). */
    wobble: number;
    /** Deformación extra a nivel de audio 1. */
    reactivity: number;
    /** Velocidad de rotación del gradiente (rad/s). */
    rotation: number;
}

export const JARVIS_THEMES: Readonly<Record<JarvisState, JarvisTheme>> = {
    idle: { core: '#bae6fd', mid: '#38bdf8', edge: '#1e3a8a', glow: 'rgba(56, 189, 248, 0.45)', pulseHz: 0.25, pulseDepth: 0.04, wobble: 0.05, reactivity: 0.04, rotation: 0.15 },
    listening: { core: '#ecfeff', mid: '#22d3ee', edge: '#0e7490', glow: 'rgba(34, 211, 238, 0.7)', pulseHz: 0.6, pulseDepth: 0.03, wobble: 0.06, reactivity: 0.22, rotation: 0.4 },
    thinking: { core: '#f5d0fe', mid: '#c026d3', edge: '#4c1d95', glow: 'rgba(192, 38, 211, 0.6)', pulseHz: 1.1, pulseDepth: 0.06, wobble: 0.08, reactivity: 0.05, rotation: 1.6 },
    speaking: { core: '#d1fae5', mid: '#10b981', edge: '#065f46', glow: 'rgba(16, 185, 129, 0.65)', pulseHz: 0.5, pulseDepth: 0.03, wobble: 0.06, reactivity: 0.2, rotation: 0.6 },
    muted: { core: '#fef3c7', mid: '#f59e0b', edge: '#92400e', glow: 'rgba(245, 158, 11, 0.4)', pulseHz: 0.15, pulseDepth: 0.02, wobble: 0.03, reactivity: 0, rotation: 0.05 }
};

export const JARVIS_STATE_LABELS: Readonly<Record<JarvisState, string>> = {
    idle: 'En espera',
    listening: 'Escuchando…',
    thinking: 'Pensando…',
    speaking: 'Hablando…',
    muted: 'Silenciado'
};

/**
 * Radio de la gota en un ángulo: pulsación lenta + tres armónicos con fases distintas. El nivel de
 * audio aumenta la deformación según la `reactivity` del estado. Nunca baja del 70 % del radio.
 */
export function blobRadius(angle: number, timeSec: number, baseRadius: number, audioLevel: number, theme: JarvisTheme): number {
    const level = clamp01(audioLevel);
    const breath = theme.pulseDepth * Math.sin(2 * Math.PI * theme.pulseHz * timeSec);
    const amplitude = theme.wobble + level * theme.reactivity;
    const harmonics = 0.55 * Math.sin(3 * angle + timeSec * 1.3)
        + 0.3 * Math.sin(5 * angle - timeSec * 1.9 + 1.1)
        + 0.15 * Math.sin(7 * angle + timeSec * 2.7 + 2.3);
    const radius = baseRadius * (1 + breath + amplitude * harmonics + level * 0.08);
    return Math.max(baseRadius * 0.7, radius);
}

/** Desplazamiento vertical de la onda sinusoidal interna en `x` ∈ [0, 1]; amplitud proporcional al audio. */
export function innerWaveOffset(x: number, timeSec: number, amplitude: number, audioLevel: number): number {
    const level = clamp01(audioLevel);
    const envelope = Math.sin(Math.PI * clamp01(x));
    const wave = Math.sin(x * 4 * Math.PI + timeSec * 5) * 0.7 + Math.sin(x * 9 * Math.PI - timeSec * 3) * 0.3;
    return amplitude * (0.08 + level) * envelope * wave;
}

export interface JarvisPoint {
    x: number;
    y: number;
}

export interface JarvisSize {
    width: number;
    height: number;
}

/** Mantiene la burbuja dentro del área visible (con margen). */
export function clampBubblePosition(position: JarvisPoint, bubble: JarvisSize, viewport: JarvisSize, margin: number = 8): JarvisPoint {
    const maxX = Math.max(margin, viewport.width - bubble.width - margin);
    const maxY = Math.max(margin, viewport.height - bubble.height - margin);
    return {
        x: Math.min(maxX, Math.max(margin, position.x)),
        y: Math.min(maxY, Math.max(margin, position.y))
    };
}

/** Texto breve para la transcripción flotante: conserva el FINAL (lo último que se dijo). */
export function summarizeTranscript(text: string, maxLength: number = 140): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `…${normalized.slice(normalized.length - (maxLength - 1)).trimStart()}`;
}

/** Errores de la Web Speech API que indican permiso denegado: re-armar provocaría un bucle. */
export function isFatalRecognitionError(code: string | undefined): boolean {
    return code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture';
}
