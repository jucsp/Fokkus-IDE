/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    FrontendApplication,
    FrontendApplicationContribution,
    ViewContainer,
    WidgetManager
} from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { GitHubPullRequestsWidget } from './github-pull-requests-widget';

/** FactoryId del contenedor nativo de Source Control de Theia. */
const SCM_VIEW_CONTAINER_FACTORY_ID = 'scm-view-container';

/**
 * Agrega la sección "Pull Requests" dentro del contenedor nativo de Source Control,
 * junto a CHANGES y GRAPH.
 */
@injectable()
export class GitHubScmContribution implements FrontendApplicationContribution {

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    onStart(app: FrontendApplication): void {
        this.widgetManager.onDidCreateWidget(({ factoryId, widget }) => {
            if (factoryId === SCM_VIEW_CONTAINER_FACTORY_ID && widget instanceof ViewContainer) {
                this.addPullRequests(widget)
                    .catch(error => console.error('[fokkus-github] No se pudo agregar Pull Requests a Source Control', error));
            }
        });

        const existing = this.widgetManager.tryGetWidget(SCM_VIEW_CONTAINER_FACTORY_ID);
        if (existing instanceof ViewContainer) {
            this.addPullRequests(existing)
                .catch(error => console.error('[fokkus-github] No se pudo agregar Pull Requests a Source Control', error));
        }
    }

    protected async addPullRequests(container: ViewContainer): Promise<void> {
        if (container.getParts().some(part => part.wrapped.id === GitHubPullRequestsWidget.ID)) {
            return;
        }
        const prWidget = await this.widgetManager.getOrCreateWidget<GitHubPullRequestsWidget>(GitHubPullRequestsWidget.ID);
        container.addWidget(prWidget, { order: 3, canHide: true, initiallyCollapsed: true });
    }
}
