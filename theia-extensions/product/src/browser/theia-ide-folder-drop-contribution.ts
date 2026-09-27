/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { inject, injectable } from '@theia/core/shared/inversify';
import { ApplicationShell } from '@theia/core/lib/browser/shell/application-shell';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { open, OpenerService } from '@theia/core/lib/browser/opener-service';
import { MessageService } from '@theia/core/lib/common/message-service';
import { URI } from '@theia/core/lib/common/uri';
import { WorkspaceService } from '@theia/workspace/lib/browser';

// Identificador del view container del explorador de archivos.
// Está definido en @theia/navigator; se evita importar el paquete.
const EXPLORER_VIEW_CONTAINER_ID = 'explorer-view-container';

interface ElectronTheiaCore {
    getPathForFile?(file: File): string;
}

@injectable()
export class TheiaIDEFolderDropContribution implements FrontendApplicationContribution {

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @inject(OpenerService)
    protected readonly openerService: OpenerService;

    onStart(): void {
        // Fase de captura para interceptar el drop antes que el dock panel principal,
        // que intentaría abrir una carpeta como si fuera un archivo.
        document.addEventListener('dragover', this.onDragOver, true);
        document.addEventListener('drop', this.onDrop, true);
    }

    protected onDragOver = (event: DragEvent): void => {
        if (!this.shouldHandle(event)) {
            return;
        }
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'copy';
        }
        // No se detiene la propagación: otras vistas deben seguir viendo el dragover.
    };

    protected onDrop = (event: DragEvent): void => {
        if (!this.shouldHandle(event)) {
            return;
        }
        // Lectura síncrona: el DataTransfer se invalida en cuanto termina el handler.
        const dataTransfer = event.dataTransfer;
        if (!dataTransfer) {
            return;
        }
        const folders: URI[] = [];
        const files: URI[] = [];
        for (const item of Array.from(dataTransfer.items)) {
            if (item.kind !== 'file') {
                continue;
            }
            const entry = item.webkitGetAsEntry();
            const file = item.getAsFile();
            if (!file) {
                continue;
            }
            const path = this.electronTheiaCore?.getPathForFile?.(file);
            if (!path) {
                continue;
            }
            const uri = URI.fromFilePath(path);
            if (entry?.isDirectory) {
                folders.push(uri);
            } else {
                files.push(uri);
            }
        }
        if (folders.length === 0) {
            // Sin carpetas, dejamos que el shell siga abriendo los archivos como hasta ahora.
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.handleDrop(folders, files).catch(error => {
            console.error('Error al abrir las carpetas soltadas.', error);
            this.messageService.error('No se pudo abrir la carpeta soltada.');
        });
    };

    protected async handleDrop(folders: URI[], files: URI[]): Promise<void> {
        for (const file of files) {
            await open(this.openerService, file);
        }
        if (!this.workspaceService.opened) {
            if (folders.length === 1) {
                this.workspaceService.open(folders[0], { preserveWindow: true });
            } else {
                // addRoot sin workspace abierto crea un workspace multi-root sin recargar
                // (ver WorkspaceService.spliceRoots: guarda un untitled workspace).
                await this.workspaceService.addRoot(folders);
            }
            return;
        }
        const existingRoots = new Set(
            this.workspaceService.tryGetRoots().map(root => root.resource.toString())
        );
        const newFolders = folders.filter(folder => !existingRoots.has(folder.toString()));
        if (newFolders.length === 0) {
            this.messageService.info('La carpeta ya está en el workspace.');
            await this.revealExplorer();
            return;
        }
        const message = newFolders.length === 1
            ? `¿Qué hacer con la carpeta «${newFolders[0].path.base}»?`
            : `¿Qué hacer con las ${newFolders.length} carpetas soltadas? (Solo se abrirá la primera)`;
        const choice = await this.messageService.info(
            message,
            'Añadir al workspace',
            'Abrir en esta ventana',
            'Abrir en nueva ventana'
        );
        switch (choice) {
            case 'Añadir al workspace':
                await this.workspaceService.addRoot(newFolders);
                await this.revealExplorer();
                break;
            case 'Abrir en esta ventana':
                this.workspaceService.open(newFolders[0], { preserveWindow: true });
                break;
            case 'Abrir en nueva ventana':
                this.workspaceService.open(newFolders[0], { preserveWindow: false });
                break;
            default:
                break;
        }
    }

    protected async revealExplorer(): Promise<void> {
        await this.shell.revealWidget(EXPLORER_VIEW_CONTAINER_ID);
    }

    protected shouldHandle(event: DragEvent): boolean {
        const isExternalFileDrop = event.dataTransfer?.types.includes('Files') ?? false;
        if (!isExternalFileDrop) {
            return false;
        }
        if (!this.electronTheiaCore?.getPathForFile) {
            return false;
        }
        // Vistas con su propio drop: el árbol del explorador copia (upload) y el chat de IA
        // agrega archivos/carpetas como contexto.
        if (this.workspaceService.opened && this.isInside(event.target, '.theia-FileTree')) {
            return false;
        }
        return !this.isInside(event.target, '.theia-ChatInput');
    }

    protected isInside(target: EventTarget | null, selector: string): boolean {
        return target instanceof Element && !!target.closest(selector);
    }

    protected get electronTheiaCore(): ElectronTheiaCore | undefined {
        return (window as unknown as { electronTheiaCore?: ElectronTheiaCore }).electronTheiaCore;
    }
}
