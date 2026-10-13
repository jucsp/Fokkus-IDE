/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { TRIAGE_POLL_INTERVAL_MS, TriagePollingStatus, TriagePollResult } from '../../common/triage-protocol';

export const TRIAGE_FIRST_POLL_DELAY_MS = 30000;

export interface TriagePollerOptions {
    /** Ejecuta una pasada completa por las fuentes. No debe lanzar (cada fuente aísla sus errores). */
    runPass(): Promise<TriagePollResult>;
    isEnabled(): Promise<boolean>;
    persistEnabled(enabled: boolean): Promise<void>;
    onChange(status: TriagePollingStatus): void;
    intervalMs?: number;
}

/**
 * Timer del sondeo (#26 HU-4): un único setTimeout encadenado, sin pasadas solapadas.
 * `pollNow` durante una pasada devuelve la MISMA promesa.
 */
export class TriagePoller {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private current: Promise<TriagePollResult> | undefined;
    private enabled = true;
    private running = false;
    private lastRunAt: string | undefined;
    private nextRunAt: string | undefined;
    private lastResult: TriagePollResult | undefined;
    private disposed = false;
    private readonly intervalMs: number;

    constructor(protected readonly options: TriagePollerOptions) {
        this.intervalMs = options.intervalMs ?? TRIAGE_POLL_INTERVAL_MS;
    }

    async start(firstDelayMs: number = TRIAGE_FIRST_POLL_DELAY_MS): Promise<void> {
        this.enabled = await this.options.isEnabled();
        if (this.enabled) {
            this.schedule(firstDelayMs);
        }
    }

    status(): TriagePollingStatus {
        return {
            enabled: this.enabled,
            intervalMs: this.intervalMs,
            running: this.running,
            ...(this.lastRunAt ? { lastRunAt: this.lastRunAt } : {}),
            ...(this.enabled && this.nextRunAt ? { nextRunAt: this.nextRunAt } : {}),
            ...(this.lastResult ? { lastResult: this.lastResult } : {})
        };
    }

    async refreshEnabled(): Promise<void> {
        this.enabled = await this.options.isEnabled();
    }

    pollNow(): Promise<TriagePollResult> {
        if (this.current) {
            return this.current;
        }
        this.clearTimer();
        this.running = true;
        const pass = (async () => {
            this.options.onChange(this.status());
            try {
                const result = await this.options.runPass();
                this.lastResult = result;
                this.lastRunAt = result.finishedAt;
                return result;
            } finally {
                this.current = undefined;
                this.running = false;
                if (this.enabled && !this.disposed) {
                    this.schedule(this.intervalMs);
                }
                this.options.onChange(this.status());
            }
        })();
        this.current = pass;
        return pass;
    }

    async setEnabled(enabled: boolean): Promise<TriagePollingStatus> {
        await this.options.persistEnabled(enabled);
        this.enabled = enabled;
        if (enabled) {
            if (!this.current && !this.timer) {
                this.schedule(this.intervalMs);
            }
        } else {
            this.clearTimer();
        }
        const status = this.status();
        this.options.onChange(status);
        return status;
    }

    dispose(): void {
        this.disposed = true;
        this.clearTimer();
    }

    private schedule(delayMs: number): void {
        this.clearTimer();
        if (this.disposed) {
            return;
        }
        this.nextRunAt = new Date(Date.now() + delayMs).toISOString();
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.pollNow().catch(() => undefined);
        }, delayMs);
        // El timer no debe mantener vivo el proceso del backend.
        if (typeof this.timer === 'object' && 'unref' in this.timer) {
            this.timer.unref();
        }
    }

    private clearTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.nextRunAt = undefined;
    }
}
