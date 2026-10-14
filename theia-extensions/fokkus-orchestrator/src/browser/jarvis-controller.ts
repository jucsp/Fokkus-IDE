/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { MessageService } from '@theia/core/lib/common/message-service';
import { isOSX, isWindows } from '@theia/core/lib/common/os';
import { inject, injectable, optional, postConstruct } from '@theia/core/shared/inversify';
import { environment } from '@theia/core/shared/@theia/application-package/lib/environment';
import { Root } from '@theia/core/shared/react-dom/client';
import {
    clampBubblePosition,
    JarvisListenContext,
    JarvisPoint,
    resolveOverlayMouseMode,
    shouldAutoListen,
    shouldCloseMicrophone,
    shouldReleaseMicrophone
} from '../common/jarvis-logic';
import {
    JARVIS_OVERLAY_FRAME_NAME,
    JARVIS_OVERLAY_HEIGHT,
    JARVIS_OVERLAY_WIDTH,
    JarvisAudioService,
    JarvisOverlayWindowServer
} from '../common/jarvis-protocol';
import { FokkusChatDispatcher } from './fokkus-chat-dispatch';
import { JARVIS_BUBBLE_SIZE, mountJarvisBubble } from './jarvis-bubble-widget';

/** Posición de la burbuja (in-app: px del viewport; overlay: px de pantalla) y modo overlay. */
interface JarvisUiState {
    inAppPosition?: JarvisPoint;
    overlayPosition?: JarvisPoint;
    overlay: boolean;
}

const JARVIS_UI_STORAGE_KEY = 'fokkus.jarvis.ui';
/** Pausa antes de re-armar el micrófono: evita encadenar start/stop si el navegador lo cierra al instante. */
const JARVIS_REARM_DELAY_MS = 400;
/** Ancho del bloque burbuja + transcripción (in-app). */
export const JARVIS_PANEL_WIDTH = 260;

interface ElectronCoreWindow {
    electronTheiaCore?: {
        setSecondaryWindowCloseRequestHandler?(windowName: string, handler: () => Promise<boolean>): void;
    };
}

/**
 * Controlador de la burbuja de Jarvis (Issue #27, Fase 3).
 *
 * - Visibilidad (persistida en `JarvisConfig.enabled`) y montaje del árbol React.
 * - Destino del portal: capa fija dentro del IDE o, en Electron, una ventana secundaria
 *   transparente Always-On-Top (`window.open` + módulo `electronMain`).
 * - Política de escucha: re-arma el micrófono en `idle` y lo suelta al perder el foco salvo en
 *   Modo Gaming (`shouldAutoListen` / `shouldReleaseMicrophone`).
 * - Click-through de la ventana overlay según Modo Gaming y hover (`resolveOverlayMouseMode`).
 */
@injectable()
export class JarvisController {

    @inject(JarvisAudioService)
    readonly audio: JarvisAudioService;

    @inject(FokkusChatDispatcher)
    protected readonly chatDispatcher: FokkusChatDispatcher;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(JarvisOverlayWindowServer) @optional()
    protected readonly overlayServer: JarvisOverlayWindowServer | undefined;

    protected readonly onDidChangeEmitter = new Emitter<void>();
    /** Cambió la visibilidad, el destino del portal o el modo overlay. */
    readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

    protected readonly toDispose = new DisposableCollection(this.onDidChangeEmitter);
    protected ui: JarvisUiState = { overlay: false };
    protected visible = false;
    protected appFocused = true;
    protected hoveringBubble = false;

    protected root: Root | undefined;
    protected rootHost: HTMLElement | undefined;
    protected inAppLayer: HTMLElement | undefined;
    protected overlayWindow: Window | undefined;
    protected overlayLayer: HTMLElement | undefined;
    protected rearmTimerId: number | undefined;

    @postConstruct()
    protected init(): void {
        this.ui = this.loadUiState();
        this.appFocused = typeof document !== 'undefined' ? document.hasFocus() : true;
        this.toDispose.push(this.audio.onStateChanged(() => this.evaluateListening()));
        this.toDispose.push(this.audio.onConfigChanged(() => {
            this.applyOverlayMouseMode();
            this.evaluateListening();
        }));
        const onFocus = (): void => this.setAppFocused(true);
        const onBlur = (): void => this.setAppFocused(this.overlayHasFocus());
        window.addEventListener('focus', onFocus);
        window.addEventListener('blur', onBlur);
        this.toDispose.push({
            dispose: () => {
                window.removeEventListener('focus', onFocus);
                window.removeEventListener('blur', onBlur);
            }
        });
    }

