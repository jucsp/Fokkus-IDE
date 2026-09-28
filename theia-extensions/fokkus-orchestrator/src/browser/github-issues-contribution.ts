/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { AbstractViewContribution, FrontendApplication, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import { GitHubIssuesWidget } from './github-issues-widget';

export const GITHUB_PANEL_TOGGLE_COMMAND_ID = 'fokkus-github:toggle';
const ISSUES_LAYOUT_ADDED_KEY = 'fokkus.githubIssues.layoutAdded.v1';

@injectable()
export class GitHubIssuesContribution extends AbstractViewContribution<GitHubIssuesWidget> implements FrontendApplicationContribution {

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    constructor() {
        super({
            widgetId: GitHubIssuesWidget.ID,
            widgetName: GitHubIssuesWidget.LABEL,
            defaultWidgetOptions: {
                area: 'left',
                rank: 310
            },
            toggleCommandId: GITHUB_PANEL_TOGGLE_COMMAND_ID
        });
    }

    async initializeLayout(app: FrontendApplication): Promise<void> {
        // Layout por defecto (workspace sin layout guardado): el icono aparece sin robar el foco al chat.
        await this.openView({ activate: false, reveal: false });
    }

    async onDidInitializeLayout(app: FrontendApplication): Promise<void> {
        // initializeLayout solo corre sin layout guardado: quien actualiza desde v1.0.x ya tiene uno por
        // workspace y nunca vería el icono. Se agrega una sola vez por workspace; si luego el usuario
        // cierra la vista, se respeta.
        await this.workspaceService.ready;
        const key = `${ISSUES_LAYOUT_ADDED_KEY}:${this.workspaceService.workspace?.resource.toString() ?? 'no-workspace'}`;
        if (!localStorage.getItem(key) && !this.tryGetWidget()) {
            await this.openView({ activate: false, reveal: false });
        }
        localStorage.setItem(key, 'true');
    }
}
