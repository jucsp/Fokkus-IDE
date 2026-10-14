/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import '../../src/browser/style/index.css';
import '../../src/browser/style/theme.css';
import '../../src/browser/style/plane-backlog.css';
import '../../src/browser/style/plane-kanban.css';
import '../../src/browser/style/github.css';
import '../../src/browser/style/github-issues.css';
import '../../src/browser/style/git-providers.css';
import '../../src/browser/style/triage.css';

import { bindViewContribution, FrontendApplicationContribution, RemoteConnectionProvider, ServiceConnectionProvider, WidgetFactory } from '@theia/core/lib/browser';
import { CommandContribution, PreferenceContribution } from '@theia/core/lib/common';
import { ContainerModule } from '@theia/core/shared/inversify';
import { PreferenceNodeRendererContribution } from '@theia/preferences/lib/browser/views/components/preference-node-renderer-creator';
import { BitbucketServer, BitbucketServerPath } from '../common/bitbucket-protocol';
import { FokkusOrchestratorServer, FokkusOrchestratorServerPath } from '../common/fokkus-orchestrator-protocol';
import { GitCredentialsServer, GitCredentialsServerPath } from '../common/git-credentials-protocol';
import { GitHubServer, GitHubServerPath } from '../common/github-protocol';
import { JarvisCompanionServer, JarvisCompanionServerPath } from '../common/jarvis-companion-protocol';
import { PlaneServer, PlaneServerPath } from '../common/plane-protocol';
import { TriageServer, TriageServerPath } from '../common/triage-protocol';
import { BitbucketPullRequestsWidget } from './bitbucket-pull-requests-widget';
import { BitbucketScmContribution } from './bitbucket-scm-contribution';
import { FokkusChatDispatcher } from './fokkus-chat-dispatch';
import { FokkusOrchestratorContribution } from './fokkus-orchestrator-contribution';
import { FokkusSwarmEvents } from './fokkus-swarm-events';
import { FokkusChatWidget, FokkusSettingsWidget } from './fokkus-orchestrator-widget';
import {
    GitProvidersCommandContribution,
    gitProvidersPreferenceSchema,
    GitProvidersPreferenceRenderer,
    GitProvidersPreferenceRendererContribution
} from './git-providers-preferences';
import { GitHubIssuesContribution } from './github-issues-contribution';
import { GitHubIssuesService } from './github-issues-service';
import { GitHubIssuesWidget } from './github-issues-widget';
import { GitHubKanbanContribution } from './github-kanban-contribution';
import { GitHubKanbanWidget } from './github-kanban-widget';
import { GitHubPullRequestsWidget } from './github-pull-requests-widget';
import { GitHubScmContribution } from './github-scm-contribution';
import { JarvisCompanionContribution } from './jarvis-companion-contribution';
import { PlaneBacklogContribution } from './plane-backlog-contribution';
import { PlaneBacklogWidget } from './plane-backlog-widget';
import { PlaneKanbanContribution } from './plane-kanban-contribution';
import { PlaneKanbanService } from './plane-kanban-service';
import { PlaneKanbanWidget } from './plane-kanban-widget';
import { TriageInboxContribution } from './triage-contribution';
import { TriageInboxWidget } from './triage-inbox-widget';
import { TriageClientImpl, TriageNotificationContribution } from './triage-service';

