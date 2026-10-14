/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ElectronIpcConnectionProvider } from '@theia/core/lib/electron-browser/messaging/electron-ipc-connection-source';
import { ContainerModule } from '@theia/core/shared/inversify';
import { JarvisOverlayWindowServer, JarvisOverlayWindowServerPath } from '../common/jarvis-protocol';

/**
 * Solo en Electron: proxy IPC hacia el proceso main para controlar la ventana overlay de Jarvis.
 * En el navegador no se carga y `JarvisController` lo recibe como `@optional()`.
 */
export default new ContainerModule(bind => {
    bind(JarvisOverlayWindowServer).toDynamicValue(context =>
        ElectronIpcConnectionProvider.createProxy<JarvisOverlayWindowServer>(context.container, JarvisOverlayWindowServerPath)
    ).inSingletonScope();
});
