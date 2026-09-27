/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AbstractViewContribution } from '@theia/core/lib/browser';
import { CommandRegistry } from '@theia/core/lib/common';
import { injectable } from '@theia/core/shared/inversify';
import { PLANE_KANBAN_OPEN_COMMAND_ID } from './plane-kanban-service';
import { PlaneKanbanWidget } from './plane-kanban-widget';

@injectable()
export class PlaneKanbanContribution extends AbstractViewContribution<PlaneKanbanWidget> {

    constructor() {
        super({
            widgetId: PlaneKanbanWidget.ID,
            widgetName: PlaneKanbanWidget.LABEL,
            defaultWidgetOptions: {
                area: 'main'
            }
        });
    }

    override registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        commands.registerCommand({ id: PLANE_KANBAN_OPEN_COMMAND_ID, label: 'Fokkus: Abrir Kanban' }, {
            execute: () => this.openView({ activate: true, reveal: true })
        });
    }
}
