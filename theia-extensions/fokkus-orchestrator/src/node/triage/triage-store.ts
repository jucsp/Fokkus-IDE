/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { promises as fs } from 'fs';
import * as os from 'os';
import { join } from 'path';
import { ILogger } from '@theia/core/lib/common';
import { inject, injectable } from '@theia/core/shared/inversify';
import {
    TRIAGE_CATEGORIES,
    TRIAGE_DESCRIPTION_MAX_LENGTH,
    TRIAGE_TITLE_MAX_LENGTH,
    TriageAuthor,
    TriageCounts,
    TriageItem,
    TriageSource
} from '../../common/triage-protocol';
import { classify } from './triage-classifier';
import { writeJsonAtomic } from './triage-config';
import { TriageFeedbackStore } from './triage-feedback';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ITEMS = 2000;

export function triageItemsPath(): string {
    return join(os.homedir(), '.fokkus', 'triage-items.json');
}

/** Lo que una fuente detectó para un hilo (antes de convertirse en ítem). */
export interface TriageCandidate {
    id: string;
    source: TriageSource;
    channel: string;
    author: TriageAuthor;
    authorIsInternal: boolean;
    receivedAt: string;
    lastActivityAt: string;
    messageCount: number;
    permalink?: string;
    originalSubject: string;
    originalText: string;
}

export type UpsertOutcome = 'created' | 'updated' | 'unchanged';

interface TriageItemsFile {
    version: 1;
    items: TriageItem[];
    cursors: { slack: Record<string, string>; gmail: { lastPollAt?: string } };
}

function emptyFile(): TriageItemsFile {
    return { version: 1, items: [], cursors: { slack: {}, gmail: {} } };
}

function isItem(value: unknown): value is TriageItem {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const item = value as Partial<TriageItem>;
    return typeof item.id === 'string' && (item.source === 'slack' || item.source === 'gmail')
        && (item.status === 'pending' || item.status === 'approved' || item.status === 'discarded')
        && typeof item.title === 'string' && typeof item.lastActivityAt === 'string'
        && TRIAGE_CATEGORIES.some(c => c.id === item.category);
}

function truncate(value: string, max: number): string {
    return value.length > max ? value.slice(0, max) : value;
}

/** Título a partir del asunto (o de la primera línea del texto). */
export function deriveTitle(subject: string, text: string): string {
    const first = (subject || text).split('\n').map(l => l.trim()).find(Boolean) ?? '';
    const collapsed = first.replace(/\s+/g, ' ');
    if (!collapsed) {
        return '(sin asunto)';
    }
    return collapsed.length > TRIAGE_TITLE_MAX_LENGTH ? collapsed.slice(0, TRIAGE_TITLE_MAX_LENGTH - 1) + '…' : collapsed;
}

/**
 * Persistencia de ítems y cursores en ~/.fokkus/triage-items.json. Carga perezosa en memoria;
 * cada mutación pasa por una cola de promesas y se guarda de forma atómica (0600).
 */
@injectable()
export class TriageStore {
    private data: TriageItemsFile | undefined;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(
        @inject(ILogger) protected readonly logger: ILogger,
        @inject(TriageFeedbackStore) protected readonly feedback: TriageFeedbackStore
    ) { }

    private async load(): Promise<TriageItemsFile> {
        if (this.data) {
            return this.data;
        }
        const target = triageItemsPath();
        let raw: string;
        try {
            raw = await fs.readFile(target, 'utf8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.logger.error(`No se pudo leer la Bandeja (${err instanceof Error ? err.name : 'Error'})`);
            }
            this.data = emptyFile();
            return this.data;
        }
        try {
            const parsed: unknown = JSON.parse(raw);
            const root = parsed && typeof parsed === 'object' ? parsed as Partial<TriageItemsFile> : {};
            if (!Array.isArray(root.items)) {
                throw new Error('estructura inválida');
            }
            const cursors = root.cursors && typeof root.cursors === 'object' ? root.cursors : emptyFile().cursors;
            const slack: Record<string, string> = {};
            for (const [channel, ts] of Object.entries(cursors.slack ?? {})) {
                if (typeof ts === 'string') {
                    slack[channel] = ts;
                }
            }
            const lastPollAt = typeof cursors.gmail?.lastPollAt === 'string' ? cursors.gmail.lastPollAt : undefined;
            this.data = { version: 1, items: root.items.filter(isItem), cursors: { slack, gmail: lastPollAt ? { lastPollAt } : {} } };
        } catch {
            const backup = `${target}.corrupt-${Date.now()}`;
            this.logger.error('triage-items.json está dañado: se aparta y la Bandeja empieza vacía');
            await fs.rename(target, backup).catch(() => undefined);
            this.data = emptyFile();
        }
        return this.data;
    }

    /** Ejecuta una mutación serializada y guarda el archivo. */
    mutate<T>(fn: (data: TriageItemsFile) => T, shouldWrite: (result: T) => boolean = () => true): Promise<T> {
        const next = this.queue.then(async () => {
            const data = await this.load();
            const result = fn(data);
            if (!shouldWrite(result)) {
                return result;
            }
            this.applyRetention(data);
            await writeJsonAtomic(triageItemsPath(), data);
            return result;
        });
        this.queue = next.catch(() => undefined);
        return next;
    }

    /** Lectura consistente: espera a que terminen las escrituras en cola. */
    private read<T>(fn: (data: TriageItemsFile) => T): Promise<T> {
        const next = this.queue.then(async () => fn(await this.load()));
        this.queue = next.catch(() => undefined);
        return next;
    }

