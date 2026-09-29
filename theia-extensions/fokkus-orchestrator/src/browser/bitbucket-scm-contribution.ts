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
    ViewContainerPart,
    WidgetManager
} from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { BitbucketPullRequestsWidget } from './bitbucket-pull-requests-widget';

/**
 * FactoryId del contenedor nativo de Source Control de Theia.
 *
 * `@theia/scm` no está entre las dependencias de esta extensión, así que se usa
 * la constante literal en lugar de importar `SCM_VIEW_CONTAINER_ID` desde
 * `@theia/scm/lib/browser/scm-contribution`.
 */
const SCM_VIEW_CONTAINER_ID = 'scm-view-container';

/**
 * Clave de localStorage que garantiza que la sección se revele una única vez.
 * Después de la primera revelación se respeta la decisión del usuario si decide
 * ocultarla manualmente.
 */
const SCM_REVEAL_KEY = 'fokkus.bitbucket.prs.scmRevealed.v1';

/**
 * Agrega la sección "Bitbucket Pull Requests" dentro del contenedor nativo de
 * Source Control, junto a CHANGES y GRAPH.
 */
@injectable()
export class BitbucketScmContribution implements FrontendApplicationContribution {

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    protected prWidget: BitbucketPullRequestsWidget | undefined;

    /**
     * Se suscribe ANTES de que se cree el layout. `initialize()` corre antes que
     * `onStart`/`initializeLayout`, por lo que al crear el contenedor SCM podemos
     * inyectar la parte en el momento exacto (y queda disponible antes de
     * `restoreState`, evitando que `doRestoreState` la oculte silenciosamente).
     */
    initialize(): void {
        try {
            this.widgetManager.onWillCreateWidget(({ factoryId, widget, waitUntil }) => {
                if (factoryId !== SCM_VIEW_CONTAINER_ID || !(widget instanceof ViewContainer)) {
                    return;
                }
                waitUntil(this.addPullRequests(widget));
            });

            // Fallback: si el contenedor ya se había creado cuando nos suscribimos,
            // agregamos la parte directamente en vez de esperar al evento.
            const existing = this.widgetManager.tryGetWidget<ViewContainer>(SCM_VIEW_CONTAINER_ID);
            if (existing) {
                this.addPullRequests(existing).catch(error => {
                    console.error('[fokkus-bitbucket] No se pudo agregar Bitbucket Pull Requests a Source Control (fallback)', error);
                });
            }
        } catch (error) {
            console.error('[fokkus-bitbucket] No se pudo registrar la sección Bitbucket Pull Requests', error);
        }
    }

    async onDidInitializeLayout(_app: FrontendApplication): Promise<void> {
        try {
            await this.revealOnce();
        } catch (error) {
            console.error('[fokkus-bitbucket] No se pudo revelar la sección Bitbucket Pull Requests', error);
        }
    }

    protected async addPullRequests(container: ViewContainer): Promise<void> {
        try {
            if (container.getParts().some(part => part.wrapped.id === BitbucketPullRequestsWidget.ID)) {
                return;
            }
            const prWidget = await this.widgetManager.getOrCreateWidget<BitbucketPullRequestsWidget>(BitbucketPullRequestsWidget.ID);
            this.prWidget = prWidget;
            container.addWidget(prWidget, { order: 4, canHide: true, initiallyCollapsed: true });
        } catch (error) {
            console.error('[fokkus-bitbucket] No se pudo agregar Bitbucket Pull Requests a Source Control', error);
        }
    }

    /**
     * Resuelve el diagnóstico de `ViewContainer.doRestoreState()`: oculta toda
     * parte con `canHide: true` que no esté en el layout persistido del usuario.
     * Mostramos la sección una sola vez y luego respetamos el estado que el
     * usuario haya dejado guardado.
     */
    protected async revealOnce(): Promise<void> {
        const container = this.widgetManager.tryGetWidget<ViewContainer>(SCM_VIEW_CONTAINER_ID);
        const widget = this.prWidget ?? this.widgetManager.tryGetWidget<BitbucketPullRequestsWidget>(BitbucketPullRequestsWidget.ID);
        if (!container || !widget) {
            return;
        }
        const part: ViewContainerPart | undefined = container.getPartFor(widget);
        if (!part || localStorage.getItem(SCM_REVEAL_KEY)) {
            return;
        }
        if (part.isHidden) {
            part.setHidden(false);
        }
        localStorage.setItem(SCM_REVEAL_KEY, '1');
    }
}
