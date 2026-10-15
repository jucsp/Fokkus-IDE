/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { expect } from 'chai';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    buildJarvisPingRequest,
    buildJarvisRpcNotification,
    jarvisSocketCandidates,
    JARVIS_METHOD_SWARM_COMPLETED,
    JARVIS_METHOD_SWARM_TASK,
    JARVIS_METHOD_TRIAGE_ALERT,
    JARVIS_CONFIG_FILENAME,
    JARVIS_PING_METHOD,
    JARVIS_SOCKET_FILENAME,
    JarvisCompanionServerImpl,
    resolveJarvisSocketPath
} from './jarvis-companion-server';

/** Servidor de pruebas que captura las notificaciones en vez de enviarlas por el socket. */
class CapturingJarvisCompanionServer extends JarvisCompanionServerImpl {

    public readonly sent: { method: string; params: Record<string, unknown> }[] = [];

    protected override async sendNotification(method: string, params: Record<string, unknown>): Promise<void> {
        this.sent.push({ method, params });
    }
}

describe('jarvis-companion-server', () => {

    describe('resolución de la ruta del socket', () => {
        it('usa ~/.fokkus/jarvis.sock por defecto', () => {
            const home = '/home/fokkus';
            const expected = join(home, '.fokkus', JARVIS_SOCKET_FILENAME);
            expect(resolveJarvisSocketPath({}, home)).to.equal(expected);
            expect(jarvisSocketCandidates({}, home)[0]).to.equal(expected);
        });

        it('respeta el override FOKKUS_JARVIS_SOCKET y añade el candidato XDG', () => {
            expect(resolveJarvisSocketPath({ FOKKUS_JARVIS_SOCKET: '/tmp/jarvis.sock' }, '/home/fokkus'))
                .to.equal('/tmp/jarvis.sock');

            const candidates = jarvisSocketCandidates({ XDG_RUNTIME_DIR: '/run/user/1000' }, '/home/fokkus');
            expect(candidates[0]).to.equal(join('/home/fokkus', '.fokkus', JARVIS_SOCKET_FILENAME));
            expect(candidates).to.include(join('/run/user/1000', JARVIS_SOCKET_FILENAME));
        });
    });

    describe('detección de estado', () => {
        const managedKeys = ['HOME', 'PATH', 'XDG_RUNTIME_DIR', 'FOKKUS_JARVIS_BINARY', 'FOKKUS_JARVIS_SOCKET'];
        const original: Record<string, string | undefined> = {};
        let home = '';

        beforeEach(() => {
            for (const key of managedKeys) {
                original[key] = process.env[key];
            }
            home = mkdtempSync(join(tmpdir(), 'fokkus-jarvis-spec-'));
            process.env.HOME = home;
            process.env.PATH = '';
            delete process.env.XDG_RUNTIME_DIR;
            delete process.env.FOKKUS_JARVIS_BINARY;
            delete process.env.FOKKUS_JARVIS_SOCKET;
        });

        afterEach(() => {
            for (const key of managedKeys) {
                const value = original[key];
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
            rmSync(home, { recursive: true, force: true });
        });

        it("reporta 'not-installed' cuando no existen ni el binario ni el socket", async () => {
            const info = await new JarvisCompanionServerImpl().getCompanionInfo();
            expect(info.status).to.equal('not-installed');
            expect(info.installed).to.equal(false);
            expect(info.running).to.equal(false);
            expect(info.binaryPath).to.equal(undefined);
            expect(info.socketPath).to.equal(join(home, '.fokkus', JARVIS_SOCKET_FILENAME));
        });

        it("guarda una ruta de ejecutable configurada y pasa a 'installed-stopped'", async () => {
            const binary = join(home, 'apps', 'fokkus-jarvis');
            mkdirSync(join(home, 'apps'));
            writeFileSync(binary, '#!/bin/sh\n');
            chmodSync(binary, 0o755);

            const server = new JarvisCompanionServerImpl();
            const result = await server.setBinaryPath(`  ${binary}  `);
            expect(result.success).to.equal(true);
            expect(result.info.status).to.equal('installed-stopped');
            expect(result.info.binaryPath).to.equal(binary);
            expect(result.info.configuredBinaryPath).to.equal(binary);

            // Persiste entre instancias (~/.fokkus/jarvis.json).
            const reloaded = await new JarvisCompanionServerImpl().getCompanionInfo();
            expect(reloaded.configuredBinaryPath).to.equal(binary);

            const reset = await server.setBinaryPath('');
            expect(reset.success).to.equal(true);
            expect(reset.info.status).to.equal('not-installed');
            expect(reset.info.configuredBinaryPath).to.equal(undefined);
            expect(existsSync(join(home, '.fokkus', JARVIS_CONFIG_FILENAME))).to.equal(false);
        });

        it('rechaza rutas relativas, directorios y archivos sin permiso de ejecución', async () => {
            const server = new JarvisCompanionServerImpl();
            const plain = join(home, 'no-ejecutable');
            writeFileSync(plain, 'x');
            chmodSync(plain, 0o644);

            for (const candidate of ['bin/fokkus-jarvis', home, plain, join(home, 'no-existe')]) {
                const result = await server.setBinaryPath(candidate);
                expect(result.success, candidate).to.equal(false);
                expect(result.error, candidate).to.be.a('string');
                expect(result.info.configuredBinaryPath, candidate).to.equal(undefined);
            }
            expect(existsSync(join(home, '.fokkus', JARVIS_CONFIG_FILENAME))).to.equal(false);
        });

        it('ignora un jarvis.json corrupto', async () => {
            mkdirSync(join(home, '.fokkus'));
            writeFileSync(join(home, '.fokkus', JARVIS_CONFIG_FILENAME), '{ no es json');
            const info = await new JarvisCompanionServerImpl().getCompanionInfo();
            expect(info.status).to.equal('not-installed');
            expect(info.configuredBinaryPath).to.equal(undefined);
        });
    });

    describe('formateo de mensajes JSON-RPC 2.0', () => {
        it('construye notificaciones sin id y terminadas en salto de línea', () => {
            const line = buildJarvisRpcNotification(JARVIS_METHOD_SWARM_TASK, { taskId: 't1' });
            expect(line.endsWith('\n')).to.equal(true);

            const parsed = JSON.parse(line.trim()) as { jsonrpc: string; method: string; params: Record<string, unknown>; id?: unknown };
            expect(parsed.jsonrpc).to.equal('2.0');
            expect(parsed.method).to.equal(JARVIS_METHOD_SWARM_TASK);
            expect(parsed.params).to.deep.equal({ taskId: 't1' });
            expect(parsed).to.not.have.property('id');
        });

        it('construye el ping con id, método y jsonrpc 2.0', () => {
            const parsed = JSON.parse(buildJarvisPingRequest(7).trim()) as { jsonrpc: string; id: number; method: string };
            expect(parsed.jsonrpc).to.equal('2.0');
            expect(parsed.id).to.equal(7);
            expect(parsed.method).to.equal(JARVIS_PING_METHOD);
        });

        it('mapea notifySwarmTask al método y parámetros correctos', async () => {
            const server = new CapturingJarvisCompanionServer();
            await server.notifySwarmTask({ taskId: 't1', agent: 'dev', goal: 'implementar login' });
            expect(server.sent).to.deep.equal([
                { method: JARVIS_METHOD_SWARM_TASK, params: { taskId: 't1', agent: 'dev', goal: 'implementar login' } }
            ]);
        });

        it('mapea notifySwarmCompleted al método y parámetros correctos', async () => {
            const server = new CapturingJarvisCompanionServer();
            await server.notifySwarmCompleted({ taskId: 't1', status: 'done', summary: 'listo' });
            expect(server.sent).to.deep.equal([
                { method: JARVIS_METHOD_SWARM_COMPLETED, params: { taskId: 't1', status: 'done', summary: 'listo' } }
            ]);
        });

        it('mapea notifyTriageAlert al método y parámetros correctos', async () => {
            const server = new CapturingJarvisCompanionServer();
            await server.notifyTriageAlert({ itemId: 'i1', title: 'Nueva solicitud', source: 'soporte' });
            expect(server.sent).to.deep.equal([
                { method: JARVIS_METHOD_TRIAGE_ALERT, params: { itemId: 'i1', title: 'Nueva solicitud', source: 'soporte' } }
            ]);
        });
    });
});