    /** Restaura la burbuja si quedó visible en la sesión anterior. */
    restore(): void {
        if (this.audio.getConfig().enabled) {
            this.show();
        }
    }

    isVisible(): boolean {
        return this.visible;
    }

    isElectron(): boolean {
        return environment.electron.is();
    }

    isOverlayActive(): boolean {
        return this.overlayWindow !== undefined && this.overlayLayer !== undefined;
    }

    isOverlayRequested(): boolean {
        return this.ui.overlay;
    }

    toggle(): void {
        if (this.visible) {
            this.hide();
        } else {
            this.show();
        }
    }

    show(): void {
        if (!this.audio.isSupported()) {
            this.messageService.warn('Jarvis: este entorno no soporta reconocimiento o síntesis de voz (Web Speech API).');
        }
        if (!this.audio.getConfig().enabled) {
            this.audio.updateConfig({ enabled: true });
        }
        this.visible = true;
        this.mount();
        if (this.ui.overlay && this.isElectron()) {
            this.openOverlay();
        }
        this.onDidChangeEmitter.fire();
        this.evaluateListening();
    }

    hide(): void {
        if (this.audio.getConfig().enabled) {
            this.audio.updateConfig({ enabled: false });
        }
        this.visible = false;
        this.cancelRearm();
        this.audio.stopListening();
        this.audio.stopSpeaking();
        this.closeOverlay();
        this.unmount();
        this.onDidChangeEmitter.fire();
    }

    /** Activa/desactiva la ventana flotante sobre otras aplicaciones (solo Electron). */
    toggleOverlay(): void {
        if (!this.isElectron()) {
            this.messageService.info('Jarvis: la ventana flotante sobre otras aplicaciones solo existe en la app de escritorio.');
            return;
        }
        this.ui = { ...this.ui, overlay: !this.ui.overlay };
        this.persistUiState();
        if (this.ui.overlay && this.visible) {
            this.openOverlay();
        } else if (!this.ui.overlay) {
            this.closeOverlay();
        }
        this.onDidChangeEmitter.fire();
    }

    async openChat(): Promise<void> {
        window.focus();
        await this.chatDispatcher.open();
    }

    // ---------------------------------------------------------------------------------------------
    // Portal
    // ---------------------------------------------------------------------------------------------

    /** Elemento donde se pinta la burbuja: la ventana overlay si está lista, si no la capa del IDE. */
    getPortalTarget(): HTMLElement | undefined {
        return this.overlayLayer ?? this.inAppLayer;
    }

    getInAppPosition(): JarvisPoint {
        const fallback = { x: window.innerWidth - JARVIS_PANEL_WIDTH - 24, y: window.innerHeight - JARVIS_BUBBLE_SIZE - 120 };
        return this.clampInApp(this.ui.inAppPosition ?? fallback);
    }

    clampInApp(position: JarvisPoint): JarvisPoint {
        return clampBubblePosition(position, { width: JARVIS_PANEL_WIDTH, height: JARVIS_BUBBLE_SIZE + 40 }, { width: window.innerWidth, height: window.innerHeight });
    }

    saveInAppPosition(position: JarvisPoint): void {
        this.ui = { ...this.ui, inAppPosition: this.clampInApp(position) };
        this.persistUiState();
    }

    /** Arrastre en modo overlay: mueve la ventana de Electron, no el elemento. */
    moveOverlayBy(dx: number, dy: number): void {
        const overlay = this.overlayWindow;
        if (!overlay || overlay.closed) {
            return;
        }
        overlay.moveTo(Math.round(overlay.screenX + dx), Math.round(overlay.screenY + dy));
    }

    saveOverlayPosition(): void {
        const overlay = this.overlayWindow;
        if (!overlay || overlay.closed) {
            return;
        }
        this.ui = { ...this.ui, overlayPosition: { x: overlay.screenX, y: overlay.screenY } };
        this.persistUiState();
    }

