/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AbstractViewContribution, ApplicationShell, FrontendApplicationContribution, FrontendApplication, CommonCommands, CommonMenus, WidgetManager } from '@theia/core/lib/browser';
import { CommandRegistry } from '@theia/core/lib/common';
import { MenuContribution, MenuModelRegistry } from '@theia/core/lib/common/menu';
import { inject, injectable } from '@theia/core/shared/inversify';
import { FokkusOrchestratorServer } from '../common/fokkus-orchestrator-protocol';
import {
    FOKKUS_CHAT_WIDGET_ID,
    FOKKUS_ORCHESTRATOR_TOGGLE_COMMAND_ID,
    FOKKUS_OPEN_SETTINGS_COMMAND_ID,
    FokkusChatWidget,
    FokkusSettingsWidget
} from './fokkus-orchestrator-widget';

export { FOKKUS_CHAT_WIDGET_ID, FOKKUS_ORCHESTRATOR_TOGGLE_COMMAND_ID, FOKKUS_OPEN_SETTINGS_COMMAND_ID };
export const FOKKUS_SETTINGS_WIDGET_ID = FokkusSettingsWidget.ID;

const OS_CLASS_PREFIX = 'fokkus-os-';

function mapDesktopEnvironmentToClass(platform: string, desktop: string): string {
    if (platform === 'darwin') {
        return 'fokkus-os-mac';
    }
    if (platform === 'win32') {
        return 'fokkus-os-win';
    }
    if (platform === 'linux') {
        const normalized = desktop.toLowerCase();
        if (normalized.includes('kde')) {
            return 'fokkus-os-kde';
        }
        if (normalized.includes('ubuntu')) {
            return 'fokkus-os-ubuntu';
        }
        if (normalized.includes('gnome')) {
            return 'fokkus-os-gnome';
        }
        // Fallback para Linux: si XDG_CURRENT_DESKTOP llega vacío o no reconocido,
        // asumimos KDE en lugar de GNOME (caso reportado en Fedora KDE).
        return 'fokkus-os-kde';
    }
    return 'fokkus-os-gnome';
}

@injectable()
export class FokkusOrchestratorContribution extends AbstractViewContribution<FokkusChatWidget> implements FrontendApplicationContribution, MenuContribution {

    @inject(FokkusOrchestratorServer)
    protected readonly orchestratorServer: FokkusOrchestratorServer;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    constructor() {
        super({
            widgetId: FokkusChatWidget.ID,
            widgetName: FokkusChatWidget.LABEL,
            defaultWidgetOptions: {
                area: 'left',
                rank: 100
            },
            toggleCommandId: FOKKUS_ORCHESTRATOR_TOGGLE_COMMAND_ID
        });
    }

    async onStart(app: FrontendApplication): Promise<void> {
        this.openView({ activate: true });
        this.applyDesktopEnvironmentClass();
    }

    async registerCommands(commands: CommandRegistry): Promise<void> {
        super.registerCommands(commands);
        commands.registerCommand({ id: FOKKUS_OPEN_SETTINGS_COMMAND_ID, label: 'Fokkus: Abrir Configuración' }, {
            execute: () => this.openSettingsWidget()
        });
    }

    private async openSettingsWidget(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget<FokkusSettingsWidget>(FokkusSettingsWidget.ID);
        if (!widget.isAttached) {
            await this.shell.addWidget(widget, { area: 'main' });
        }
        this.shell.activateWidget(widget.id);
    }

    private async applyDesktopEnvironmentClass(): Promise<void> {
        try {
            const environment = await this.orchestratorServer.getDesktopEnvironment();
            const className = mapDesktopEnvironmentToClass(environment.platform, environment.desktop);
            document.body.classList.forEach(name => {
                if (name.startsWith(OS_CLASS_PREFIX)) {
                    document.body.classList.remove(name);
                }
            });
            document.body.classList.add(className);
        } catch (error) {
            console.error('[fokkus-orchestrator] No se pudo detectar el entorno de escritorio', error);
        }
    }

    registerMenus(menus: MenuModelRegistry): void {
        // Añadir Toggle Right Panel al menú contextual de las barras de herramientas de pestañas
        // Nota: SHELL_TABBAR_CONTEXT_MENU corresponde a ['shell-tabbar-context-menu']
        menus.registerMenuAction(['shell-tabbar-context-menu'], {
            commandId: CommonCommands.TOGGLE_RIGHT_PANEL.id,
            order: 'z_right_panel'
        });

        // Theia core no registra "Toggle Right Panel" en View -> Appearance por defecto
        // (solo Toggle Bottom Panel / Status Bar / Menu Bar), así que lo agregamos aquí.
        menus.registerMenuAction(CommonMenus.VIEW_APPEARANCE_SUBMENU_BAR, {
            commandId: CommonCommands.TOGGLE_RIGHT_PANEL.id,
            label: 'Toggle Right Panel Visibility',
            order: '4'
        });
    }
}
