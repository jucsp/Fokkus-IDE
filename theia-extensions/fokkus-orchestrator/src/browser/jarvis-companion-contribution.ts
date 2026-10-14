/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { MessageService } from '@theia/core/lib/common/message-service';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
    JarvisCompanionInfo,
    JarvisCompanionServer
} from '../common/jarvis-companion-protocol';
import { TriageEvent } from '../common/triage-protocol';
import { FokkusSwarmDispatchOutcome, FokkusSwarmEvents } from './fokkus-swarm-events';
import { TriageClientImpl } from './triage-service';

/** Comandos de la paleta para el compañero Jarvis. */
export namespace JarvisCompanionCommands {
    const CATEGORY = 'Fokkus';
    export const START: Command = { id: 'fokkus:jarvis-start', category: CATEGORY, label: 'Iniciar Fokkus-Jarvis' };
    export const CHECK: Command = { id: 'fokkus:jarvis-check', category: CATEGORY, label: 'Verificar estado de Jarvis' };
    export const INSTALL: Command = { id: 'fokkus:jarvis-install', category: CATEGORY, label: 'Descargar e instalar Fokkus-Jarvis' };
}

/** Elemento de la barra de estado que muestra el enlace con el compañero. */
export const JARVIS_COMPANION_STATUS_BAR_ID = 'fokkus-jarvis-companion-status';
/** Página de descargas del compañero independiente. */
export const JARVIS_COMPANION_RELEASES_URL = 'https://github.com/jucsp/Fokkus-Jarvis/releases';
/** Periodicidad del sondeo del estado del compañero. */
export const JARVIS_COMPANION_POLL_INTERVAL_MS = 15000;
/** Si el backend no está desplegado, el proxy RPC nunca responde: se corta con un timeout. */
const RPC_TIMEOUT_MS = 15000;
/** Máximo de ítems de la Bandeja que se reenvían a Jarvis por pasada. */
const TRIAGE_ALERT_LIMIT = 3;
/** Longitud máxima de cada resumen de agente en la notificación de fin del Swarm. */
const SWARM_SUMMARY_SNIPPET_MAX = 180;
/** Máximo de resultados de agente incluidos en el resumen. */
const SWARM_SUMMARY_AGENT_LIMIT = 5;

/** Vista del elemento de la barra de estado (texto, tooltip y comando al hacer clic). */
interface JarvisCompanionStatusView {
    text: string;
    tooltip: string;
    command: string;
}

function withCompanionTimeout<T>(promise: Promise<T>, timeoutMs: number = RPC_TIMEOUT_MS): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(
            () => reject(new Error('El conector de Fokkus-Jarvis no respondió. Revisa que el backend de Fokkus esté actualizado.')),
            timeoutMs
        );
        promise.then(
            value => { window.clearTimeout(timer); resolve(value); },
            error => { window.clearTimeout(timer); reject(error); }
        );
    });
}

/**
 * Conector del compañero Jarvis (sustituye a la ventana overlay de Electron).
 *
 * Muestra el estado en la barra de estado (Conectado / Detenido / No instalado), permite
 * iniciar o descargar `fokkus-jarvis` y reenvía al compañero los eventos del Swarm de
 * desarrollo y las alertas de la Bandeja.
 */
@injectable()
export class JarvisCompanionContribution implements CommandContribution, FrontendApplicationContribution {

    @inject(JarvisCompanionServer)
    protected readonly companionServer: JarvisCompanionServer;

    @inject(StatusBar)
    protected readonly statusBar: StatusBar;

    @inject(MessageService)
    protected readonly messageService: MessageService;

    @inject(WindowService)
    protected readonly windowService: WindowService;

    @inject(FokkusSwarmEvents)
    protected readonly swarmEvents: FokkusSwarmEvents;

    @inject(TriageClientImpl)
    protected readonly triageClient: TriageClientImpl;

    protected pollTimer: number | undefined;
    protected refreshing = false;

    onStart(): void {
        this.swarmEvents.onDidFinishDispatch(outcome => this.forwardSwarmCompleted(outcome));
        this.triageClient.onDidReceiveEvent(event => this.forwardTriageAlerts(event));
        this.refresh().catch(() => undefined);
        this.pollTimer = window.setInterval(
            () => { this.refresh().catch(() => undefined); },
            JARVIS_COMPANION_POLL_INTERVAL_MS
        );
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand(JarvisCompanionCommands.START, { execute: () => this.startJarvis() });
        commands.registerCommand(JarvisCompanionCommands.CHECK, { execute: () => this.checkStatus() });
        commands.registerCommand(JarvisCompanionCommands.INSTALL, { execute: () => this.offerInstall() });
    }

    /** Refresca el estado; evita solapar sondeos si el backend tarda en responder. */
    protected async refresh(): Promise<void> {
        if (this.refreshing) {
            return;
        }
        this.refreshing = true;
        try {
            const info = await this.fetchInfo();
            if (info) {
                this.updateStatusBar(info);
            }
        } finally {
            this.refreshing = false;
        }
    }

    protected async fetchInfo(logErrors: boolean = false): Promise<JarvisCompanionInfo | undefined> {
        try {
            return await withCompanionTimeout(this.companionServer.getCompanionInfo());
        } catch (error) {
            if (logErrors) {
                console.warn('[fokkus-jarvis-companion] No se pudo consultar el estado del compañero', error);
            }
            return undefined;
        }
    }

    protected updateStatusBar(info: JarvisCompanionInfo): void {
        const view = this.statusView(info);
        this.statusBar.setElement(JARVIS_COMPANION_STATUS_BAR_ID, {
            name: 'Jarvis',
            text: view.text,
            tooltip: view.tooltip,
            alignment: StatusBarAlignment.RIGHT,
            priority: 119,
            command: view.command,
            className: `fokkus-jarvis-companion-status fokkus-jarvis-companion-status--${info.status}`
        }).catch(error => console.warn('[fokkus-jarvis-companion] No se pudo actualizar la barra de estado', error));
    }

