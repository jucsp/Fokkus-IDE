/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar';
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { inject, injectable } from '@theia/core/shared/inversify';
import { JARVIS_STATE_LABELS } from '../common/jarvis-logic';
import { JarvisController } from './jarvis-controller';

export namespace JarvisCommands {
    const CATEGORY = 'Fokkus';
    export const TOGGLE: Command = { id: 'fokkus:toggle-jarvis', category: CATEGORY, label: 'Jarvis: Mostrar u ocultar el asistente de voz' };
    export const TOGGLE_MUTE: Command = { id: 'fokkus:jarvis-toggle-mute', category: CATEGORY, label: 'Jarvis: Silenciar o activar el micrófono' };
    export const TOGGLE_GAMING_MODE: Command = { id: 'fokkus:jarvis-toggle-gaming-mode', category: CATEGORY, label: 'Jarvis: Modo Gaming (seguir oyendo en segundo plano)' };
    export const TOGGLE_OVERLAY: Command = { id: 'fokkus:jarvis-toggle-overlay', category: CATEGORY, label: 'Jarvis: Flotar sobre otras ventanas' };
}

const JARVIS_STATUS_BAR_ID = 'fokkus-jarvis-status';

/** Botón de Jarvis en la barra de estado y comandos de la paleta (Issue #27, Fase 3). */
@injectable()
export class JarvisContribution implements CommandContribution, FrontendApplicationContribution {

    @inject(JarvisController)
    protected readonly controller: JarvisController;

    @inject(StatusBar)
    protected readonly statusBar: StatusBar;

    onStart(): void {
        this.controller.onDidChange(() => this.updateStatusBar());
        this.controller.audio.onStateChanged(() => this.updateStatusBar());
        this.controller.audio.onConfigChanged(() => this.updateStatusBar());
        this.controller.restore();
        this.updateStatusBar();
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(JarvisCommands.TOGGLE, {
            execute: () => this.controller.toggle()
        });
        commands.registerCommand(JarvisCommands.TOGGLE_MUTE, {
            isEnabled: () => this.controller.isVisible(),
            execute: () => this.controller.audio.toggleMute()
        });
        commands.registerCommand(JarvisCommands.TOGGLE_GAMING_MODE, {
            isToggled: () => this.controller.audio.getConfig().gamingMode,
            execute: () => this.controller.audio.toggleGamingMode()
        });
        commands.registerCommand(JarvisCommands.TOGGLE_OVERLAY, {
            isVisible: () => this.controller.isElectron(),
            isToggled: () => this.controller.isOverlayRequested(),
            execute: () => this.controller.toggleOverlay()
        });
    }

    protected updateStatusBar(): void {
        const visible = this.controller.isVisible();
        const state = this.controller.audio.getState();
        const gaming = this.controller.audio.getConfig().gamingMode;
        const icon = !visible || state === 'muted' ? 'fa-microphone-slash' : 'fa-microphone';
        const detail = visible ? `${JARVIS_STATE_LABELS[state]}${gaming ? ' · Modo Gaming' : ''}` : 'Oculto';
        this.statusBar.setElement(JARVIS_STATUS_BAR_ID, {
            name: 'Jarvis',
            text: `$(${icon}) Jarvis`,
            tooltip: `Jarvis: Asistente de Voz — ${detail}\nClic para ${visible ? 'ocultar' : 'mostrar'} la burbuja`,
            alignment: StatusBarAlignment.RIGHT,
            priority: 120,
            className: visible ? `fokkus-jarvis-status fokkus-jarvis-status--${state}` : 'fokkus-jarvis-status',
            command: JarvisCommands.TOGGLE.id
        }).catch(error => console.warn('[fokkus-jarvis] No se pudo actualizar la barra de estado', error));
    }
}
