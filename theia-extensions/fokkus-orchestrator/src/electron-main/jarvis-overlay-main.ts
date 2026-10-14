/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { app, BrowserWindow, BrowserWindowConstructorOptions, HandlerDetails, WebContents, WindowOpenHandlerResponse } from '@theia/core/electron-shared/electron';
import { ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';
import { injectable } from '@theia/core/shared/inversify';
import { JARVIS_OVERLAY_FRAME_NAME, JARVIS_OVERLAY_HEIGHT, JARVIS_OVERLAY_WIDTH, JarvisOverlayWindowServer } from '../common/jarvis-protocol';

type WindowOpenHandler = (details: HandlerDetails) => WindowOpenHandlerResponse;

const OVERLAY_WINDOW_OPTIONS: BrowserWindowConstructorOptions = {
    width: JARVIS_OVERLAY_WIDTH,
    height: JARVIS_OVERLAY_HEIGHT,
    minWidth: JARVIS_OVERLAY_WIDTH,
    minHeight: JARVIS_OVERLAY_HEIGHT,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true
};

/**
 * Ventana overlay de Jarvis en Electron (Issue #27, Fase 3).
 *
 * El frontend abre la burbuja con `window.open('secondary-window.html', 'fokkus-jarvis-overlay')`
 * (el mismo mecanismo que usa Theia para extraer vistas) y la pinta con un portal de React. Aquí se
 * cambian las opciones de ESA ventana —sin marco, transparente, Always-On-Top— y se expone el
 * click-through (`setIgnoreMouseEvents`) para el Modo Gaming.
 *
 * Theia instala su `setWindowOpenHandler` en `web-contents-created`; este listener se antepone
 * (`prependListener`) para envolver el handler que Theia instale y no reemplazarlo: Theia sigue
 * validando la URL y el resto de ventanas no cambia.
 */
@injectable()
export class JarvisOverlayMainContribution implements ElectronMainApplicationContribution, JarvisOverlayWindowServer {

    protected overlayWindow: BrowserWindow | undefined;

    onStart(): void {
        app.prependListener('web-contents-created', (_event, webContents) => this.wrapWindowOpenHandler(webContents));
    }

    async setIgnoreMouseEvents(ignore: boolean, forward: boolean): Promise<boolean> {
        const overlay = this.liveOverlay();
        if (!overlay) {
            return false;
        }
        overlay.setIgnoreMouseEvents(ignore, ignore ? { forward } : undefined);
        return true;
    }

    async setAlwaysOnTop(onTop: boolean): Promise<boolean> {
        const overlay = this.liveOverlay();
        if (!overlay) {
            return false;
        }
        if (onTop) {
            // 'screen-saver' mantiene la burbuja sobre apps a pantalla completa (juegos).
            overlay.setAlwaysOnTop(true, 'screen-saver');
            overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        } else {
            overlay.setAlwaysOnTop(false);
            overlay.setVisibleOnAllWorkspaces(false);
        }
        return true;
    }

    protected wrapWindowOpenHandler(webContents: WebContents): void {
        const install: (handler: WindowOpenHandler) => void = webContents.setWindowOpenHandler.bind(webContents);
        webContents.setWindowOpenHandler = (handler: WindowOpenHandler) => install((details: HandlerDetails): WindowOpenHandlerResponse => {
            const response = handler(details);
            if (details.frameName !== JARVIS_OVERLAY_FRAME_NAME || response.action !== 'allow') {
                return response;
            }
            return {
                ...response,
                overrideBrowserWindowOptions: { ...response.overrideBrowserWindowOptions, ...OVERLAY_WINDOW_OPTIONS }
            };
        });
        webContents.on('did-create-window', (window, details) => {
            if (details.frameName === JARVIS_OVERLAY_FRAME_NAME) {
                this.trackOverlay(window);
            }
        });
    }

    protected trackOverlay(window: BrowserWindow): void {
        this.overlayWindow = window;
        window.setMenuBarVisibility(false);
        // Hasta que el renderer diga lo contrario (cursor sobre la burbuja), los clics atraviesan
        // el rectángulo transparente.
        window.setIgnoreMouseEvents(true, { forward: true });
        this.setAlwaysOnTop(true).catch(() => undefined);
        window.once('closed', () => {
            if (this.overlayWindow === window) {
                this.overlayWindow = undefined;
            }
        });
    }

    protected liveOverlay(): BrowserWindow | undefined {
        const overlay = this.overlayWindow;
        return overlay && !overlay.isDestroyed() ? overlay : undefined;
    }
}
