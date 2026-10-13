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
    TRIAGE_FEEDBACK_RULE_ID_MAX,
    TRIAGE_FEEDBACK_RULE_SUBJECT_MAX,
    TriageFeedbackRule
} from '../../common/triage-protocol';
import { normalizeText } from './triage-classifier';
import { writeJsonAtomic } from './triage-config';

const MAX_KEYWORDS = 8;
const MIN_KEYWORD_LENGTH = 3;

/** Palabras sin valor discriminante: se ignoran al inferir el patrón de asunto. */
const STOPWORDS = new Set([
    'para', 'como', 'con', 'del', 'los', 'las', 'una', 'unos', 'unas', 'este', 'esta', 'estos', 'estas',
    'the', 'and', 'for', 'you', 'your', 'our', 'from', 'with', 'this', 'that', 'have', 'has', 'will',
    'sobre', 'acerca', 'nota', 'aviso', 'mensaje', 'email', 'correo', 'hola', 'buenos', 'buenas'
]);

export function triageFeedbackPath(): string {
    return join(os.homedir(), '.fokkus', 'triage-feedback.json');
}

/** Entrada mínima para inferir una regla a partir de un ítem descartado con motivo. */
export interface FeedbackDiscardInput {
    author: { email?: string };
    originalSubject: string;
    reason: string;
}

/** Entrada mínima para evaluar un candidato entrante contra una regla. */
export interface FeedbackMatchInput {
    author: { email?: string };
    originalSubject: string;
}

export function extractKeywords(...parts: string[]): string[] {
    const seen = new Set<string>();
    const keywords: string[] = [];
    const tokens = normalizeText(parts.join(' ')).split(/[^a-z0-9]+/);
    for (const token of tokens) {
        if (token.length < MIN_KEYWORD_LENGTH || STOPWORDS.has(token) || seen.has(token)) {
            continue;
        }
        seen.add(token);
        keywords.push(token);
        if (keywords.length >= MAX_KEYWORDS) {
            break;
        }
    }
    return keywords;
}

/** Campos inferidos de una regla (sin id/createdAt/hits). */
export function inferFeedbackRule(input: FeedbackDiscardInput): Pick<TriageFeedbackRule, 'reason' | 'senderEmail' | 'senderDomain' | 'subjectPattern'> {
    const email = (input.author.email ?? '').trim().toLowerCase();
    const domain = email.split('@')[1] ?? '';
    const keywords = extractKeywords(input.originalSubject, input.reason);
    const subjectPattern = keywords.join(' ');
    return {
        reason: input.reason.trim(),
        ...(email ? { senderEmail: email } : {}),
        ...(domain ? { senderDomain: domain } : {}),
        ...(subjectPattern ? { subjectPattern: subjectPattern.slice(0, TRIAGE_FEEDBACK_RULE_SUBJECT_MAX) } : {})
    };
}

/** ¿El candidato cumple la regla? Remitente (email/dominio) y patrón de asunto se combinan con AND. */
export function matchesFeedbackRule(rule: TriageFeedbackRule, input: FeedbackMatchInput): boolean {
    const email = (input.author.email ?? '').trim().toLowerCase();
    const domain = email.split('@')[1] ?? '';
    if (rule.senderEmail && email !== rule.senderEmail) {
        return false;
    }
    if (rule.senderDomain && domain !== rule.senderDomain) {
        return false;
    }
    if (rule.subjectPattern) {
        const subject = normalizeText(input.originalSubject ?? '');
        const tokens = rule.subjectPattern.split(' ').filter(Boolean);
        if (tokens.length > 0 && !tokens.every(token => subject.includes(token))) {
            return false;
        }
    }
    return true;
}

type RuleKey = Pick<TriageFeedbackRule, 'senderEmail' | 'senderDomain' | 'subjectPattern'>;

function sameRule(a: RuleKey, b: RuleKey): boolean {
    return (a.senderEmail ?? '') === (b.senderEmail ?? '')
        && (a.senderDomain ?? '') === (b.senderDomain ?? '')
        && (a.subjectPattern ?? '') === (b.subjectPattern ?? '');
}

function newRuleId(): string {
    const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return id.slice(0, TRIAGE_FEEDBACK_RULE_ID_MAX);
}

