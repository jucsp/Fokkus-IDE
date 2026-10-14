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
    /** Código de idioma para STT (por defecto 'es-CL'). */
    voiceLang: string;
    /** Identificador de la voz neuronal de edge-tts para TTS (por defecto 'es-CL-LorenzoNeural'). */
    voiceId?: string;
    /** true = ignorar eventos de ratón / operar en modo fondo (la UI decide el comportamiento). */
    gamingMode: boolean;
    /** true = el usuario quiere escucha continua (re-armar el micrófono tras cada turno). */
    continuousListening: boolean;
}

/** Preferencia donde se guarda la configuración en localStorage (no hay secretos). */
export const JARVIS_STORAGE_KEY = 'fokkus.jarvis.config';
export const JARVIS_DEFAULT_VOICE_LANG = 'es-CL';
export const JARVIS_DEFAULT_VOICE_ID = 'es-CL-LorenzoNeural';
/** Idiomas preferidos para elegir la voz de síntesis (mejor coincidencia primero). */
export const JARVIS_PREFERRED_VOICE_LANGS: readonly string[] = ['es-CL', 'es-419', 'es-MX', 'es-AR', 'es-ES', 'es-US'];
/** Milisegundos de silencio para dar por terminado un turno de habla. */
export const JARVIS_SILENCE_TIMEOUT_MS = 1800;
/** Tope de grabación continua sin detectar voz (evita dejar el micrófono encendido indefinidamente). */
export const JARVIS_MAX_LOCAL_RECORDING_MS = 30_000;
/** Tope de espera para el resultado del Agente Líder antes de volver a `idle`. */
export const JARVIS_DISPATCH_TIMEOUT_MS = 5 * 60 * 1000;

/** Regiones del catálogo de voces (agrupación para la UI). */
export type JarvisVoiceRegion = 'latam' | 'spain' | 'english';

/** Género de la voz neuronal. */
export type JarvisVoiceGender = 'male' | 'female';

/** Una voz neuronal de edge-tts disponible para el TTS de Jarvis. */
export interface JarvisVoiceInfo {
    /** Identificador exacto que acepta edge-tts (`--voice`). */
    id: string;
    /** Nombre legible del hablante. */
    name: string;
    gender: JarvisVoiceGender;
    /** Código de idioma BCP-47 de la voz (p. ej. 'es-CL'). */
    lang: string;
    region: JarvisVoiceRegion;
    /** País/detalle legible de la voz (p. ej. 'Chile'). */
    regionLabel: string;
    /** Frase de muestra que se usa en la vista previa de voz. */
    previewText: string;
}

export const DEFAULT_JARVIS_CONFIG: JarvisConfig = {
    enabled: false,
    voiceLang: JARVIS_DEFAULT_VOICE_LANG,
    voiceId: JARVIS_DEFAULT_VOICE_ID,
    gamingMode: false,
    continuousListening: false
};

/**
 * Catálogo curado de voces neuronales de edge-tts. `region` agrupa en tres bloques (Latinoamérica,
 * España, Inglés) y `regionLabel` es el país de cada hablante.
 */
