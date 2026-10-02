/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from '@theia/core/shared/react';
import { createRoot, Root } from '@theia/core/shared/react-dom/client';
import { inject, injectable, interfaces } from '@theia/core/shared/inversify';
import { Command, CommandContribution, CommandRegistry, PreferenceSchema, PreferenceScope } from '@theia/core/lib/common';
import { CommonCommands, ConfirmDialog } from '@theia/core/lib/browser';
import { Preference } from '@theia/preferences/lib/browser/util/preference-types';
import { PreferenceLeafNodeRenderer, PreferenceNodeRenderer } from '@theia/preferences/lib/browser/views/components/preference-node-renderer';
import { PreferenceLeafNodeRendererContribution } from '@theia/preferences/lib/browser/views/components/preference-node-renderer-creator';
import { GitCredentialsServer } from '../common/git-credentials-protocol';
import { GitProvidersSettings } from './git-providers-settings';

/**
 * Entrada «Fokkus › Integrations › Git Providers» del editor de Preferencias. Es un
 * `null` en el schema: el valor nunca se escribe en settings.json, solo sirve de ancla
 * para el renderer propio, que habla con GitCredentialsServer.
 */
export const GIT_PROVIDERS_PREFERENCE_ID = 'fokkus.integrations.gitProviders';

export const gitProvidersPreferenceSchema: PreferenceSchema = {
    properties: {
        [GIT_PROVIDERS_PREFERENCE_ID]: {
            type: 'null',
            // eslint-disable-next-line no-null/no-null
            default: null,
            scope: PreferenceScope.User,
            markdownDescription: 'Credenciales de GitHub y Bitbucket que usan Source Control y los agentes. '
                + 'Se guardan en el almacén de credenciales del sistema operativo, no en este archivo.'
        }
    }
};

export namespace GitProvidersCommands {
    export const OPEN: Command = Command.toDefaultLocalizedCommand({
        id: 'fokkus.integrations.openGitProviders',
        category: 'Fokkus',
        label: 'Git Providers: configurar credenciales'
    });
}

@injectable()
export class GitProvidersPreferenceRenderer extends PreferenceLeafNodeRenderer<null, HTMLDivElement> {

    @inject(GitCredentialsServer)
    protected readonly gitCredentialsServer: GitCredentialsServer;

    protected reactRoot: Root | undefined;

    // El valor de esta preferencia no existe: sin engranaje (Reset/Copy) ni marca de "modificado".
    protected override showCog(): void { }
    protected override addModifiedMarking(): void { }

    protected createInteractable(parent: HTMLElement): void {
        const container = document.createElement('div');
        container.classList.add('fokkus-gitprov-host');
        // `.pref-input` limita el ancho a 320px (pensado para un único input).
        parent.classList.add('fokkus-gitprov-pref-input');
        this.interactable = container;
        parent.appendChild(container);
        this.reactRoot = createRoot(container);
        this.reactRoot.render(
            <GitProvidersSettings server={this.gitCredentialsServer} confirm={(title, msg) => this.confirm(title, msg)} />
        );
    }

    protected async confirm(title: string, msg: string): Promise<boolean> {
        const dialog = new ConfirmDialog({ title, msg, ok: 'Eliminar', cancel: 'Cancelar' });
        return !!await dialog.open();
    }

    protected getFallbackValue(): null {
        // eslint-disable-next-line no-null/no-null
        return null;
    }

    protected doHandleValueChange(): void {
        // El valor de la preferencia no se usa: el estado vive en el backend.
    }

    override dispose(): void {
        this.reactRoot?.unmount();
        this.reactRoot = undefined;
        super.dispose();
    }
}

@injectable()
export class GitProvidersPreferenceRendererContribution extends PreferenceLeafNodeRendererContribution {
    static readonly ID = 'fokkus-git-providers-renderer';
    id = GitProvidersPreferenceRendererContribution.ID;

    canHandleLeafNode(node: Preference.LeafNode): number {
        // Por encima de los renderers estándar (null = 5) para este único id.
        return node.preferenceId === GIT_PROVIDERS_PREFERENCE_ID ? 100 : 0;
    }

    createLeafNodeRenderer(container: interfaces.Container): PreferenceNodeRenderer {
        return container.get(GitProvidersPreferenceRenderer);
    }
}

@injectable()
export class GitProvidersCommandContribution implements CommandContribution {
    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand(GitProvidersCommands.OPEN, {
            execute: () => registry.executeCommand(CommonCommands.OPEN_PREFERENCES.id, GIT_PROVIDERS_PREFERENCE_ID)
        });
    }
}