interface FeedbackFile {
    version: 1;
    rules: TriageFeedbackRule[];
}

function emptyFile(): FeedbackFile {
    return { version: 1, rules: [] };
}

function isRule(value: unknown): value is TriageFeedbackRule {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const rule = value as Partial<TriageFeedbackRule>;
    return typeof rule.id === 'string' && !!rule.id
        && typeof rule.reason === 'string'
        && typeof rule.hits === 'number' && Number.isFinite(rule.hits)
        && (rule.senderEmail === undefined || typeof rule.senderEmail === 'string')
        && (rule.senderDomain === undefined || typeof rule.senderDomain === 'string')
        && (rule.subjectPattern === undefined || typeof rule.subjectPattern === 'string');
}

/**
 * Gestor de reglas aprendidas de la Bandeja (#28). Persiste en ~/.fokkus/triage-feedback.json
 * (atómico, 0600). Carga perezosa en memoria y cola de escritura serializada, igual que TriageStore.
 */
@injectable()
export class TriageFeedbackStore {
    private data: FeedbackFile | undefined;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(@inject(ILogger) protected readonly logger: ILogger) { }

    private async load(): Promise<FeedbackFile> {
        if (this.data) {
            return this.data;
        }
        const target = triageFeedbackPath();
        let raw: string;
        try {
            raw = await fs.readFile(target, 'utf8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.logger.error(`No se pudo leer las reglas de la Bandeja (${err instanceof Error ? err.name : 'Error'})`);
            }
            this.data = emptyFile();
            return this.data;
        }
        try {
            const parsed: unknown = JSON.parse(raw);
            const root = parsed && typeof parsed === 'object' ? parsed as Partial<FeedbackFile> : {};
            this.data = { version: 1, rules: Array.isArray(root.rules) ? root.rules.filter(isRule) : [] };
        } catch {
            const backup = `${target}.corrupt-${Date.now()}`;
            this.logger.error('triage-feedback.json está dañado: se aparta y las reglas empiezan vacías');
            await fs.rename(target, backup).catch(() => undefined);
            this.data = emptyFile();
        }
        return this.data;
    }

    private mutate<T>(fn: (data: FeedbackFile) => T): Promise<T> {
        const next = this.queue.then(async () => {
            const data = await this.load();
            const result = fn(data);
            await writeJsonAtomic(triageFeedbackPath(), data);
            return result;
        });
        this.queue = next.catch(() => undefined);
        return next;
    }

    private read<T>(fn: (data: FeedbackFile) => T): Promise<T> {
        const next = this.queue.then(async () => fn(await this.load()));
        this.queue = next.catch(() => undefined);
        return next;
    }

    list(): Promise<TriageFeedbackRule[]> {
        return this.read(data => data.rules
            .map(rule => ({ ...rule }))
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
    }

    /** Primera regla que coincide con el candidato (o undefined). No muta. */
    match(input: FeedbackMatchInput): Promise<TriageFeedbackRule | undefined> {
        return this.read(data => {
            const found = data.rules.find(rule => matchesFeedbackRule(rule, input));
            return found ? { ...found } : undefined;
        });
    }

    /** Infiere y registra (o deduplica) la regla de un descarte con motivo. Sin señal suficiente, no hace nada. */
    recordDiscard(input: FeedbackDiscardInput): Promise<void> {
        return this.mutate(data => {
            const inferred = inferFeedbackRule(input);
            if (!inferred.senderEmail && !inferred.senderDomain && !inferred.subjectPattern) {
                return;
            }
            const existing = data.rules.find(rule => sameRule(rule, inferred));
            if (existing) {
                existing.reason = inferred.reason;
                return;
            }
            data.rules.push({
                id: newRuleId(),
                createdAt: new Date().toISOString(),
                hits: 0,
                ...inferred
            });
        });
    }

    incrementHits(ruleId: string): Promise<void> {
        return this.mutate(data => {
            const rule = data.rules.find(r => r.id === ruleId);
            if (rule) {
                rule.hits += 1;
            }
        });
    }

    delete(ruleId: string): Promise<void> {
        return this.mutate(data => {
            data.rules = data.rules.filter(rule => rule.id !== ruleId);
        });
    }
}
