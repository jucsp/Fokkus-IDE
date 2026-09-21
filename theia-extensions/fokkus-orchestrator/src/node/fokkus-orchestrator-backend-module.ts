/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common';
import { FokkusOrchestratorServer, FokkusOrchestratorServerPath } from '../common/fokkus-orchestrator-protocol';
import { FokkusOrchestratorServerImpl } from './fokkus-orchestrator-server';

export default new ContainerModule(bind => {
    bind(FokkusOrchestratorServer).to(FokkusOrchestratorServerImpl).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(context =>
        new RpcConnectionHandler(FokkusOrchestratorServerPath, () =>
            context.container.get<FokkusOrchestratorServer>(FokkusOrchestratorServer)
        )
    ).inSingletonScope();
});
