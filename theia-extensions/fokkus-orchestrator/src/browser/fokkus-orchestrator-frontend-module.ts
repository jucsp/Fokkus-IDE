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

import { bindViewContribution, FrontendApplicationContribution, RemoteConnectionProvider, ServiceConnectionProvider, WidgetFactory } from '@theia/core/lib/browser';
import { ContainerModule } from '@theia/core/shared/inversify';
import { FokkusOrchestratorServer, FokkusOrchestratorServerPath } from '../common/fokkus-orchestrator-protocol';
import { GitHubServer, GitHubServerPath } from '../common/github-protocol';
import { PlaneServer, PlaneServerPath } from '../common/plane-protocol';
import { FokkusChatDispatcher } from './fokkus-chat-dispatch';
import { FokkusOrchestratorContribution } from './fokkus-orchestrator-contribution';
import { FokkusChatWidget, FokkusSettingsWidget } from './fokkus-orchestrator-widget';
import { GitHubIssuesContribution } from './github-issues-contribution';
import { GitHubIssuesService } from './github-issues-service';
import { GitHubIssuesWidget } from './github-issues-widget';
import { GitHubKanbanContribution } from './github-kanban-contribution';
import { GitHubKanbanWidget } from './github-kanban-widget';
import { GitHubPullRequestsWidget } from './github-pull-requests-widget';
import { GitHubScmContribution } from './github-scm-contribution';
import { PlaneBacklogContribution } from './plane-backlog-contribution';
import { PlaneBacklogWidget } from './plane-backlog-widget';
import { PlaneKanbanContribution } from './plane-kanban-contribution';
import { PlaneKanbanService } from './plane-kanban-service';
import { PlaneKanbanWidget } from './plane-kanban-widget';

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
});
