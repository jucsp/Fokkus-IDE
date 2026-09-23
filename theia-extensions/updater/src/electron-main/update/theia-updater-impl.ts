/********************************************************************************
 * Copyright (C) 2020 TypeFox, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ElectronMainApplication, ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';
import { TheiaUpdater, TheiaUpdaterClient, UpdateInfo, UpdaterSettings } from '../../common/updater/theia-updater';
import { injectable } from '@theia/core/shared/inversify';
import { CancellationToken } from 'builder-util-runtime';

const GITHUB_OWNER = 'jucsp';
const GITHUB_REPO = 'Fokkus-IDE';

const { autoUpdater } = require('electron-updater');

autoUpdater.logger = require('electron-log');
autoUpdater.logger.transports.file.level = 'info';

@injectable()
export class TheiaUpdaterImpl implements TheiaUpdater, ElectronMainApplicationContribution {

    protected clients: Array<TheiaUpdaterClient> = [];
    protected settings: UpdaterSettings = {
        checkForUpdates: true,
        checkInterval: 60,
        channel: 'stable'
    };

    private initialCheck: boolean = true;
    private reportOnFirstRegistration: boolean = false;
    private notifyIfNoUpdate: boolean = false;
    private cancellationToken: CancellationToken = new CancellationToken();
    private updateCheckTimer: NodeJS.Timeout | undefined;
    private lastUpdateInfo?: UpdateInfo;

    constructor() {
        autoUpdater.autoDownload = false;
        autoUpdater.setFeedURL({
            provider: 'github',
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO
        });
        autoUpdater.on('update-available', (info: { version: string }) => {
            this.notifyIfNoUpdate = false;
            if (this.initialCheck) {
                this.initialCheck = false;
                if (this.clients.length === 0) {
                    this.reportOnFirstRegistration = true;
                }
            }
            this.lastUpdateInfo = { version: info.version };
            this.clients.forEach(c => c.updateAvailable(true, this.lastUpdateInfo));
        });
        autoUpdater.on('update-not-available', () => {
            const notifyIfNoUpdate = this.notifyIfNoUpdate;
            this.notifyIfNoUpdate = false;
            if (this.initialCheck) {
                this.initialCheck = false;
            }
            this.clients.forEach(c => c.updateAvailable(false, undefined, notifyIfNoUpdate));
        });

        autoUpdater.on('update-downloaded', () => {
            this.clients.forEach(c => c.notifyReadyToInstall());
        });

        autoUpdater.on('error', (err: unknown) => {
            this.notifyIfNoUpdate = false;
            if (err instanceof Error && err.message.includes('cancelled')) {
                return;
            }
            const errorLogPath = autoUpdater.logger.transports.file.getFile().path;
            this.clients.forEach(c => c.reportError({ message: 'An error has occurred while attempting to update.', errorLogPath }));
        });
    }

    checkForUpdates(notifyIfNoUpdate = true): void {
        this.notifyIfNoUpdate = this.notifyIfNoUpdate || notifyIfNoUpdate;
        autoUpdater.allowPrerelease = this.settings.channel !== 'stable';
        autoUpdater.checkForUpdates().catch((err: unknown) => autoUpdater.logger.error('Update check failed', err));
    }

    setUpdaterSettings(settings: UpdaterSettings): void {
        const settingsChanged = this.settings.checkForUpdates !== settings.checkForUpdates ||
            this.settings.checkInterval !== settings.checkInterval ||
            this.settings.channel !== settings.channel;
        this.settings = settings;
        if (settingsChanged) {
            this.scheduleUpdateChecks();
        }
    }

    onRestartToUpdateRequested(): void {
        autoUpdater.quitAndInstall();
    }

    cancel(): void {
        autoUpdater.logger.info('Update cancelled by user');
        this.cancellationToken.cancel();
        this.clients.forEach(c => c.reportCancelled());
    }

    downloadUpdate(): void {
        autoUpdater.logger.info('Downloading update');
        this.cancellationToken = new CancellationToken();
        autoUpdater.downloadUpdate(this.cancellationToken).catch((err: unknown) => autoUpdater.logger.error('Update download failed', err));
    }

    onStart(application: ElectronMainApplication): void {
    }

    onStop(application: ElectronMainApplication): void {
        this.stopUpdateCheckTimer();
    }

    private scheduleUpdateChecks(): void {
        this.stopUpdateCheckTimer();

        if (!this.settings.checkForUpdates) {
            return;
        }

        this.checkForUpdates(false);

        const intervalMs = Math.max(this.settings.checkInterval, 1) * 60 * 1000;

        this.updateCheckTimer = setInterval(() => {
            if (this.settings.checkForUpdates) {
                this.checkForUpdates(false);
            }
        }, intervalMs);
    }

    private stopUpdateCheckTimer(): void {
        if (this.updateCheckTimer) {
            clearInterval(this.updateCheckTimer);
            this.updateCheckTimer = undefined;
        }
    }

    setClient(client: TheiaUpdaterClient | undefined): void {
        if (client) {
            this.clients.push(client);
            if (this.reportOnFirstRegistration) {
                this.reportOnFirstRegistration = false;
                this.clients.forEach(c => c.updateAvailable(true, this.lastUpdateInfo));
            }
        }
    }

    disconnectClient(client: TheiaUpdaterClient): void {
        const index = this.clients.indexOf(client);
        if (index !== -1) {
            this.clients.splice(index, 1);
        }
    }

    dispose(): void {
        this.stopUpdateCheckTimer();
        this.clients.forEach(this.disconnectClient.bind(this));
    }

}
