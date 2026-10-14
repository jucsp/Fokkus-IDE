/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Event } from '@theia/core/lib/common/event';

/**
 * Contrato del asistente de voz Jarvis — Issue #27, Fase 2.
 *
 * El servicio de audio vive SOLO en el frontend: el reconocimiento (STT), la síntesis (TTS) y el
 * analizador de volumen usan las APIs del navegador (Web Speech / Web Audio). El despacho hacia el
 * Agente Líder se hace a través del `FokkusOrchestratorServer` ya existente; aquí no hay un servidor
 * RPC nuevo, solo los tipos y constantes que comparten la UI (canvas de la burbuja, badge de estado)
 * y el servicio de audio.
 */
export const JarvisAudioService = Symbol('JarvisAudioService');

/** Estados del ciclo de vida del asistente de voz. */
export type JarvisState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'muted';

export const JARVIS_STATES: readonly JarvisState[] = ['idle', 'listening', 'thinking', 'speaking', 'muted'];

export interface JarvisConfig {
    /** true = el asistente de voz está habilitado (el usuario puede iniciar escucha). */
    enabled: boolean;
    /** Código de idioma para STT/TTS (por defecto 'es-ES'). */
    voiceLang: string;
    /** true = ignorar eventos de ratón / operar en modo fondo (la UI decide el comportamiento). */
    gamingMode: boolean;
    /** true = el usuario quiere escucha continua (re-armar el micrófono tras cada turno). */
    continuousListening: boolean;
}

/** Preferencia donde se guarda la configuración en localStorage (no hay secretos). */
export const JARVIS_STORAGE_KEY = 'fokkus.jarvis.config';
export const JARVIS_DEFAULT_VOICE_LANG = 'es-ES';
/** Idiomas preferidos para elegir la voz de síntesis (mejor coincidencia primero). */
export const JARVIS_PREFERRED_VOICE_LANGS: readonly string[] = ['es-CL', 'es-419', 'es-MX', 'es-AR', 'es-ES', 'es-US'];
/** Milisegundos de silencio para dar por terminado un turno de habla. */
export const JARVIS_SILENCE_TIMEOUT_MS = 1800;
/** Tope de espera para el resultado del Agente Líder antes de volver a `idle`. */
export const JARVIS_DISPATCH_TIMEOUT_MS = 5 * 60 * 1000;

export const DEFAULT_JARVIS_CONFIG: JarvisConfig = {
    enabled: false,
    voiceLang: JARVIS_DEFAULT_VOICE_LANG,
    gamingMode: false,
    continuousListening: false
};

export function isJarvisConfig(value: unknown): value is JarvisConfig {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value as Partial<JarvisConfig>;
    return typeof candidate.enabled === 'boolean'
        && typeof candidate.voiceLang === 'string'
        && typeof candidate.gamingMode === 'boolean'
        && typeof candidate.continuousListening === 'boolean';
}

/** Fragmento de transcripción emitido mientras el usuario habla. */
export interface JarvisTranscript {
    text: string;
    isFinal: boolean;
}

/** Servicio de audio inyectable en el frontend. Emite los eventos que animan la burbuja. */
export interface JarvisAudioService {
    readonly onStateChanged: Event<JarvisState>;
    /** Nivel de volumen normalizado [0, 1] para la animación líquida del canvas. */
    readonly onAudioLevel: Event<number>;
    readonly onTranscript: Event<JarvisTranscript>;
    /** Texto de la respuesta del asistente que se va a locutar. */
    readonly onAssistantSpeech: Event<string>;
    readonly onConfigChanged: Event<JarvisConfig>;
    /** Errores legibles del micrófono/síntesis (p. ej. permiso denegado) para mostrarlos en la burbuja. */
    readonly onError: Event<string>;

    getState(): JarvisState;
    getConfig(): JarvisConfig;
    updateConfig(patch: Partial<JarvisConfig>): JarvisConfig;
    /** true si el navegador soporta STT y TTS. */
    isSupported(): boolean;
    startListening(): Promise<void>;
    stopListening(): void;
    toggleMute(): void;
    isMuted(): boolean;
    /** Conmuta el Modo Gaming (seguir oyendo con el IDE en segundo plano). Devuelve el valor nuevo. */
    toggleGamingMode(): boolean;
    /** true si el navegador denegó el micrófono: no se re-arma la escucha hasta reactivarlo a mano. */
    isMicrophoneBlocked(): boolean;
    speak(text: string): void;
    stopSpeaking(): void;
    /** Despacha un turno de voz al Agente Líder, locuta la respuesta y la deja en el chat. */
    dispatchVoicePrompt(text: string): Promise<void>;
}

// -------------------------------------------------------------------------------------------------
// Ventana overlay de Electron (Fase 3): ventana secundaria transparente y Always-On-Top.
// -------------------------------------------------------------------------------------------------

/** Nombre del frame que se pasa a `window.open`; el proceso main lo usa para reconocer la ventana. */
export const JARVIS_OVERLAY_FRAME_NAME = 'fokkus-jarvis-overlay';
export const JARVIS_OVERLAY_WIDTH = 280;
export const JARVIS_OVERLAY_HEIGHT = 320;

export const JarvisOverlayWindowServerPath = '/services/fokkus-jarvis-overlay';
export const JarvisOverlayWindowServer = Symbol('JarvisOverlayWindowServer');

/** Servidor del proceso main de Electron (por IPC) que controla la ventana overlay. */
export interface JarvisOverlayWindowServer {
    /** Click-through: con `ignore` los clics atraviesan la ventana; `forward` sigue enviando mousemove. Devuelve false si no hay ventana. */
    setIgnoreMouseEvents(ignore: boolean, forward: boolean): Promise<boolean>;
    /** Fija la ventana por encima de todo (nivel `screen-saver`, también sobre apps a pantalla completa). */
    setAlwaysOnTop(onTop: boolean): Promise<boolean>;
}
