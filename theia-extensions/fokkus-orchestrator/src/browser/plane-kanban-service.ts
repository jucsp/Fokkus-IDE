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
import {
    PlaneConfigStatus,
    PlaneIssue,
    PlaneProject,
    PlaneState
} from '../common/plane-protocol';

export const PLANE_KANBAN_OPEN_COMMAND_ID = 'fokkus-kanban:open';

/** Snapshot que el panel Backlog publica para alimentar el tablero Kanban. */
export interface PlaneKanbanSnapshot {
    project?: PlaneProject;
    states: PlaneState[];
    issues: PlaneIssue[];
    config?: PlaneConfigStatus;
}

/**
 * Singleton que guarda el último estado del Backlog (proyecto, estados, issues filtrados y config)
 * y notifica a los suscriptores (el futuro widget Kanban) cada vez que cambia.
 */
@injectable()
export class PlaneKanbanService {

    protected readonly onDidChangeEmitter = new Emitter<PlaneKanbanSnapshot>();
    readonly onDidChange: Event<PlaneKanbanSnapshot> = this.onDidChangeEmitter.event;

    protected current: PlaneKanbanSnapshot = { states: [], issues: [] };

    get snapshot(): PlaneKanbanSnapshot {
        return this.current;
    }

    publish(snapshot: PlaneKanbanSnapshot): void {
        this.current = snapshot;
        this.onDidChangeEmitter.fire(snapshot);
    }
}
