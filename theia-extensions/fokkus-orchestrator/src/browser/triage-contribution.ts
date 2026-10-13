/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AbstractViewContribution, FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { CommandRegistry } from '@theia/core/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { TriageInboxWidget } from './triage-inbox-widget';
import { TRIAGE_OPEN_COMMAND_ID } from './triage-service';

export const TRIAGE_PANEL_TOGGLE_COMMAND_ID = 'fokkus-triage:toggle';
const TRIAGE_LAYOUT_ADDED_KEY = 'fokkus.triage.layoutAdded.v1';

@injectable()
export class TriageInboxContribution extends AbstractViewContribution<TriageInboxWidget> implements FrontendApplicationContribution {

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    constructor() {
        super({
            widgetId: TriageInboxWidget.ID,
            widgetName: TriageInboxWidget.LABEL,
            defaultWidgetOptions: {
                area: 'left',
                rank: 305
            },
            toggleCommandId: TRIAGE_PANEL_TOGGLE_COMMAND_ID
        });
    }

    override registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        commands.registerCommand({ id: TRIAGE_OPEN_COMMAND_ID, label: 'Fokkus: Abrir Bandeja de solicitudes (Triage)' }, {
            execute: () => this.openView({ activate: true, reveal: true })
        });
    }

    async initializeLayout(app: FrontendApplication): Promise<void> {
        await this.openView({ activate: false, reveal: false });
    }

    async onDidInitializeLayout(app: FrontendApplication): Promise<void> {
        // Igual que GitHub Issues: los workspaces con layout guardado no pasan por initializeLayout.
        // Se agrega el icono una sola vez por workspace; si el usuario cierra la vista, se respeta.
        await this.workspaceService.ready;
        const key = `${TRIAGE_LAYOUT_ADDED_KEY}:${this.workspaceService.workspace?.resource.toString() ?? 'no-workspace'}`;
        if (!localStorage.getItem(key) && !this.tryGetWidget()) {
            await this.openView({ activate: false, reveal: false });
        }
        localStorage.setItem(key, 'true');
    }
}
