/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { promises as fs, constants } from 'fs';
import { spawn } from 'child_process';
import * as net from 'net';
import { homedir } from 'os';
import { delimiter, join } from 'path';
import { injectable } from '@theia/core/shared/inversify';
import {
    JarvisCompanionInfo,
    JarvisCompanionServer,
    JarvisCompanionStatus
} from '../common/jarvis-companion-protocol';

/** Nombre del binario del compañero independiente. */
export const JARVIS_BINARY_NAME = 'fokkus-jarvis';
/** Nombre del archivo del socket dentro de ~/.fokkus. */
export const JARVIS_SOCKET_FILENAME = 'jarvis.sock';
/** Método JSON-RPC que usa el ping de comprobación. */
export const JARVIS_PING_METHOD = 'jarvis.ping';
/** Métodos JSON-RPC de notificación hacia el compañero. */
export const JARVIS_METHOD_SWARM_TASK = 'swarm.task';
export const JARVIS_METHOD_SWARM_COMPLETED = 'swarm.completed';
export const JARVIS_METHOD_TRIAGE_ALERT = 'triage.alert';

/** Tiempo máximo (ms) para recibir respuesta al ping del socket. */
export const JARVIS_PING_TIMEOUT_MS = 600;
/** Tiempo máximo (ms) para entregar una notificación por el socket. */
export const JARVIS_NOTIFY_TIMEOUT_MS = 2000;
/** Tiempo máximo (ms) de espera del evento `spawn` al arrancar el compañero. */
const JARVIS_START_TIMEOUT_MS = 5000;

/** Resultado del ping al socket del compañero. */
export interface JarvisPingResult {
    connected: boolean;
    version?: string;
    state?: string;
}

/** Directorio raíz del usuario, priorizando HOME. */
function resolveHomeDir(env: NodeJS.ProcessEnv): string {
    const home = (env.HOME ?? '').trim();
    return home || homedir();
}

/**
 * Rutas candidatas del socket Unix del compañero. La primera gana en la interfaz
 * (`socketPath`); las demás se prueban por compatibilidad con entornos XDG.
 */
export function jarvisSocketCandidates(env: NodeJS.ProcessEnv, homeDir: string): string[] {
    const override = (env.FOKKUS_JARVIS_SOCKET ?? '').trim();
    if (override) {
        return [override];
    }
    const candidates: string[] = [join(homeDir, '.fokkus', JARVIS_SOCKET_FILENAME)];
    const runtimeDir = (env.XDG_RUNTIME_DIR ?? '').trim();
    if (runtimeDir) {
        candidates.push(join(runtimeDir, JARVIS_SOCKET_FILENAME));
    }
    return candidates;
}

/** Ruta canónica del socket que se reporta en la interfaz. */
export function resolveJarvisSocketPath(env: NodeJS.ProcessEnv, homeDir: string): string {
    return jarvisSocketCandidates(env, homeDir)[0];
}

/** Rutas candidatas del binario `fokkus-jarvis`, en orden de prioridad. */
export function jarvisBinaryCandidates(env: NodeJS.ProcessEnv, homeDir: string): string[] {
    const candidates: string[] = [];
    const override = (env.FOKKUS_JARVIS_BINARY ?? '').trim();
    if (override) {
        candidates.push(override);
    }
    const pathDirs = (env.PATH ?? '').split(delimiter).filter(dir => !!dir);
    for (const dir of pathDirs) {
        candidates.push(join(dir, JARVIS_BINARY_NAME));
    }
    candidates.push(join(homeDir, '.cargo', 'bin', JARVIS_BINARY_NAME));
    candidates.push(join(homeDir, '.local', 'bin', JARVIS_BINARY_NAME));
    return candidates;
}

/** Construye la línea JSON-RPC del ping (terminada en salto de línea). */
export function buildJarvisPingRequest(id: number = 1): string {
    return `${JSON.stringify({ jsonrpc: '2.0', id, method: JARVIS_PING_METHOD })}\n`;
}

/** Construye una notificación JSON-RPC 2.0 (sin id) terminada en salto de línea. */
export function buildJarvisRpcNotification(method: string, params: Record<string, unknown>): string {
    return `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`;
}

/** Interpreta la respuesta del ping: cualquier respuesta válida prueba que el compañero está vivo. */
export function parseJarvisPingResponse(raw: string): JarvisPingResult {
    const text = raw.trim();
    if (!text) {
        return { connected: false };
    }
    try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') {
            return { connected: true };
        }
        const record = parsed as { result?: unknown; error?: unknown };
        if (record.error) {
            return { connected: false };
        }
        const result = record.result && typeof record.result === 'object'
            ? record.result as { version?: unknown; state?: unknown }
            : undefined;
        return {
            connected: true,
            version: typeof result?.version === 'string' ? result.version : undefined,
            state: typeof result?.state === 'string' ? result.state : undefined
        };
    } catch {
        // Respuesta no-JSON: el socket contestó, así que el compañero está vivo.
        return { connected: true };
    }
}

/**
 * Implementación del «Jarvis Companion Connector»: detecta el binario `fokkus-jarvis`,
 * comprueba el socket IPC `~/.fokkus/jarvis.sock` y reenvía notificaciones JSON-RPC 2.0.
 */
@injectable()
export class JarvisCompanionServerImpl implements JarvisCompanionServer {