export default new ContainerModule(bind => {
    // bindViewContribution already binds MenuContribution (and CommandContribution/KeybindingContribution)
    // to FokkusOrchestratorContribution. Binding it again below duplicated every menu entry registered in
    // registerMenus(), including "Toggle Right Panel Visibility" in View -> Appearance.
    bindViewContribution(bind, FokkusOrchestratorContribution);
    bind(FrontendApplicationContribution).toService(FokkusOrchestratorContribution);

    bind(FokkusChatWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: FokkusChatWidget.ID,
        createWidget: () => context.container.get<FokkusChatWidget>(FokkusChatWidget)
    })).inSingletonScope();

    bind(FokkusSettingsWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: FokkusSettingsWidget.ID,
        createWidget: () => context.container.get<FokkusSettingsWidget>(FokkusSettingsWidget)
    })).inSingletonScope();

    bind(FokkusOrchestratorServer).toDynamicValue(context => {
        const provider = context.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
        return provider.createProxy<FokkusOrchestratorServer>(FokkusOrchestratorServerPath);
    }).inSingletonScope();

    bindViewContribution(bind, PlaneBacklogContribution);
    bind(FrontendApplicationContribution).toService(PlaneBacklogContribution);

    bind(PlaneBacklogWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: PlaneBacklogWidget.ID,
        createWidget: () => context.container.get<PlaneBacklogWidget>(PlaneBacklogWidget)
    })).inSingletonScope();

    bind(PlaneKanbanService).toSelf().inSingletonScope();

    bindViewContribution(bind, PlaneKanbanContribution);
    bind(PlaneKanbanWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: PlaneKanbanWidget.ID,
        createWidget: () => context.container.get<PlaneKanbanWidget>(PlaneKanbanWidget)
    })).inSingletonScope();

    bindViewContribution(bind, GitHubIssuesContribution);
    bind(FrontendApplicationContribution).toService(GitHubIssuesContribution);

    bind(GitHubIssuesWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: GitHubIssuesWidget.ID,
        createWidget: () => context.container.get<GitHubIssuesWidget>(GitHubIssuesWidget)
    })).inSingletonScope();

    bind(GitHubIssuesService).toSelf().inSingletonScope();

    bindViewContribution(bind, GitHubKanbanContribution);
    bind(GitHubKanbanWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: GitHubKanbanWidget.ID,
        createWidget: () => context.container.get<GitHubKanbanWidget>(GitHubKanbanWidget)
    })).inSingletonScope();

    bind(PlaneServer).toDynamicValue(context => {
        const provider = context.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
        return provider.createProxy<PlaneServer>(PlaneServerPath);
    }).inSingletonScope();

    bind(FokkusChatDispatcher).toSelf().inSingletonScope();
    bind(FokkusSwarmEvents).toSelf().inSingletonScope();

    bind(GitHubPullRequestsWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: GitHubPullRequestsWidget.ID,
        createWidget: () => context.container.get<GitHubPullRequestsWidget>(GitHubPullRequestsWidget)
    })).inSingletonScope();

    bind(GitHubScmContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(GitHubScmContribution);

    bind(GitHubServer).toDynamicValue(context => {
        const provider = context.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
        return provider.createProxy<GitHubServer>(GitHubServerPath);
    }).inSingletonScope();

    bind(BitbucketPullRequestsWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: BitbucketPullRequestsWidget.ID,
        createWidget: () => context.container.get<BitbucketPullRequestsWidget>(BitbucketPullRequestsWidget)
    })).inSingletonScope();

    bind(BitbucketScmContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(BitbucketScmContribution);

    bind(BitbucketServer).toDynamicValue(context => {
        const provider = context.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
        return provider.createProxy<BitbucketServer>(BitbucketServerPath);
    }).inSingletonScope();

    // Preferencias › Fokkus › Integrations › Git Providers (#22). Los secretos los guarda el backend.
    bind(GitCredentialsServer).toDynamicValue(context => {
        const provider = context.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
        return provider.createProxy<GitCredentialsServer>(GitCredentialsServerPath);
    }).inSingletonScope();
    bind(PreferenceContribution).toConstantValue({ schema: gitProvidersPreferenceSchema });
    bind(GitProvidersPreferenceRenderer).toSelf();
    bind(GitProvidersPreferenceRendererContribution).toSelf().inSingletonScope();
    bind(PreferenceNodeRendererContribution).toService(GitProvidersPreferenceRendererContribution);
    bind(GitProvidersCommandContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(GitProvidersCommandContribution);

    // Bandeja Pre-Kanban (#26): el proxy lleva el cliente para recibir los eventos del sondeo.
    bind(TriageClientImpl).toSelf().inSingletonScope();
    bind(TriageServer).toDynamicValue(context => {
        const provider = context.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
        return provider.createProxy<TriageServer>(TriageServerPath, context.container.get(TriageClientImpl));
    }).inSingletonScope();
    bindViewContribution(bind, TriageInboxContribution);
    bind(FrontendApplicationContribution).toService(TriageInboxContribution);
    bind(TriageInboxWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: TriageInboxWidget.ID,
        createWidget: () => context.container.get<TriageInboxWidget>(TriageInboxWidget)
    })).inSingletonScope();
    bind(TriageNotificationContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(TriageNotificationContribution);

    // Conector del compañero Jarvis: proxy RPC hacia el backend + barra de estado, comandos y
    // reenvío de eventos del Swarm/Bandeja. Desvincula los viejos módulos overlay de Electron.
    bind(JarvisCompanionServer).toDynamicValue(context => {
        const provider = context.container.get<ServiceConnectionProvider>(RemoteConnectionProvider);
        return provider.createProxy<JarvisCompanionServer>(JarvisCompanionServerPath);
    }).inSingletonScope();
    bind(JarvisCompanionContribution).toSelf().inSingletonScope();
    bind(CommandContribution).toService(JarvisCompanionContribution);
    bind(FrontendApplicationContribution).toService(JarvisCompanionContribution);
});
