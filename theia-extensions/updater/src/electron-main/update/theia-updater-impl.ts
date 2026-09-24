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
import { spawn } from 'child_process';

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
        const pythonScript = this.packageKitPythonScript();
        const args = ['-c', pythonScript, file];
        autoUpdater.logger.info(`Installing update with PackageKit: pkcon install-local --plain --allow-untrusted ${file}`);
        const child = spawn('python3', args, {
            stdio: 'pipe',
            env: { ...process.env, LC_ALL: 'C.UTF-8' }
        });
        let stdout = '';
        let stderr = '';
        let promptResponses = 0;
        let finished = false;
        let timedOut = false;
        const timeout = setTimeout(() => {
            if (!finished) {
                autoUpdater.logger.warn('PackageKit installation timed out; terminating pkcon');
                timedOut = true;
                child.kill('SIGTERM');
            }
        }, 10 * 60 * 1000);
        timeout.unref();

        const finish = (code?: number, pythonError?: NodeJS.ErrnoException): void => {
            if (finished) {
                return;
            }
            finished = true;
            clearTimeout(timeout);
            this.pkconInstallRunning = false;
            if (pythonError) {
                this.reportPackageKitError(file, undefined, stdout, stderr, pythonError);
                return;
            }
            if (code === 0) {
                app.relaunch();
                app.quit();
                return;
            }
            if (code === 127) {
                autoUpdater.logger.warn('PackageKit (pkcon) not found; falling back to quitAndInstall');
                autoUpdater.quitAndInstall();
                return;
            }
            this.reportPackageKitError(file, code, stdout, stderr, undefined, timedOut);
        };

        child.stdout.on('data', (chunk: Buffer) => {
            const text = chunk.toString().replace(/\r/g, '');
            stdout = this.appendLimited(stdout, text);
            const prompts = this.countPackageKitPrompts(stdout);
            while (promptResponses < prompts) {
                promptResponses++;
                // Older pkcon versions flush the terminal input right after printing the prompt,
                // so answer with a short delay to avoid the reply being discarded.
                setTimeout(() => {
                    if (!finished) {
                        child.stdin.write('y\n');
                    }
                }, 500);
            }
        });

        child.stderr.on('data', (chunk: Buffer) => {
            const text = chunk.toString().replace(/\r/g, '');
            stderr = this.appendLimited(stderr, text);
        });

        child.stdin.on('error', () => {
            // Ignore write errors once the child has exited.
        });

        child.on('error', err => finish(undefined, err));

        child.on('close', (code, signal) => finish(!signal && typeof code === 'number' ? code : -1));

    }

    private reportPackageKitError(file: string, code: number | undefined, stdout: string, stderr: string,
        pythonError?: NodeJS.ErrnoException, timedOut = false): void {
        const detail = pythonError
            ? `python3 not available: ${pythonError.message}`
            : timedOut
                ? 'timed out waiting for PackageKit'
                : this.extractPackageKitErrorDetail(stdout, stderr, code);
        const manualCommand = this.packageKitManualCommand(file);
        autoUpdater.logger.error(`PackageKit installation failed (exit code: ${code ?? 'unknown'})`
            + `\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
            + (pythonError ? `\n--- error ---\n${pythonError.stack ?? pythonError.message}` : ''));
        const errorLogPath = autoUpdater.logger.transports.file.getFile().path;
        this.clients.forEach(c => c.reportError({
            message: `Unable to install the update automatically (${detail}). Please run in a terminal: ${manualCommand}`,
            errorLogPath,
            manualCommand
        }));
    }

    private packageKitManualCommand(file: string): string {
        return file.endsWith('.rpm')
            ? `sudo dnf install "${file}"`
            : `sudo apt install "${file}"`;
    }

    private extractPackageKitErrorDetail(stdout: string, stderr: string, code: number | undefined): string {
        const combined = `${stdout}\n${stderr}`;
        const lines = combined.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.startsWith('Fatal error:')) {
                return line.slice('Fatal error:'.length).trim();
            }
            if (line.startsWith('Error:')) {
                return line.slice('Error:'.length).trim();
            }
        }
        return `exit code ${code ?? 'unknown'}`;
    }

    private appendLimited(current: string, chunk: string): string {
        const combined = current + chunk;
        const maxLength = 64 * 1024;
        if (combined.length <= maxLength) {
            return combined;
        }
        return combined.slice(combined.length - maxLength);
    }

    private countPackageKitPrompts(text: string): number {
        const matches = text.match(/\[(N\/y|Y\/n)\]/g);
        return matches ? matches.length : 0;
    }

    private packageKitPythonScript(): string {
        // pkcon reads its confirmation prompts from the controlling terminal, not stdin,
        // so it has to run inside a pseudo-terminal when the IDE is launched from the desktop.
        return [
            'import os, pty, shutil, sys',
            'if shutil.which("pkcon") is None:',
            '    sys.exit(127)',
            'status = pty.spawn(["pkcon", "install-local", "--plain", "--allow-untrusted", sys.argv[1]])',
            'sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1)'
        ].join('\n');
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
