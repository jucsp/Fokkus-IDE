/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { inject, injectable } from '@theia/core/shared/inversify';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { TriageServerImpl } from './triage-server';

/** Arranca el sondeo de la Bandeja con el backend (primera pasada a los 30 s, sin bloquear el inicio). */
@injectable()
export class TriageBackendContribution implements BackendApplicationContribution {

    @inject(TriageServerImpl)
    protected readonly server: TriageServerImpl;

    onStart(): void {
        this.server.startPolling().catch(() => undefined);
    }

    onStop(): void {
        this.server.dispose();
    }
}
