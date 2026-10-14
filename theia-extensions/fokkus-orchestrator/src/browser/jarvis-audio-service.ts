/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Emitter, Event as TheiaEvent } from '@theia/core/lib/common/event';
import { environment } from '@theia/core/shared/@theia/application-package/lib/environment';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { FokkusOrchestratorServer, SwarmDispatchResult } from '../common/fokkus-orchestrator-protocol';
import {
    computeRmsLevel,
    isFatalRecognitionError,
    JARVIS_MAX_CONSECUTIVE_RECOGNITION_ERRORS,
    JARVIS_RMS_GAIN,
    JARVIS_SPEECH_RMS_THRESHOLD,
    parseStoredJarvisConfig
} from '../common/jarvis-logic';
import {
    DEFAULT_JARVIS_CONFIG,
    JARVIS_DISPATCH_TIMEOUT_MS,
    JARVIS_MAX_LOCAL_RECORDING_MS,
    JARVIS_PREFERRED_VOICE_LANGS,
    JARVIS_SILENCE_TIMEOUT_MS,
    JARVIS_STORAGE_KEY,
    JarvisAudioService,
    JarvisConfig,
    JarvisState,
    JarvisTranscript
} from '../common/jarvis-protocol';
import { FokkusChatDispatcher } from './fokkus-chat-dispatch';
import { FokkusSwarmDispatchOutcome, FokkusSwarmEvents } from './fokkus-swarm-events';

/** Una grabación del STT local; cada `MediaRecorder` lleva su propio estado. */
interface LocalRecordingSession {
    readonly recorder: MediaRecorder;
    readonly chunks: Blob[];
    readonly mimeType: string;
    speechDetected: boolean;
    cancelled: boolean;
}

// ---------------------------------------------------------------------------------------------
// Tipos mínimos de la Web Speech API (STT). `SpeechRecognition` no está en lib.dom.d.ts, así que
// se declara la parte estructural que usa el servicio y se recupera el constructor desde `window`.
// ---------------------------------------------------------------------------------------------

interface SpeechAlternative {
    readonly transcript: string;
}

interface SpeechResult {
    readonly isFinal: boolean;
    readonly length: number;
    item(index: number): SpeechAlternative;
    readonly [index: number]: SpeechAlternative;
}

interface SpeechResultList {
    readonly length: number;
    item(index: number): SpeechResult;
    readonly [index: number]: SpeechResult;
}

interface SpeechRecognitionResultEvent extends Event {
    readonly resultIndex: number;
    readonly results: SpeechResultList;
}

interface SpeechRecognitionErrorEventLike extends Event {
    readonly error?: string;
}

interface SpeechRecognizer {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onresult: ((event: SpeechRecognitionResultEvent) => void) | undefined;
    onerror: ((event: SpeechRecognitionErrorEventLike) => void) | undefined;
    onend: ((event: Event) => void) | undefined;
    onspeechstart: ((event: Event) => void) | undefined;
    onspeechend: ((event: Event) => void) | undefined;
    start(): void;
    stop(): void;
    abort(): void;
}

interface SpeechRecognizerConstructor {
    new (): SpeechRecognizer;
}

/**
 * Servicio de audio de Jarvis (Issue #27, Fase 2).
 *
 * - STT: `webkitSpeechRecognition`/`SpeechRecognition` nativo de Chromium/Electron, con detección
 *   de silencio para cerrar el turno de habla. En Electron (o cuando el reconocimiento en la nube
 *   falla con 'network') se usa un pipeline LOCAL: MediaRecorder + `transcribeAudio` del backend
 *   (faster-whisper), que no depende de los servidores de Google.
 * - Analizador: `getUserMedia` + `AudioContext` + `AnalyserNode` para emitir el RMS (0..1).
 * - TTS: `speechSynthesis` eligiendo la mejor voz en español disponible.
 * - Despacho: entrega el turno al chat (`FokkusChatDispatcher`), que llama a `dispatchToSwarm`, y
 *   captura la respuesta en `FokkusSwarmEvents` para locutarla. (El `onDidDispatchSwarm` del proxy
 *   RPC no sirve: Theia trata las propiedades `on*` del proxy como notificaciones al backend.)
 */
@injectable()
export class JarvisAudioServiceImpl implements JarvisAudioService {

    @inject(FokkusSwarmEvents)
    protected readonly swarmEvents: FokkusSwarmEvents;

    @inject(FokkusChatDispatcher)
    protected readonly chatDispatcher: FokkusChatDispatcher;

