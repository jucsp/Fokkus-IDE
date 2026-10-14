/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { RpcConnectionHandler } from '@theia/core/lib/common/messaging/proxy-factory';
import { ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';
import { ElectronConnectionHandler } from '@theia/core/lib/electron-main/messaging/electron-connection-handler';
import { ContainerModule } from '@theia/core/shared/inversify';
import { JarvisOverlayWindowServer, JarvisOverlayWindowServerPath } from '../common/jarvis-protocol';
import { JarvisOverlayMainContribution } from './jarvis-overlay-main';

export default new ContainerModule(bind => {
    bind(JarvisOverlayMainContribution).toSelf().inSingletonScope();
    bind(JarvisOverlayWindowServer).toService(JarvisOverlayMainContribution);
    bind(ElectronMainApplicationContribution).toService(JarvisOverlayMainContribution);
    bind(ElectronConnectionHandler).toDynamicValue(context =>
        new RpcConnectionHandler(JarvisOverlayWindowServerPath, () => context.container.get<JarvisOverlayWindowServer>(JarvisOverlayWindowServer))
    ).inSingletonScope();
});
