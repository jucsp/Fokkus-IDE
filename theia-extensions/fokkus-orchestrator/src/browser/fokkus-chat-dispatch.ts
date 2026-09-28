/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ApplicationShell, WidgetManager } from '@theia/core/lib/browser';
import { inject, injectable } from '@theia/core/shared/inversify';
import { FokkusChatWidget } from './fokkus-orchestrator-widget';

/**
 * Abre el chat de Fokkus Team (panel izquierdo) y le envía un prompt.
 * Centraliza la lógica que antes duplicaba el Kanban y que ahora también
 * usa la sección Pull Requests de Source Control.
 */
@injectable()
export class FokkusChatDispatcher {

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    async send(text: string): Promise<void> {
        const chat = await this.widgetManager.getOrCreateWidget<FokkusChatWidget>(FokkusChatWidget.ID);
        if (!chat.isAttached) {
            await this.shell.addWidget(chat, { area: 'left', rank: 100 });
        }
        await this.shell.activateWidget(chat.id);
        chat.sendPrompt(text);
    }
}
