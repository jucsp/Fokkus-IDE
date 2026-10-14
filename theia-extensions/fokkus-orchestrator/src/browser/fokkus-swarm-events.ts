/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Emitter, Event } from '@theia/core/lib/common/event';
import { injectable } from '@theia/core/shared/inversify';
import { SwarmDispatchResult } from '../common/fokkus-orchestrator-protocol';

/** Resultado de un turno del chat de Fokkus Team, visto desde el frontend. */
export interface FokkusSwarmDispatchOutcome {
    /** Texto exacto que se despachó (permite a quien lo envió reconocer su turno). */
    prompt: string;
    result?: SwarmDispatchResult;
    error?: string;
    /** true = el chat estaba ocupado y el prompt quedó en el cuadro de texto sin enviarse. */
    busy?: boolean;
}

/**
 * Bus de eventos del chat en el frontend.
 *
 * `FokkusOrchestratorServer.onDidDispatchSwarm` NO sirve en el navegador: el proxy RPC de Theia
 * trata cualquier propiedad `on*` como una notificación hacia el backend, no como un evento. El
 * chat publica aquí el resultado de cada turno para que otros servicios (Jarvis) lo reciban.
 */
@injectable()
export class FokkusSwarmEvents {

    protected readonly onDidFinishDispatchEmitter = new Emitter<FokkusSwarmDispatchOutcome>();
    readonly onDidFinishDispatch: Event<FokkusSwarmDispatchOutcome> = this.onDidFinishDispatchEmitter.event;

    fireDispatchFinished(outcome: FokkusSwarmDispatchOutcome): void {
        this.onDidFinishDispatchEmitter.fire(outcome);
    }
}