    list(): Promise<TriageItem[]> {
        return this.read(data => data.items.map(item => ({ ...item })));
    }

    get(id: string): Promise<TriageItem | undefined> {
        return this.read(data => {
            const item = data.items.find(i => i.id === id);
            return item ? { ...item } : undefined;
        });
    }

    counts(): Promise<TriageCounts> {
        return this.read(data => countItems(data.items));
    }

    /** Aplica `fn` al ítem y lo guarda. `fn` puede lanzar para abortar sin escribir. */
    updateItem(id: string, fn: (item: TriageItem) => void): Promise<TriageItem> {
        return this.mutate(data => {
            const item = data.items.find(i => i.id === id);
            if (!item) {
                throw new Error('Solicitud no encontrada');
            }
            fn(item);
            return { ...item };
        });
    }

    async upsertFromSource(candidate: TriageCandidate): Promise<{ outcome: UpsertOutcome; item: TriageItem }> {
        const feedbackRule = await this.feedback.match(candidate);
        const result = await this.mutate(data => {
            const now = new Date().toISOString();
            const originalText = truncate(candidate.originalText, TRIAGE_DESCRIPTION_MAX_LENGTH);
            const classification = classify({
                source: candidate.source,
                channel: candidate.channel,
                subject: candidate.originalSubject,
                text: originalText,
                authorEmail: candidate.author.email,
                authorIsInternal: candidate.authorIsInternal
            });
            const existing = data.items.find(i => i.id === candidate.id);
            if (!existing) {
                const autoDiscard = !!feedbackRule;
                const item: TriageItem = {
                    id: candidate.id,
                    source: candidate.source,
                    channel: candidate.channel,
                    author: candidate.author,
                    receivedAt: candidate.receivedAt,
                    lastActivityAt: candidate.lastActivityAt,
                    messageCount: candidate.messageCount,
                    ...(candidate.permalink ? { permalink: candidate.permalink } : {}),
                    originalSubject: truncate(candidate.originalSubject, TRIAGE_TITLE_MAX_LENGTH),
                    originalText,
                    title: deriveTitle(candidate.originalSubject, originalText),
                    description: originalText,
                    category: classification.category,
                    suggestedCategory: classification.category,
                    confidence: classification.confidence,
                    classificationReason: classification.reason,
                    edited: false,
                    status: autoDiscard ? 'discarded' : 'pending',
                    ...(autoDiscard && feedbackRule ? {
                        discardReason: `Auto-descartado por regla aprendida: ${feedbackRule.reason}`,
                        autoDiscarded: true,
                        autoDiscardReason: feedbackRule.reason
                    } : {}),
                    updatedAt: now
                };
                data.items.push(item);
                return { outcome: 'created' as const, item: { ...item } };
            }

            const changed = existing.messageCount !== candidate.messageCount
                || existing.lastActivityAt !== candidate.lastActivityAt
                || (existing.status === 'pending' && existing.originalText !== originalText);
            if (!changed) {
                return { outcome: 'unchanged' as const, item: { ...existing } };
            }
            existing.messageCount = candidate.messageCount;
            existing.lastActivityAt = candidate.lastActivityAt;
            if (existing.status === 'pending') {
                existing.originalText = originalText;
                if (candidate.permalink && !existing.permalink) {
                    existing.permalink = candidate.permalink;
                }
                existing.suggestedCategory = classification.category;
                existing.confidence = classification.confidence;
                existing.classificationReason = classification.reason;
                if (!existing.edited) {
                    existing.category = classification.category;
                    existing.description = originalText;
                }
            }
            return { outcome: 'updated' as const, item: { ...existing } };
        }, outcome => outcome.outcome !== 'unchanged');

        if (feedbackRule && result.outcome === 'created') {
            await this.feedback.incrementHits(feedbackRule.id).catch(() => undefined);
        }
        return result;
    }

    getSlackCursor(channelId: string): Promise<string | undefined> {
        return this.read(data => data.cursors.slack[channelId]);
    }

    setSlackCursor(channelId: string, ts: string): Promise<void> {
        return this.mutate(data => {
            data.cursors.slack[channelId] = ts;
        });
    }

    getGmailLastPollAt(): Promise<string | undefined> {
        return this.read(data => data.cursors.gmail.lastPollAt);
    }

    setGmailLastPollAt(iso: string): Promise<void> {
        return this.mutate(data => {
            data.cursors.gmail.lastPollAt = iso;
        });
    }

    /** Purga aprobadas/descartadas de más de 30 días y aplica el tope de ítems (nunca borra pendientes). */
    private applyRetention(data: TriageItemsFile): void {
        const limit = Date.now() - RETENTION_MS;
        data.items = data.items.filter(item => item.status === 'pending' || Date.parse(item.updatedAt) >= limit);
        if (data.items.length > MAX_ITEMS) {
            const removable = data.items.filter(item => item.status !== 'pending')
                .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
            const drop = new Set(removable.slice(0, data.items.length - MAX_ITEMS).map(item => item.id));
            data.items = data.items.filter(item => !drop.has(item.id));
        }
    }
}

export function countItems(items: readonly TriageItem[]): TriageCounts {
    const counts: TriageCounts = { pending: 0, approved: 0, discarded: 0 };
    for (const item of items) {
        counts[item.status]++;
    }
    return counts;
}