    @inject(FokkusOrchestratorServer)
    protected readonly orchestratorServer: FokkusOrchestratorServer;

    protected readonly onStateChangedEmitter = new Emitter<JarvisState>();
    readonly onStateChanged: TheiaEvent<JarvisState> = this.onStateChangedEmitter.event;

    protected readonly onAudioLevelEmitter = new Emitter<number>();
    readonly onAudioLevel: TheiaEvent<number> = this.onAudioLevelEmitter.event;

    protected readonly onTranscriptEmitter = new Emitter<JarvisTranscript>();
    readonly onTranscript: TheiaEvent<JarvisTranscript> = this.onTranscriptEmitter.event;

    protected readonly onAssistantSpeechEmitter = new Emitter<string>();
    readonly onAssistantSpeech: TheiaEvent<string> = this.onAssistantSpeechEmitter.event;

    protected readonly onConfigChangedEmitter = new Emitter<JarvisConfig>();
    readonly onConfigChanged: TheiaEvent<JarvisConfig> = this.onConfigChangedEmitter.event;

    protected readonly onErrorEmitter = new Emitter<string>();
    readonly onError: TheiaEvent<string> = this.onErrorEmitter.event;

    protected state: JarvisState = 'idle';
    protected config: JarvisConfig = { ...DEFAULT_JARVIS_CONFIG };
    protected muted: boolean = false;
    protected microphoneBlocked: boolean = false;
    protected consecutiveRecognitionErrors: number = 0;

    protected recognizer: SpeechRecognizer | undefined;
    protected finalTranscript: string = '';
    protected interimTranscript: string = '';
    protected silenceTimerId: number | undefined;

    protected microphoneStream: MediaStream | undefined;
    protected audioContext: AudioContext | undefined;
    protected analyser: AnalyserNode | undefined;
    protected audioRafId: number | undefined;

    protected speakingSimulationId: number | undefined;
    protected currentUtterance: SpeechSynthesisUtterance | undefined;

    protected voiceDispatchActive: boolean = false;
    protected voiceDispatchPrompt: string | undefined;
    protected voiceDispatchSubscription: { dispose(): void } | undefined;
    protected voiceDispatchTimeoutId: number | undefined;

    // STT local (fallback en Electron / error 'network'): MediaRecorder + backend faster-whisper.
    protected useLocalStt: boolean = false;
    protected localRecording: LocalRecordingSession | undefined;
    /** Último RMS crudo (sin ganancia) del micrófono. */
    protected currentAudioLevel: number = 0;
    protected localSilenceTimerId: number | undefined;
    protected localMaxRecordingTimerId: number | undefined;
    protected audioMeterPromise: Promise<void> | undefined;

    @postConstruct()
    protected init(): void {
        this.config = this.loadConfig();
    }

    public getState(): JarvisState {
        return this.state;
    }

    public getConfig(): JarvisConfig {
        return { ...this.config };
    }

    public updateConfig(patch: Partial<JarvisConfig>): JarvisConfig {
        this.config = { ...this.config, ...patch };
        if (this.config.voiceLang.trim().length === 0) {
            this.config.voiceLang = DEFAULT_JARVIS_CONFIG.voiceLang;
        }
        this.persistConfig();
        const snapshot = { ...this.config };
        this.onConfigChangedEmitter.fire(snapshot);
        return { ...snapshot };
    }

    public toggleGamingMode(): boolean {
        return this.updateConfig({ gamingMode: !this.config.gamingMode }).gamingMode;
    }

    public isMuted(): boolean {
        return this.muted;
    }

    public isMicrophoneBlocked(): boolean {
        return this.microphoneBlocked;
    }

    public isSupported(): boolean {
        return (this.isSpeechRecognitionSupported() || this.isMediaRecorderSupported()) && this.isTtsSupported();
    }

    public async startListening(): Promise<void> {
        if (this.muted || this.microphoneBlocked || this.recognizer || this.localRecording) {
            return;
        }
        if (this.shouldUseLocalStt()) {
            await this.startLocalListening();
            return;
        }
        this.startRecognizer();
        this.startAudioLevelMeter().catch(() => undefined);
        if (this.recognizer) {
            this.setState('listening');
        }
    }

    public stopListening(): void {
        this.stopLocalRecording();
        this.stopRecognizer();
        if (this.getState() === 'listening') {
            this.setState('idle');
        }
    }