    /** Texto, tooltip y comando de clic según el estado del compañero. */
    protected statusView(info: JarvisCompanionInfo): JarvisCompanionStatusView {
        switch (info.status) {
            case 'connected':
                return {
                    text: '$(radio-tower) Jarvis: Conectado',
                    tooltip: 'Jarvis conectado y supervisando el Swarm',
                    command: JarvisCompanionCommands.CHECK.id
                };
            case 'installed-stopped':
                return {
                    text: '$(play) Iniciar Jarvis',
                    tooltip: 'Fokkus-Jarvis está instalado. Clic para ejecutar el asistente nativo',
                    command: JarvisCompanionCommands.START.id
                };
            default:
                return {
                    text: '$(cloud-download) Descargar Jarvis',
                    tooltip: 'Fokkus-Jarvis no está instalado. Clic para descargar desde GitHub',
                    command: JarvisCompanionCommands.INSTALL.id
                };
        }
    }

    protected async startJarvis(): Promise<void> {
        try {
            const result = await withCompanionTimeout(this.companionServer.startJarvis());
            if (result.success) {
                this.messageService.info('Fokkus-Jarvis se está iniciando. La barra de estado se actualizará al conectar.');
            } else {
                this.messageService.warn(result.error ?? 'No se pudo iniciar Fokkus-Jarvis.');
            }
        } catch (error) {
            this.messageService.error(error instanceof Error ? error.message : 'No se pudo iniciar Fokkus-Jarvis.');
        }
        await this.refresh();
    }

    protected async checkStatus(): Promise<void> {
        const info = await this.fetchInfo(true);
        if (!info) {
            this.messageService.warn('No se pudo consultar el estado de Fokkus-Jarvis. Revisa que el backend de Fokkus esté actualizado.');
            return;
        }
        this.updateStatusBar(info);
        switch (info.status) {
            case 'connected':
                await this.showConnectedOptions(info);
                break;
            case 'installed-stopped': {
                const action = await this.messageService.info(
                    'Fokkus-Jarvis está instalado pero apagado. ¿Iniciarlo ahora?',
                    'Iniciar'
                );
                if (action) {
                    await this.startJarvis();
                }
                break;
            }
            default:
                await this.offerInstall();
                break;
        }
    }

    /** Estado actual y opción de desconectar la supervisión. */
    protected async showConnectedOptions(info: JarvisCompanionInfo): Promise<void> {
        const detail = [
            info.version ? `versión ${info.version}` : undefined,
            info.state ? `estado ${info.state}` : undefined
        ].filter(part => !!part).join(' · ');
        const action = await this.messageService.info(
            `Jarvis está conectado y supervisando el Swarm${detail ? ` (${detail})` : ''}.`,
            'Desconectar'
        );
        if (action) {
            this.messageService.info(
                'Para desconectar, detén el proceso de Fokkus-Jarvis desde su propia ventana; ' +
                'la barra de estado reflejará el cambio en unos segundos.'
            );
            await this.refresh();
        }
    }

    protected async offerInstall(): Promise<void> {
        const action = await this.messageService.info(
            'Fokkus-Jarvis no está instalado. Puedes descargar la última versión desde GitHub Releases.',
            'Abrir descargas'
        );
        if (action) {
            this.windowService.openNewWindow(JARVIS_COMPANION_RELEASES_URL, { external: true });
        }
    }

    /** Reenvía a Jarvis el resultado del último turno del Swarm de desarrollo. */
    protected forwardSwarmCompleted(outcome: FokkusSwarmDispatchOutcome): void {
        const status = outcome.error ? 'failed' : outcome.busy ? 'skipped' : 'completed';
        const taskId = `swarm-${Date.now().toString(36)}`;
        const summary = this.buildSwarmSummary(outcome);
        this.companionServer.notifySwarmCompleted({ taskId, status, summary })
            .catch(error => console.warn('[fokkus-jarvis-companion] No se pudo notificar el fin del Swarm', error));
    }

    protected buildSwarmSummary(outcome: FokkusSwarmDispatchOutcome): string {
        if (outcome.error) {
            return `El despacho falló: ${outcome.error}`;
        }
        if (outcome.busy) {
            return 'El chat estaba ocupado y la tarea no llegó a ejecutarse.';
        }
        const results = outcome.result?.roleResults ?? [];
        if (results.length === 0) {
            return 'El despacho terminó sin resultados de agentes.';
        }
        const parts: string[] = [];
        for (const agentResult of results.slice(0, SWARM_SUMMARY_AGENT_LIMIT)) {
            const text = (agentResult.output ?? '').trim().replace(/\s+/g, ' ');
            const snippet = text.length > SWARM_SUMMARY_SNIPPET_MAX ? `${text.slice(0, SWARM_SUMMARY_SNIPPET_MAX)}…` : text;
            parts.push(`${agentResult.providerName} (${agentResult.status}): ${snippet || 'sin salida'}`);
        }
        return parts.join('\n');
    }

    /** Reenvía a Jarvis las solicitudes nuevas detectadas por la Bandeja. */
    protected forwardTriageAlerts(event: TriageEvent): void {
        if (event.kind !== 'items-detected' || event.items.length === 0) {
            return;
        }
        for (const item of event.items.slice(0, TRIAGE_ALERT_LIMIT)) {
            this.companionServer.notifyTriageAlert({ itemId: item.id, title: item.title, source: item.source })
                .catch(error => console.warn('[fokkus-jarvis-companion] No se pudo notificar la alerta de triage', error));
        }
    }
}
