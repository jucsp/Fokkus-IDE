/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { CommandService } from '@theia/core/lib/common/command';
import { Emitter, Event } from '@theia/core/lib/common/event';
import { MessageService } from '@theia/core/lib/common/message-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import { TriageClient, TriageEvent } from '../common/triage-protocol';

export const TRIAGE_OPEN_COMMAND_ID = 'fokkus-triage:open';

/** Si el backend no está desplegado, el proxy RPC nunca responde: se corta con un timeout. */
const RPC_TIMEOUT_MS = 15000;

export function withTriageTimeout<T>(promise: Promise<T>, timeoutMs: number = RPC_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(
            () => reject(new Error('El servicio de la Bandeja no respondió. Revisa que el backend de Fokkus esté actualizado.')),
            timeoutMs
        );
        promise.then(
            value => { window.clearTimeout(timer); resolve(value); },
            error => { window.clearTimeout(timer); reject(error); }
        );
    });
}

export function triageErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Cliente RPC de la bandeja: el backend lo llama en cada ventana conectada.
 * Re-emite los eventos para el widget y la notificación.
 */
@injectable()
export class TriageClientImpl implements TriageClient {

    protected readonly onDidReceiveEventEmitter = new Emitter<TriageEvent>();
    readonly onDidReceiveEvent: Event<TriageEvent> = this.onDidReceiveEventEmitter.event;

    onTriageEvent(event: TriageEvent): void {
        this.onDidReceiveEventEmitter.fire(event);
    }
}

/** Notifica las solicitudes nuevas aunque la bandeja esté cerrada. */
@injectable()
export class TriageNotificationContribution implements FrontendApplicationContribution {

    @inject(TriageClientImpl)
    protected readonly client: TriageClientImpl;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(CommandService)
    protected readonly commandService: CommandService;

    onStart(): void {
        this.client.onDidReceiveEvent(event => {
            if (event.kind !== 'items-detected' || event.items.length === 0) {
                return;
            }
            const count = event.items.length;
            const text = count === 1
                ? `Nueva solicitud en la Bandeja: «${event.items[0].title}»`
                : `${count} solicitudes nuevas en la Bandeja (${event.counts.pending} pendientes)`;
            this.messageService.info(text, 'Abrir bandeja')
                .then(action => {
                    if (action) {
                        return this.commandService.executeCommand(TRIAGE_OPEN_COMMAND_ID);
                    }
                })
                .catch(error => console.error('[fokkus-triage] No se pudo abrir la bandeja', error));
        });
    }
}