    public toggleMute(): void {
        if (this.muted) {
            this.muted = false;
            // Reactivar a mano es la forma de reintentar tras un permiso de micrófono denegado.
            this.microphoneBlocked = false;
            this.consecutiveRecognitionErrors = 0;
            this.setState('idle');
        } else {
            this.muted = true;
            this.stopListening();
            this.stopSpeaking();
            this.setState('muted');
        }
    }

    public speak(text: string): void {
        const trimmed = text.trim();
        if (trimmed.length === 0 || this.muted || !this.isTtsSupported()) {
            this.setState('idle');
            return;
        }
        this.stopSpeaking();
        this.setState('speaking');
        const utterance = new SpeechSynthesisUtterance(trimmed);
        const voice = this.pickVoice();
        if (voice) {
            utterance.voice = voice;
            utterance.lang = voice.lang;
        } else {
            utterance.lang = this.config.voiceLang;
        }
        utterance.onend = () => this.finishSpeaking();
        utterance.onerror = () => this.finishSpeaking();
        this.currentUtterance = utterance;
        this.startSpeakingSimulation();
        window.speechSynthesis.speak(utterance);
    }

    public stopSpeaking(): void {
        this.stopSpeakingSimulation();
        this.currentUtterance = undefined;
        if (this.isTtsSupported()) {
            window.speechSynthesis.cancel();
        }
    }

