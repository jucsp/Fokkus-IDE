/********************************************************************************
 * Copyright (C) 2020 TypeFox, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ElectronMainApplication, ElectronMainApplicationContribution } from '@theia/core/lib/electron-main/electron-main-application';
import { app } from '@theia/core/electron-shared/electron';
import { TheiaUpdater, TheiaUpdaterClient, UpdateInfo, UpdaterSettings } from '../../common/updater/theia-updater';
import { injectable } from '@theia/core/shared/inversify';
import { CancellationToken } from 'builder-util-runtime';
import { execFile } from 'child_process';

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
    private settingsReceived = false;
    private backgroundCheck = false;
    private pkconInstallRunning = false;
    private downloadedFile?: string;
    private updateDownloaded = false;

    constructor() {
        autoUpdater.autoDownload = false;
        autoUpdater.setFeedURL({
            provider: 'github',
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO
        });
        if (process.platform === 'linux') {
            autoUpdater.autoInstallOnAppQuit = false;
            autoUpdater.logger.info('PackageKit will be used to install Linux updates');
        }
        autoUpdater.on('update-available', (info: { version: string }) => {
            this.backgroundCheck = false;
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
            this.backgroundCheck = false;
            const notifyIfNoUpdate = this.notifyIfNoUpdate;
            this.notifyIfNoUpdate = false;
            if (this.initialCheck) {
                this.initialCheck = false;
            }
            this.clients.forEach(c => c.updateAvailable(false, undefined, notifyIfNoUpdate));
        });

        autoUpdater.on('update-downloaded', (event: { downloadedFile?: string }) => {
            this.downloadedFile = event.downloadedFile;
            this.updateDownloaded = true;
            this.clients.forEach(c => c.notifyReadyToInstall());
        });

        autoUpdater.on('error', (err: unknown) => {
            this.notifyIfNoUpdate = false;
            const wasBackground = this.backgroundCheck;
            this.backgroundCheck = false;
            if (err instanceof Error && err.message.includes('cancelled')) {
                return;
            }
            if (wasBackground) {
                autoUpdater.logger.warn('Background update check failed', err);
                return;
            }
            const errorLogPath = autoUpdater.logger.transports.file.getFile().path;
            this.clients.forEach(c => c.reportError({ message: 'An error has occurred while attempting to update.', errorLogPath }));
        });
    }

    checkForUpdates(notifyIfNoUpdate = true): void {
        this.notifyIfNoUpdate = this.notifyIfNoUpdate || notifyIfNoUpdate;
        this.backgroundCheck = false;
        autoUpdater.allowPrerelease = this.settings.channel !== 'stable';
        autoUpdater.checkForUpdates().catch((err: unknown) => autoUpdater.logger.error('Update check failed', err));
    }

    setUpdaterSettings(settings: UpdaterSettings): void {
        const settingsChanged = this.settings.checkForUpdates !== settings.checkForUpdates ||
            this.settings.checkInterval !== settings.checkInterval ||
            this.settings.channel !== settings.channel;
        const firstSettings = !this.settingsReceived;
        this.settingsReceived = true;
        this.settings = settings;
        if (firstSettings || settingsChanged) {
            this.scheduleUpdateChecks();
        }
    }

    onRestartToUpdateRequested(): void {
        if (this.pkconInstallRunning) {
            autoUpdater.logger.info('PackageKit installation already running; ignoring duplicate restart request');
            return;
        }
        if (process.platform === 'linux' && this.downloadedFile && /\.(rpm|deb)$/.test(this.downloadedFile)) {
            this.installWithPackageKit(this.downloadedFile);
        } else {
            autoUpdater.quitAndInstall();
        }
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

        this.runBackgroundCheck();

        const intervalMs = Math.max(this.settings.checkInterval, 1) * 60 * 1000;

        this.updateCheckTimer = setInterval(() => {
            if (this.settings.checkForUpdates) {
                this.runBackgroundCheck();
            }
        }, intervalMs);
    }

    private runBackgroundCheck(): void {
        if (this.updateDownloaded) {
            return;
        }
        this.backgroundCheck = true;
        autoUpdater.allowPrerelease = this.settings.channel !== 'stable';
        autoUpdater.checkForUpdates().catch((err: unknown) => autoUpdater.logger.error('Background update check failed', err));
    }

    private installWithPackageKit(file: string): void {
        this.pkconInstallRunning = true;
        const command = 'pkcon';
        const args = ['install-local', '--noninteractive', '--allow-untrusted', file];
        autoUpdater.logger.info(`Installing update with PackageKit: ${command} ${args.join(' ')}`);
        execFile(command, args, { timeout: 10 * 60 * 1000 }, err => {
            this.pkconInstallRunning = false;
            if (!err) {
                app.relaunch();
                app.quit();
                return;
            }
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                autoUpdater.logger.warn('PackageKit (pkcon) not found; falling back to quitAndInstall');
                autoUpdater.quitAndInstall();
                return;
            }
            const manualCommand = file.endsWith('.rpm')
                ? `sudo dnf install "${file}"`
                : `sudo apt install "${file}"`;
            autoUpdater.logger.error('PackageKit installation failed', err);
            const errorLogPath = autoUpdater.logger.transports.file.getFile().path;
            this.clients.forEach(c => c.reportError({
                message: `Unable to install the update automatically. Please run: ${manualCommand}`,
                errorLogPath
            }));
        });
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