    setBubbleHover(hovering: boolean): void {
        if (this.hoveringBubble === hovering) {
            return;
        }
        this.hoveringBubble = hovering;
        this.applyOverlayMouseMode();
    }

    protected mount(): void {
        if (!this.inAppLayer) {
            const layer = document.createElement('div');
            layer.className = 'fokkus-jarvis-layer';
            document.body.appendChild(layer);
            this.inAppLayer = layer;
        }
        if (!this.root) {
            const host = document.createElement('div');
            host.className = 'fokkus-jarvis-root';
            host.style.display = 'none';
            document.body.appendChild(host);
            this.rootHost = host;
            this.root = mountJarvisBubble(host, this);
        }
    }

    protected unmount(): void {
        this.root?.unmount();
        this.root = undefined;
        this.rootHost?.remove();
        this.rootHost = undefined;
        this.inAppLayer?.remove();
        this.inAppLayer = undefined;
    }

    // ---------------------------------------------------------------------------------------------
    // Ventana overlay (Electron)
    // ---------------------------------------------------------------------------------------------

    protected openOverlay(): void {
        if (this.overlayWindow && !this.overlayWindow.closed) {
            return;
        }
        const position = this.ui.overlayPosition ?? {
            x: window.screenX + window.outerWidth - JARVIS_OVERLAY_WIDTH - 32,
            y: window.screenY + window.outerHeight - JARVIS_OVERLAY_HEIGHT - 48
        };
        const features = `popup=1,width=${JARVIS_OVERLAY_WIDTH},height=${JARVIS_OVERLAY_HEIGHT},left=${Math.round(position.x)},top=${Math.round(position.y)}`;
        // secondary-window.html es la página que Theia genera para las vistas extraídas; el proceso
        // main solo deja abrir esa URL y le aplica las opciones de overlay por el nombre del frame.
        const overlay = window.open('secondary-window.html', JARVIS_OVERLAY_FRAME_NAME, features) ?? undefined;
        if (!overlay) {
            this.messageService.warn('Jarvis: no se pudo abrir la ventana flotante; la burbuja sigue dentro del IDE.');
            return;
        }
        this.overlayWindow = overlay;
        (window as unknown as ElectronCoreWindow).electronTheiaCore?.setSecondaryWindowCloseRequestHandler?.(
            JARVIS_OVERLAY_FRAME_NAME, () => Promise.resolve(true));
        overlay.addEventListener('DOMContentLoaded', () => this.prepareOverlay(overlay));
    }

    protected prepareOverlay(overlay: Window): void {
        if (overlay !== this.overlayWindow) {
            return;
        }
        const doc = overlay.document;
        doc.title = 'Jarvis';
        for (const element of [doc.documentElement, doc.body]) {
            element.style.background = 'transparent';
            element.style.overflow = 'hidden';
        }
        // Los estilos de webpack viven en el <head> del IDE: se copian solo los de Jarvis.
        document.head.querySelectorAll('style').forEach(style => {
            if (style.textContent?.includes('.fokkus-jarvis-layer')) {
                doc.head.appendChild(style.cloneNode(true));
            }
        });
        doc.getElementById('widget-host')?.remove();
        const layer = doc.createElement('div');
        layer.className = 'fokkus-jarvis-layer fokkus-jarvis-layer--overlay';
        doc.body.appendChild(layer);
        this.overlayLayer = layer;
        overlay.addEventListener('pagehide', () => this.handleOverlayClosed(overlay));
        overlay.addEventListener('focus', () => this.setAppFocused(true));
        overlay.addEventListener('blur', () => this.setAppFocused(document.hasFocus()));
        this.applyOverlayMouseMode();
        this.onDidChangeEmitter.fire();
    }

    protected closeOverlay(): void {
        const overlay = this.overlayWindow;
        this.overlayWindow = undefined;
        this.overlayLayer = undefined;
        this.hoveringBubble = false;
        if (overlay && !overlay.closed) {
            overlay.close();
        }
        this.onDidChangeEmitter.fire();
    }

