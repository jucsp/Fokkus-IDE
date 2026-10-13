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
import { BitbucketServer, BitbucketServerPath } from '../common/bitbucket-protocol';
import { GitCredentialsServer, GitCredentialsServerPath } from '../common/git-credentials-protocol';
import { FokkusOrchestratorServerImpl } from './fokkus-orchestrator-server';
import { PlaneServerImpl } from './plane-server';
import { GitHubServerImpl } from './github-server';
import { BitbucketServerImpl } from './bitbucket-server';
import { FokkusKeyStore, GitCredentialsStore } from './git-credentials-store';
import { GitCredentialsServerImpl } from './git-credentials-server';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { TriageClient, TriageServer, TriageServerPath } from '../common/triage-protocol';
import { TriageConfigService } from './triage/triage-config';
import { TriageStore } from './triage/triage-store';
import { TriageServerImpl } from './triage/triage-server';
import { TriageBackendContribution } from './triage/triage-backend-contribution';

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

    bind(BitbucketServer).to(BitbucketServerImpl).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(context =>
        new RpcConnectionHandler(BitbucketServerPath, () =>
            context.container.get<BitbucketServer>(BitbucketServer)
        )
    ).inSingletonScope();

    bind(FokkusKeyStore).toSelf().inSingletonScope();
    bind(GitCredentialsStore).toSelf().inSingletonScope();
    bind(GitCredentialsServer).to(GitCredentialsServerImpl).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(context =>
        new RpcConnectionHandler(GitCredentialsServerPath, () =>
            context.container.get<GitCredentialsServer>(GitCredentialsServer)
        )
    ).inSingletonScope();

    // Bandeja Pre-Kanban (#26). Reutiliza FokkusKeyStore y GitCredentialsStore ya bindeados arriba.
    bind(TriageConfigService).toSelf().inSingletonScope();
    bind(TriageStore).toSelf().inSingletonScope();
    bind(TriageServerImpl).toSelf().inSingletonScope();
    bind(TriageServer).toService(TriageServerImpl);
    bind(ConnectionHandler).toDynamicValue(context =>
        new RpcConnectionHandler<TriageClient>(TriageServerPath, client => {
            const server = context.container.get<TriageServerImpl>(TriageServerImpl);
            server.addClient(client);
            client.onDidCloseConnection(() => server.removeClient(client));
            return server;
        })
    ).inSingletonScope();
    bind(TriageBackendContribution).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(TriageBackendContribution);
});
