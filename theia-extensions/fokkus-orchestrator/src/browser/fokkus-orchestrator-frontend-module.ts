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

import { bindViewContribution, FrontendApplicationContribution, RemoteConnectionProvider, ServiceConnectionProvider, WidgetFactory } from '@theia/core/lib/browser';
import { ContainerModule } from '@theia/core/shared/inversify';
import { FokkusOrchestratorServer, FokkusOrchestratorServerPath } from '../common/fokkus-orchestrator-protocol';
import { FokkusOrchestratorContribution } from './fokkus-orchestrator-contribution';
import { FokkusChatWidget, FokkusSettingsWidget } from './fokkus-orchestrator-widget';

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
});
