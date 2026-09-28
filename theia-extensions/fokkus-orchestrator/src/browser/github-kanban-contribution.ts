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
import { GITHUB_KANBAN_OPEN_COMMAND_ID } from './github-issues-service';
import { GitHubKanbanWidget } from './github-kanban-widget';

@injectable()
export class GitHubKanbanContribution extends AbstractViewContribution<GitHubKanbanWidget> {

    constructor() {
        super({
            widgetId: GitHubKanbanWidget.ID,
            widgetName: GitHubKanbanWidget.LABEL,
            defaultWidgetOptions: {
                area: 'main'
            }
        });
    }

    override registerCommands(commands: CommandRegistry): void {
        super.registerCommands(commands);
        commands.registerCommand({ id: GITHUB_KANBAN_OPEN_COMMAND_ID, label: 'Fokkus: Abrir GitHub Kanban' }, {
            execute: () => this.openView({ activate: true, reveal: true })
        });
    }
}