    /** El usuario cerró la ventana overlay (Alt+F4, etc.): la burbuja vuelve al IDE. */
    protected handleOverlayClosed(overlay: Window): void {
        if (overlay !== this.overlayWindow) {
            return;
        }
        this.overlayWindow = undefined;
        this.overlayLayer = undefined;
        this.hoveringBubble = false;
        this.ui = { ...this.ui, overlay: false };
        this.persistUiState();
        this.onDidChangeEmitter.fire();
    }

    protected overlayHasFocus(): boolean {
        const overlay = this.overlayWindow;
        try {
            return !!overlay && !overlay.closed && overlay.document.hasFocus();
        } catch {
            return false;
        }
    }

    protected applyOverlayMouseMode(): void {
        if (!this.overlayServer || !this.isOverlayActive()) {
            return;
        }
        const mode = resolveOverlayMouseMode(this.audio.getConfig().gamingMode, this.hoveringBubble, this.isForwardSupported());
        this.overlayServer.setIgnoreMouseEvents(mode.ignore, mode.forward)
            .catch(error => console.warn('[fokkus-jarvis] No se pudo cambiar el click-through de la ventana overlay', error));
    }

    /** Electron solo reenvía `mousemove` con la ventana ignorada en Windows y macOS. */
    protected isForwardSupported(): boolean {
        return isWindows || isOSX;
    }

    // ---------------------------------------------------------------------------------------------
    // Política de escucha
    // ---------------------------------------------------------------------------------------------

    protected setAppFocused(focused: boolean): void {
        if (this.appFocused === focused) {
            return;
        }
        this.appFocused = focused;
        this.evaluateListening();
    }

    protected listenContext(): JarvisListenContext {
        const config = this.audio.getConfig();
        return {
            enabled: this.visible && config.enabled,
            muted: this.audio.isMuted(),
            microphoneBlocked: this.audio.isMicrophoneBlocked(),
            state: this.audio.getState(),
            gamingMode: config.gamingMode,
            appFocused: this.appFocused
        };
    }

    protected evaluateListening(): void {
        const context = this.listenContext();
        if (shouldReleaseMicrophone(context) || shouldCloseMicrophone(context)) {
            this.cancelRearm();
            this.audio.stopListening();
            return;
        }
        if (shouldAutoListen(context)) {
            this.scheduleRearm();
        } else {
            this.cancelRearm();
        }
    }

    protected scheduleRearm(): void {
        if (this.rearmTimerId !== undefined) {
            return;
        }
        this.rearmTimerId = window.setTimeout(() => {
            this.rearmTimerId = undefined;
            if (shouldAutoListen(this.listenContext())) {
                this.audio.startListening().catch(error => console.warn('[fokkus-jarvis] No se pudo iniciar la escucha', error));
            }
        }, JARVIS_REARM_DELAY_MS);
    }

    protected cancelRearm(): void {
        if (this.rearmTimerId !== undefined) {
            window.clearTimeout(this.rearmTimerId);
            this.rearmTimerId = undefined;
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Persistencia de la UI
    // ---------------------------------------------------------------------------------------------

    protected loadUiState(): JarvisUiState {
        try {
            const raw = window.localStorage.getItem(JARVIS_UI_STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) as Partial<JarvisUiState> : undefined;
            if (parsed && typeof parsed === 'object') {
                return {
                    overlay: parsed.overlay === true,
                    inAppPosition: isPoint(parsed.inAppPosition) ? parsed.inAppPosition : undefined,
                    overlayPosition: isPoint(parsed.overlayPosition) ? parsed.overlayPosition : undefined
                };
            }
        } catch (error) {
            console.warn('[fokkus-jarvis] No se pudo leer la posición de la burbuja', error);
        }
        return { overlay: false };
    }

    protected persistUiState(): void {
        try {
            window.localStorage.setItem(JARVIS_UI_STORAGE_KEY, JSON.stringify(this.ui));
        } catch (error) {
            console.warn('[fokkus-jarvis] No se pudo guardar la posición de la burbuja', error);
        }
    }
}

function isPoint(value: unknown): value is JarvisPoint {
    return !!value && typeof value === 'object'
        && Number.isFinite((value as JarvisPoint).x) && Number.isFinite((value as JarvisPoint).y);
}