    async getCompanionInfo(): Promise<JarvisCompanionInfo> {
        const homeDir = resolveHomeDir(process.env);
        const binaryPath = await this.findBinaryPath();
        const candidates = jarvisSocketCandidates(process.env, homeDir);
        const socketPath = await this.pickSocketPath(candidates);
        const ping = await this.pingCompanion(socketPath);
        const installed = !!binaryPath;
        const running = ping.connected;
        const status: JarvisCompanionStatus = running ? 'connected' : installed ? 'installed-stopped' : 'not-installed';
        return { status, installed, running, version: ping.version, socketPath, binaryPath, state: ping.state };
    }

    async startJarvis(): Promise<{ success: boolean; error?: string }> {
        const binaryPath = await this.findBinaryPath();
        if (!binaryPath) {
            return { success: false, error: 'Fokkus-Jarvis no está instalado. Descárgalo desde GitHub Releases.' };
        }
        return new Promise<{ success: boolean; error?: string }>(resolve => {
            let settled = false;
            const finish = (result: { success: boolean; error?: string }): void => {
                if (!settled) {
                    settled = true;
                    resolve(result);
                }
            };
            try {
                const child = spawn(binaryPath, [], { detached: true, stdio: 'ignore' });
                child.on('error', err => finish({ success: false, error: err instanceof Error ? err.message : String(err) }));
                child.on('spawn', () => finish({ success: true }));
                child.unref();
                setTimeout(() => finish({ success: true }), JARVIS_START_TIMEOUT_MS);
            } catch (err) {
                finish({ success: false, error: err instanceof Error ? err.message : String(err) });
            }
        });
    }

    async notifySwarmTask(task: { taskId: string; agent: string; goal: string }): Promise<void> {
        await this.sendNotification(JARVIS_METHOD_SWARM_TASK, { taskId: task.taskId, agent: task.agent, goal: task.goal });
    }

    async notifySwarmCompleted(result: { taskId: string; status: string; summary: string }): Promise<void> {
        await this.sendNotification(JARVIS_METHOD_SWARM_COMPLETED, { taskId: result.taskId, status: result.status, summary: result.summary });
    }

    async notifyTriageAlert(alert: { itemId: string; title: string; source: string }): Promise<void> {
        await this.sendNotification(JARVIS_METHOD_TRIAGE_ALERT, { itemId: alert.itemId, title: alert.title, source: alert.source });
    }

    /** Envía una notificación por el socket SOLO si el compañero responde al ping. */
    protected async sendNotification(method: string, params: Record<string, unknown>): Promise<void> {
        const info = await this.getCompanionInfo();
        if (!info.running) {
            return;
        }
        const line = buildJarvisRpcNotification(method, params);
        try {
            await this.writeToSocket(info.socketPath, line);
        } catch (err) {
            console.warn('[fokkus-jarvis-companion] No se pudo notificar a Jarvis:', err instanceof Error ? err.message : String(err));
        }
    }

    /** Primer binario accesible de entre las rutas candidatas. */
    protected async findBinaryPath(): Promise<string | undefined> {
        const homeDir = resolveHomeDir(process.env);
        for (const candidate of jarvisBinaryCandidates(process.env, homeDir)) {
            if (await this.isExecutable(candidate)) {
                return candidate;
            }
        }
        return undefined;
    }

    protected async isExecutable(path: string): Promise<boolean> {
        try {
            await fs.access(path, constants.X_OK);
            return true;
        } catch {
            return false;
        }
    }

    /** Devuelve el primer socket existente o, si no hay ninguno, el candidato principal. */
    protected async pickSocketPath(candidates: readonly string[]): Promise<string> {
        for (const candidate of candidates) {
            try {
                await fs.access(candidate, constants.F_OK);
                return candidate;
            } catch {
                // Candidato inexistente: se prueba el siguiente.
            }
        }
        return candidates[0];
    }

    /** Conecta al socket, envía el ping y espera la respuesta con un timeout de 600 ms. */
    protected pingCompanion(socketPath: string): Promise<JarvisPingResult> {
        return new Promise<JarvisPingResult>(resolve => {
            let settled = false;
            const socket = net.createConnection(socketPath);
            const finish = (result: JarvisPingResult): void => {
                if (settled) {
                    return;
                }
                settled = true;
                socket.destroy();
                resolve(result);
            };
            const chunks: Buffer[] = [];
            socket.setTimeout(JARVIS_PING_TIMEOUT_MS, () => finish({ connected: false }));
            socket.on('connect', () => socket.write(buildJarvisPingRequest()));
            socket.on('data', (chunk: Buffer) => finish(parseJarvisPingResponse(Buffer.concat([...chunks, chunk]).toString('utf8'))));
            socket.on('error', () => finish({ connected: false }));
            socket.on('close', () => finish({ connected: false }));
        });
    }

    /** Escribe una línea JSON-RPC por el socket y resuelve al confirmar el envío. */
    protected writeToSocket(socketPath: string, line: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const socket = net.createConnection(socketPath);
            const finish = (err?: Error): void => {
                if (settled) {
                    return;
                }
                settled = true;
                socket.destroy();
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            };
            socket.setTimeout(JARVIS_NOTIFY_TIMEOUT_MS, () => finish(new Error('Tiempo de espera agotado al contactar con Fokkus-Jarvis')));
            socket.on('connect', () => socket.write(line, () => finish()));
            socket.on('error', err => finish(err));
            socket.on('close', () => finish());
        });
    }
}