    public async dispatchVoicePrompt(text: string): Promise<void> {
        const trimmed = text.trim();
        if (trimmed.length === 0 || this.voiceDispatchActive) {
            return;
        }
        this.voiceDispatchActive = true;
        this.clearVoiceDispatchHandlers();
        this.voiceDispatchPrompt = trimmed;
        this.setState('thinking');
        this.voiceDispatchSubscription = this.swarmEvents.onDidFinishDispatch(outcome => this.handleVoiceDispatchOutcome(outcome));
        this.voiceDispatchTimeoutId = window.setTimeout(() => this.finishVoiceDispatch(undefined), JARVIS_DISPATCH_TIMEOUT_MS);
        try {
            await this.chatDispatcher.send(trimmed);
        } catch (error) {
            this.warn('No se pudo enviar el mensaje de voz al chat', error);
            this.finishVoiceDispatch(undefined);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // STT
    // ---------------------------------------------------------------------------------------------

    protected isSpeechRecognitionSupported(): boolean {
        const windowWithSpeech = this.speechWindow();
        return windowWithSpeech.SpeechRecognition !== undefined || windowWithSpeech.webkitSpeechRecognition !== undefined;
    }

    protected isMediaRecorderSupported(): boolean {
        return typeof window !== 'undefined' && 'MediaRecorder' in window;
    }

    /**
     * ¿Usar el STT local (MediaRecorder + backend) en vez de WebSpeech? En Electron siempre: el
     * WebSpeech de Chromium necesita una clave de Google y falla con 'network' en cada intento.
     */
    protected shouldUseLocalStt(): boolean {
        return this.useLocalStt || environment.electron.is() || !this.isSpeechRecognitionSupported();
    }

    protected createRecognizer(): SpeechRecognizer | undefined {
        const windowWithSpeech = this.speechWindow();
        const ctor = windowWithSpeech.SpeechRecognition ?? windowWithSpeech.webkitSpeechRecognition;
        return ctor ? new ctor() : undefined;
    }

    protected speechWindow(): { SpeechRecognition?: SpeechRecognizerConstructor; webkitSpeechRecognition?: SpeechRecognizerConstructor } {
        return window as unknown as {
            SpeechRecognition?: SpeechRecognizerConstructor;
            webkitSpeechRecognition?: SpeechRecognizerConstructor;
        };
    }

    protected startRecognizer(): void {
        const recognizer = this.createRecognizer();
        if (!recognizer) {
            return;
        }
        this.recognizer = recognizer;
        this.finalTranscript = '';
        this.interimTranscript = '';
        recognizer.continuous = true;
        recognizer.interimResults = true;
        recognizer.lang = this.config.voiceLang;
        recognizer.onresult = event => this.handleRecognitionResult(event);
        recognizer.onerror = event => this.handleRecognitionError(recognizer, event.error);
        recognizer.onend = () => this.handleRecognitionEnd(recognizer);
        recognizer.onspeechstart = () => this.cancelSilenceTimer();
        recognizer.onspeechend = () => this.scheduleSilence();
        try {
            recognizer.start();
        } catch (error) {
            this.warn('No se pudo iniciar el reconocimiento de voz', error);
            this.recognizer = undefined;
        }
    }

    protected stopRecognizer(): void {
        this.cancelSilenceTimer();
        this.stopAudioLevelMeter();
        this.stopRecognizerOnly();
    }

    /** Detiene solo el reconocedor WebSpeech, conservando el micrófono/analizador (para el fallback local). */
    protected stopRecognizerOnly(): void {
        const recognizer = this.recognizer;
        this.recognizer = undefined;
        if (recognizer) {
            try {
                recognizer.abort();
            } catch {
                try {
                    recognizer.stop();
                } catch (error) {
                    this.warn('No se pudo detener el reconocimiento de voz', error);
                }
            }
        }
    }

    protected handleRecognitionResult(event: SpeechRecognitionResultEvent): void {
        this.cancelSilenceTimer();
        this.consecutiveRecognitionErrors = 0;
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const result = event.results[i];
            if (result.isFinal) {
                const transcript = result.length > 0 ? result[0].transcript : '';
                if (transcript.length > 0) {
                    this.finalTranscript = this.finalTranscript.length > 0
                        ? `${this.finalTranscript} ${transcript}`
                        : transcript;
                    this.onTranscriptEmitter.fire({ text: this.finalTranscript, isFinal: true });
                }
            } else if (result.length > 0) {
                interim += result[0].transcript;
            }
        }
        if (interim.length > 0) {
            this.interimTranscript = interim;
            this.onTranscriptEmitter.fire({ text: interim, isFinal: false });
        }
        // Chromium no siempre emite `onspeechend` en modo continuo: el silencio se cuenta también
        // desde el último resultado.
        this.scheduleSilence();
    }

    protected scheduleSilence(): void {
        this.cancelSilenceTimer();
        this.silenceTimerId = window.setTimeout(() => {
            this.silenceTimerId = undefined;
            this.finalizeTurn();
        }, JARVIS_SILENCE_TIMEOUT_MS);
    }

    protected cancelSilenceTimer(): void {
        if (this.silenceTimerId !== undefined) {
            window.clearTimeout(this.silenceTimerId);
            this.silenceTimerId = undefined;
        }
    }

    protected finalizeTurn(): void {
        const text = (this.finalTranscript.length > 0 ? this.finalTranscript : this.interimTranscript).trim();
        this.stopRecognizer();
        if (text.length === 0) {
            if (this.getState() === 'listening') {
                this.setState('idle');
            }
            return;
        }
        this.onTranscriptEmitter.fire({ text, isFinal: true });
        this.dispatchVoicePrompt(text);
    }

    protected handleRecognitionError(recognizer: SpeechRecognizer, code: string | undefined): void {
        if (recognizer !== this.recognizer) {
            return;
        }
        if (isFatalRecognitionError(code)) {
            this.microphoneBlocked = true;
            this.onErrorEmitter.fire('No hay acceso al micrófono. Revisa los permisos y reactiva Jarvis.');
            return;
        }
        if (!code || code === 'no-speech' || code === 'aborted') {
            return;
        }
        if (code === 'network') {
            // En Electron/Chromium sin clave de Google, 'network' llega al instante (403). En vez de
            // bloquear el micrófono, se activa el fallback local: MediaRecorder + backend faster-whisper.
            this.useLocalStt = true;
            this.onErrorEmitter.fire('Reconocimiento en la nube no disponible: cambio a transcripción local.');
            this.switchToLocalStt().catch(error => this.warn('No se pudo activar la transcripción local', error));
            return;
        }
        // Otros errores (servicio caído, etc.) se repetirían en bucle con la auto-escucha: tras
        // varios seguidos se deja de re-armar.
        this.consecutiveRecognitionErrors++;
        if (this.consecutiveRecognitionErrors >= JARVIS_MAX_CONSECUTIVE_RECOGNITION_ERRORS) {
            this.microphoneBlocked = true;
            this.onErrorEmitter.fire(`El reconocimiento de voz no responde (${code}). Silencia y reactiva Jarvis para reintentar.`);
        } else {
            this.onErrorEmitter.fire(`Error del reconocimiento de voz: ${code}`);
        }
    }

    /**
     * El navegador puede cerrar el reconocimiento por su cuenta (tras un error o un tiempo de
     * silencio). Si el turno tenía texto se despacha; si no, se libera el reconocedor para que
     * `startListening` pueda volver a armarlo (antes quedaba asignado y bloqueaba la escucha).
     */
    protected handleRecognitionEnd(recognizer: SpeechRecognizer): void {
        if (recognizer !== this.recognizer) {
            return;
        }
        const pending = (this.finalTranscript.length > 0 ? this.finalTranscript : this.interimTranscript).trim();
        if (pending.length > 0 && this.getState() === 'listening') {
            this.finalizeTurn();
            return;
        }
        this.recognizer = undefined;
        this.stopAudioLevelMeter();
        this.cancelSilenceTimer();
        if (this.getState() === 'listening') {
            this.setState('idle');
        }
    }

    // ---------------------------------------------------------------------------------------------
    // STT local (MediaRecorder + backend faster-whisper)
    // ---------------------------------------------------------------------------------------------

    protected async startLocalListening(): Promise<void> {
        if (!this.isMediaRecorderSupported()) {
            this.warn('MediaRecorder no está soportado en este entorno');
            this.setState('idle');
            return;
        }
        await this.startAudioLevelMeter();
        this.beginLocalRecording();
    }

    /** Pasa del WebSpeech fallido al STT local reutilizando el micrófono ya abierto. */
    protected async switchToLocalStt(): Promise<void> {
        this.stopRecognizerOnly();
        this.cancelSilenceTimer();
        this.finalTranscript = '';
        this.interimTranscript = '';
        await this.startAudioLevelMeter();
        this.beginLocalRecording();
    }

    /** Arranca la grabación tras obtener el micrófono, salvo que se haya silenciado mientras tanto. */
    protected beginLocalRecording(): void {
        if (this.muted || this.microphoneBlocked) {
            this.stopAudioLevelMeter();
            return;
        }
        if (!this.microphoneStream) {
            this.warn('No se pudo acceder al micrófono para la transcripción local');
            this.setState('idle');
            return;
        }
        this.startMediaRecorder();
        this.setState(this.localRecording ? 'listening' : 'idle');
    }

    protected startMediaRecorder(): void {
        if (!this.microphoneStream || this.localRecording) {
            return;
        }
        this.cancelLocalSilenceTimer();
        this.cancelLocalMaxRecordingTimer();
        const options = this.pickMediaRecorderOptions();
        let recorder: MediaRecorder;
        try {
            recorder = options ? new MediaRecorder(this.microphoneStream, options) : new MediaRecorder(this.microphoneStream);
        } catch (error) {
            this.warn('No se pudo crear el grabador de audio', error);
            return;
        }
        // Estado por grabación: el `onstop` es asíncrono y puede llegar después de que haya
        // empezado otra grabación; con estado compartido mezclaría los fragmentos o la cancelación.
        const session: LocalRecordingSession = {
            recorder,
            chunks: [],
            mimeType: recorder.mimeType || options?.mimeType || 'audio/webm',
            speechDetected: false,
            cancelled: false
        };
        recorder.ondataavailable = event => {
            if (event.data && event.data.size > 0) {
                session.chunks.push(event.data);
            }
        };
        recorder.onstop = () => this.handleLocalRecordingStopped(session);
        try {
            recorder.start(250);
        } catch (error) {
            this.warn('No se pudo iniciar la grabación de audio', error);
            return;
        }
        this.localRecording = session;
        this.scheduleLocalMaxRecording();
    }

    protected pickMediaRecorderOptions(): MediaRecorderOptions | undefined {
        const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
        for (const mimeType of candidates) {
            if (MediaRecorder.isTypeSupported(mimeType)) {
                return { mimeType };
            }
        }
        return undefined;
    }

    /** Descarta la grabación en curso (mute, stop, pérdida de foco): no se transcribe nada. */
    protected stopLocalRecording(): void {
        this.cancelLocalSilenceTimer();
        this.cancelLocalMaxRecordingTimer();
        const session = this.localRecording;
        this.localRecording = undefined;
        if (!session) {
            return;
        }
        session.cancelled = true;
        if (session.recorder.state !== 'inactive') {
            try {
                session.recorder.stop();
            } catch {
                // La grabación ya estaba detenida.
            }
        }
    }

    protected updateLocalSpeechDetection(level: number): void {
        const session = this.localRecording;
        if (!session || session.recorder.state === 'inactive') {
            return;
        }
        if (level > JARVIS_SPEECH_RMS_THRESHOLD) {
            session.speechDetected = true;
            this.cancelLocalSilenceTimer();
        } else if (session.speechDetected) {
            this.scheduleLocalSilence();
        }
    }

    protected scheduleLocalSilence(): void {
        if (this.localSilenceTimerId !== undefined) {
            return;
        }
        this.localSilenceTimerId = window.setTimeout(() => {
            this.localSilenceTimerId = undefined;
            this.finalizeLocalTurn();
        }, JARVIS_SILENCE_TIMEOUT_MS);
    }

    protected cancelLocalSilenceTimer(): void {
        if (this.localSilenceTimerId !== undefined) {
            window.clearTimeout(this.localSilenceTimerId);
            this.localSilenceTimerId = undefined;
        }
    }

    protected scheduleLocalMaxRecording(): void {
        this.cancelLocalMaxRecordingTimer();
        this.localMaxRecordingTimerId = window.setTimeout(() => {
            this.localMaxRecordingTimerId = undefined;
            this.finalizeLocalTurn();
        }, JARVIS_MAX_LOCAL_RECORDING_MS);
    }

    protected cancelLocalMaxRecordingTimer(): void {
        if (this.localMaxRecordingTimerId !== undefined) {
            window.clearTimeout(this.localMaxRecordingTimerId);
            this.localMaxRecordingTimerId = undefined;
        }
    }

    /** Cierra el turno (silencio o tope de duración): el `onstop` decide si se transcribe. */
    protected finalizeLocalTurn(): void {
        this.cancelLocalSilenceTimer();
        this.cancelLocalMaxRecordingTimer();
        const session = this.localRecording;
        this.localRecording = undefined;
        if (!session || session.recorder.state === 'inactive') {
            return;
        }
        try {
            session.recorder.stop();
        } catch (error) {
            this.warn('No se pudo detener la grabación de audio', error);
            this.finishLocalTurnWithoutText();
        }
    }

    protected handleLocalRecordingStopped(session: LocalRecordingSession): void {
        if (this.localRecording === session) {
            this.localRecording = undefined;
        }
        if (session.cancelled) {
            return;
        }
        if (!session.speechDetected || session.chunks.length === 0) {
            this.finishLocalTurnWithoutText();
            return;
        }
        // Como en el WebSpeech, el micrófono se suelta al cerrar el turno: así el nivel real no
        // compite con la animación de `thinking`/`speaking`.
        this.stopAudioLevelMeter();
        this.setState('thinking');
        const blob = new Blob(session.chunks, { type: session.mimeType });
        this.transcribeLocalBlob(blob, session.mimeType).catch(error => this.handleLocalTranscriptionError(error));
    }

    protected async transcribeLocalBlob(blob: Blob, mimeType: string): Promise<void> {
        const base64 = await this.blobToBase64(blob);
        const text = await this.orchestratorServer.transcribeAudio(base64, mimeType, this.config.voiceLang);
        const trimmed = (text ?? '').trim();
        if (this.muted) {
            return;
        }
        if (trimmed.length === 0) {
            this.finishLocalTurnWithoutText();
            return;
        }
        this.onTranscriptEmitter.fire({ text: trimmed, isFinal: true });
        await this.dispatchVoicePrompt(trimmed);
    }

    protected handleLocalTranscriptionError(error: unknown): void {
        this.warn('La transcripción local falló', error);
        const detail = error instanceof Error && error.message ? `: ${error.message}` : '.';
        this.onErrorEmitter.fire(`No se pudo transcribir el audio localmente${detail}`);
        this.finishLocalTurnWithoutText();
    }

    /**
     * Turno sin texto: se vuelve a `idle` soltando el micrófono y el controlador re-arma la escucha
     * (igual que en `handleRecognitionEnd`). Si se silenció entre medias no se toca el estado.
     */
    protected finishLocalTurnWithoutText(): void {
        if (this.muted) {
            return;
        }
        if (!this.localRecording) {
            this.stopAudioLevelMeter();
        }
        if (this.getState() === 'listening' || this.getState() === 'thinking') {
            this.setState('idle');
        }
    }

    protected blobToBase64(blob: Blob): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = reader.result;
                if (typeof result === 'string') {
                    const comma = result.indexOf(',');
                    resolve(comma >= 0 ? result.slice(comma + 1) : result);
                } else {
                    reject(new Error('FileReader no devolvió una cadena base64'));
                }
            };
            reader.onerror = () => reject(reader.error ?? new Error('No se pudo leer el audio grabado'));
            reader.readAsDataURL(blob);
        });
    }

    // ---------------------------------------------------------------------------------------------
    // Audio analyzer (RMS en tiempo real para la animación)
    // ---------------------------------------------------------------------------------------------

    protected async startAudioLevelMeter(): Promise<void> {
        if (this.analyser) {
            return;
        }
        if (this.audioMeterPromise) {
            return this.audioMeterPromise;
        }
        this.audioMeterPromise = this.acquireAudioMeter();
        try {
            await this.audioMeterPromise;
        } finally {
            this.audioMeterPromise = undefined;
        }
    }

    protected async acquireAudioMeter(): Promise<void> {
        if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const context = this.createAudioContext();
            if (!context) {
                stream.getTracks().forEach(track => track.stop());
                return;
            }
            const source = context.createMediaStreamSource(stream);
            const analyser = context.createAnalyser();
            analyser.fftSize = 512;
            source.connect(analyser);
            this.microphoneStream = stream;
            this.audioContext = context;
            this.analyser = analyser;
            this.scheduleAudioLevelTick();
        } catch (error) {
            this.warn('No se pudo acceder al micrófono para el medidor de audio', error);
            if (this.isPermissionDenied(error)) {
                this.microphoneBlocked = true;
                this.onErrorEmitter.fire('No hay acceso al micrófono. Revisa los permisos y reactiva Jarvis.');
            } else if (this.errorName(error) === 'NotFoundError') {
                // Sin dispositivo de entrada el re-armado (400 ms) reintentaría en bucle.
                this.microphoneBlocked = true;
                this.onErrorEmitter.fire('No se encontró ningún micrófono. Conecta uno y reactiva Jarvis.');
            }
        }
    }

    protected isPermissionDenied(error: unknown): boolean {
        const name = this.errorName(error);
        return name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError';
    }

    protected errorName(error: unknown): unknown {
        return error && typeof error === 'object' ? (error as { name?: unknown }).name : undefined;
    }

    protected createAudioContext(): AudioContext | undefined {
        const windowWithAudio = window as unknown as {
            AudioContext?: typeof AudioContext;
            webkitAudioContext?: typeof AudioContext;
        };
        const ctor = windowWithAudio.AudioContext ?? windowWithAudio.webkitAudioContext;
        return ctor ? new ctor() : undefined;
    }

    protected scheduleAudioLevelTick(): void {
        if (!this.analyser || this.audioRafId !== undefined) {
            return;
        }
        const tick = (): void => {
            this.audioRafId = undefined;
            const analyser = this.analyser;
            if (!analyser) {
                return;
            }
            const data = new Uint8Array(analyser.fftSize);
            analyser.getByteTimeDomainData(data);
            const rawLevel = computeRmsLevel(data, 1);
            this.currentAudioLevel = rawLevel;
            this.onAudioLevelEmitter.fire(Math.min(1, rawLevel * JARVIS_RMS_GAIN));
            this.updateLocalSpeechDetection(rawLevel);
            this.scheduleAudioLevelTick();
        };
        this.audioRafId = window.requestAnimationFrame(tick);
    }

    protected stopAudioLevelMeter(): void {
        if (this.audioRafId !== undefined) {
            window.cancelAnimationFrame(this.audioRafId);
            this.audioRafId = undefined;
        }
        if (this.microphoneStream) {
            this.microphoneStream.getTracks().forEach(track => track.stop());
            this.microphoneStream = undefined;
        }
        if (this.audioContext) {
            this.audioContext.close().catch(() => undefined);
            this.audioContext = undefined;
        }
        this.analyser = undefined;
        this.currentAudioLevel = 0;
        this.onAudioLevelEmitter.fire(0);
    }

    // ---------------------------------------------------------------------------------------------
    // TTS
    // ---------------------------------------------------------------------------------------------

    protected isTtsSupported(): boolean {
        return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
    }

    protected pickVoice(): SpeechSynthesisVoice | undefined {
        if (!this.isTtsSupported()) {
            return undefined;
        }
        const voices = window.speechSynthesis.getVoices();
        if (voices.length === 0) {
            return undefined;
        }
        const preferred = [this.config.voiceLang, ...JARVIS_PREFERRED_VOICE_LANGS];
        for (const lang of preferred) {
            const normalized = lang.trim().toLowerCase();
            if (normalized.length === 0) {
                continue;
            }
            const match = voices.find(voice => voice.lang.toLowerCase().startsWith(normalized));
            if (match) {
                return match;
            }
        }
        const anySpanish = voices.find(voice => voice.lang.toLowerCase().startsWith('es'));
        return anySpanish ?? voices[0];
    }

    protected startSpeakingSimulation(): void {
        this.stopSpeakingSimulation();
        const startedAt = Date.now();
        const tick = (): void => {
            this.speakingSimulationId = undefined;
            if (this.getState() !== 'speaking') {
                return;
            }
            const elapsed = (Date.now() - startedAt) / 1000;
            const level = 0.5 + 0.5 * Math.abs(Math.sin(elapsed * 8));
            this.onAudioLevelEmitter.fire(level);
            this.speakingSimulationId = window.setTimeout(tick, 50);
        };
        this.speakingSimulationId = window.setTimeout(tick, 0);
    }

    protected stopSpeakingSimulation(): void {
        if (this.speakingSimulationId !== undefined) {
            window.clearTimeout(this.speakingSimulationId);
            this.speakingSimulationId = undefined;
        }
        this.onAudioLevelEmitter.fire(0);
    }

    protected finishSpeaking(): void {
        this.stopSpeakingSimulation();
        this.currentUtterance = undefined;
        if (this.getState() === 'speaking') {
            this.setState('idle');
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Despacho al Agente Líder
    // ---------------------------------------------------------------------------------------------

    protected handleVoiceDispatchOutcome(outcome: FokkusSwarmDispatchOutcome): void {
        // Solo el turno que despachó Jarvis: un mensaje escrito a mano en el chat no se locuta.
        if (outcome.prompt !== this.voiceDispatchPrompt) {
            return;
        }
        if (outcome.busy) {
            this.onErrorEmitter.fire('Fokkus Team está ocupado: tu mensaje quedó en el cuadro de texto del chat.');
            this.finishVoiceDispatch(undefined);
            return;
        }
        if (outcome.error !== undefined) {
            this.onErrorEmitter.fire(`No se pudo despachar el mensaje de voz: ${outcome.error}`);
            this.finishVoiceDispatch(undefined);
            return;
        }
        this.finishVoiceDispatch(outcome.result ? this.extractAssistantResponse(outcome.result) : undefined);
    }

    protected extractAssistantResponse(result: SwarmDispatchResult): string | undefined {
        const completed = result.roleResults.find(agent => agent.status === 'completed' && agent.output.trim().length > 0);
        return completed ? completed.output : undefined;
    }

    protected finishVoiceDispatch(assistantText: string | undefined): void {
        if (!this.voiceDispatchActive) {
            return;
        }
        this.voiceDispatchActive = false;
        this.voiceDispatchPrompt = undefined;
        this.clearVoiceDispatchHandlers();
        if (assistantText !== undefined) {
            const cleaned = this.cleanSpeechText(assistantText);
            if (cleaned.length > 0) {
                this.onAssistantSpeechEmitter.fire(cleaned);
                this.speak(cleaned);
                return;
            }
        }
        this.setState('idle');
    }

    protected clearVoiceDispatchHandlers(): void {
        if (this.voiceDispatchSubscription) {
            if (typeof this.voiceDispatchSubscription.dispose === 'function') {
                this.voiceDispatchSubscription.dispose();
            }
            this.voiceDispatchSubscription = undefined;
        }
        if (this.voiceDispatchTimeoutId !== undefined) {
            window.clearTimeout(this.voiceDispatchTimeoutId);
            this.voiceDispatchTimeoutId = undefined;
        }
    }

    protected cleanSpeechText(text: string): string {
        return text
            .replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
            .replace(/<think>[\s\S]*?<\/think>/gi, '')
            .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
            .replace(/`([^`]+)`/g, '$1')
            .trim();
    }

    // ---------------------------------------------------------------------------------------------
    // Estado y configuración
    // ---------------------------------------------------------------------------------------------

    protected setState(next: JarvisState): void {
        if (this.state === next) {
            return;
        }
        this.state = next;
        this.onStateChangedEmitter.fire(next);
    }

    protected loadConfig(): JarvisConfig {
        try {
            return parseStoredJarvisConfig(window.localStorage.getItem(JARVIS_STORAGE_KEY));
        } catch (error) {
            this.warn('No se pudo leer la configuración de Jarvis', error);
        }
        return { ...DEFAULT_JARVIS_CONFIG };
    }

    protected persistConfig(): void {
        try {
            window.localStorage.setItem(JARVIS_STORAGE_KEY, JSON.stringify(this.config));
        } catch (error) {
            this.warn('No se pudo guardar la configuración de Jarvis', error);
        }
    }

    protected warn(message: string, error?: unknown): void {
        if (error !== undefined) {
            console.warn(`[fokkus-jarvis] ${message}`, error);
        } else {
            console.warn(`[fokkus-jarvis] ${message}`);
        }
    }
}