export const JARVIS_VOICES: readonly JarvisVoiceInfo[] = [
    // Latinoamérica
    { id: 'es-CL-LorenzoNeural', name: 'Lorenzo', gender: 'male', lang: 'es-CL', region: 'latam', regionLabel: 'Chile', previewText: 'Hola, soy Jarvis, tu asistente de voz.' },
    { id: 'es-CL-CatalinaNeural', name: 'Catalina', gender: 'female', lang: 'es-CL', region: 'latam', regionLabel: 'Chile', previewText: 'Hola, soy Jarvis, tu asistente de voz.' },
    { id: 'es-MX-JorgeNeural', name: 'Jorge', gender: 'male', lang: 'es-MX', region: 'latam', regionLabel: 'México', previewText: 'Hola, soy Jarvis, tu asistente de voz.' },
    { id: 'es-MX-DaliaNeural', name: 'Dalia', gender: 'female', lang: 'es-MX', region: 'latam', regionLabel: 'México', previewText: 'Hola, soy Jarvis, tu asistente de voz.' },
    { id: 'es-AR-TomasNeural', name: 'Tomás', gender: 'male', lang: 'es-AR', region: 'latam', regionLabel: 'Argentina', previewText: 'Hola, soy Jarvis, tu asistente de voz.' },
    { id: 'es-AR-ElenaNeural', name: 'Elena', gender: 'female', lang: 'es-AR', region: 'latam', regionLabel: 'Argentina', previewText: 'Hola, soy Jarvis, tu asistente de voz.' },
    { id: 'es-CO-GonzaloNeural', name: 'Gonzalo', gender: 'male', lang: 'es-CO', region: 'latam', regionLabel: 'Colombia', previewText: 'Hola, soy Jarvis, tu asistente de voz.' },
    { id: 'es-CO-SalomeNeural', name: 'Salomé', gender: 'female', lang: 'es-CO', region: 'latam', regionLabel: 'Colombia', previewText: 'Hola, soy Jarvis, tu asistente de voz.' },
    { id: 'es-PE-AlexNeural', name: 'Alex', gender: 'male', lang: 'es-PE', region: 'latam', regionLabel: 'Perú', previewText: 'Hola, soy Jarvis, tu asistente de voz.' },
    { id: 'es-PE-CamilaNeural', name: 'Camila', gender: 'female', lang: 'es-PE', region: 'latam', regionLabel: 'Perú', previewText: 'Hola, soy Jarvis, tu asistente de voz.' },
    // España
    { id: 'es-ES-AlvaroNeural', name: 'Álvaro', gender: 'male', lang: 'es-ES', region: 'spain', regionLabel: 'España', previewText: 'Hola, soy Jarvis, tu asistente de voz.' },
    { id: 'es-ES-ElviraNeural', name: 'Elvira', gender: 'female', lang: 'es-ES', region: 'spain', regionLabel: 'España', previewText: 'Hola, soy Jarvis, tu asistente de voz.' },
    // Inglés
    { id: 'en-US-ChristopherNeural', name: 'Christopher', gender: 'male', lang: 'en-US', region: 'english', regionLabel: 'EE.UU.',
        previewText: "Hi, I'm Jarvis, your voice assistant." },
    { id: 'en-US-JennyNeural', name: 'Jenny', gender: 'female', lang: 'en-US', region: 'english', regionLabel: 'EE.UU.', previewText: "Hi, I'm Jarvis, your voice assistant." },
    { id: 'en-US-GuyNeural', name: 'Guy', gender: 'male', lang: 'en-US', region: 'english', regionLabel: 'EE.UU.', previewText: "Hi, I'm Jarvis, your voice assistant." }
];

export function isJarvisConfig(value: unknown): value is JarvisConfig {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value as Partial<JarvisConfig>;
    return typeof candidate.enabled === 'boolean'
        && typeof candidate.voiceLang === 'string'
        && (candidate.voiceId === undefined || typeof candidate.voiceId === 'string')
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
    /** Voz cuya vista previa se está sintetizando o reproduciendo; `undefined` al terminar o detenerse. */
    readonly onPreviewChanged: Event<string | undefined>;

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
    /**
     * Reproduce una vista previa de una voz del catálogo. `voiceId` es el id exacto de edge-tts
     * (p. ej. 'es-CL-LorenzoNeural'); si se omite `sampleText` se usa el texto de muestra de la voz.
     */
    previewVoice(voiceId: string, sampleText?: string): Promise<void>;
    /** Detiene la vista previa de voz en curso (no interrumpe la locución normal de `speak`). */
    stopPreview(): void;
    /** Id de la voz en vista previa (sintetizando o sonando), o `undefined`. */
    getPreviewVoiceId(): string | undefined;
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
