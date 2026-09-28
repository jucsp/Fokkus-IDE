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
import { PlaneServer, PlaneServerPath } from '../common/plane-protocol';
import { GitHubServer, GitHubServerPath } from '../common/github-protocol';
import { FokkusOrchestratorServerImpl } from './fokkus-orchestrator-server';
import { PlaneServerImpl } from './plane-server';
import { GitHubServerImpl } from './github-server';

export default new ContainerModule(bind => {
    bind(FokkusOrchestratorServer).to(FokkusOrchestratorServerImpl).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(context =>
        new RpcConnectionHandler(FokkusOrchestratorServerPath, () =>
            context.container.get<FokkusOrchestratorServer>(FokkusOrchestratorServer)
        )
    ).inSingletonScope();

    bind(PlaneServer).to(PlaneServerImpl).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(context =>
        new RpcConnectionHandler(PlaneServerPath, () =>
            context.container.get<PlaneServer>(PlaneServer)
        )
    ).inSingletonScope();

    bind(GitHubServer).to(GitHubServerImpl).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(context =>
        new RpcConnectionHandler(GitHubServerPath, () =>
            context.container.get<GitHubServer>(GitHubServer)
        )
    ).inSingletonScope();
});
