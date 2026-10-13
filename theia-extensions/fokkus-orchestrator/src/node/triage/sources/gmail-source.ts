/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { TRIAGE_DESCRIPTION_MAX_LENGTH, TriageSourcePollResult } from '../../../common/triage-protocol';
import { isInternal } from '../triage-classifier';
import { TriageConfigService } from '../triage-config';
import { arr, prop, str, triageFetch, triageJson, TriageHttpError } from '../triage-http';
import { TriageCandidate, TriageStore } from '../triage-store';
import { SourcePollOutput } from './slack-source';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const FIRST_POLL_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const OVERLAP_MS = 5 * 60 * 1000;
const MAX_LIST_PAGES = 4;
const LABEL_CACHE_TTL_MS = 60 * 60 * 1000;
const SUBJECT_MAX = 255;
/** Dominios de correo público: no sirven como «dominio interno» por defecto. */
const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com']);

interface GmailHeaderMap {
    get(name: string): string | undefined;
    has(name: string): boolean;
}

interface ParsedMessage {
    from: { name: string; email: string };
    subject: string;
    internalDate: number;
    labelIds: string[];
    text: string;
    automatic: boolean;
}

function headerMap(payload: unknown): GmailHeaderMap {
    const map = new Map<string, string>();
    for (const header of arr(prop(payload, 'headers'))) {
        const name = str(prop(header, 'name'));
        const value = str(prop(header, 'value'));
        if (name && value !== undefined && !map.has(name.toLowerCase())) {
            map.set(name.toLowerCase(), value);
        }
    }
    return { get: name => map.get(name.toLowerCase()), has: name => map.has(name.toLowerCase()) };
}

export function parseAddress(raw: string): { name: string; email: string } {
    const angle = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
    if (angle) {
        const address = angle[2].trim().toLowerCase();
        return { name: angle[1].trim() || address, email: address };
    }
    const email = raw.trim().toLowerCase();
    return { name: email, email };
}

/** Correo automático: boletines, auto-respuestas, listas y remitentes no-reply. */
export function isAutomatic(headers: GmailHeaderMap, fromEmail: string): boolean {
    if (headers.has('List-Unsubscribe') || headers.has('List-Id')) {
        return true;
    }
    const autoSubmitted = (headers.get('Auto-Submitted') ?? '').trim().toLowerCase();
    if (autoSubmitted && autoSubmitted !== 'no') {
        return true;
    }
    if (/^(bulk|list|junk)$/i.test((headers.get('Precedence') ?? '').trim())) {
        return true;
    }
    return /(^|[^a-z])(no-?reply|do-?not-?reply|mailer-daemon|postmaster)([^a-z]|$)/i.test(fromEmail.split('@')[0] ?? '');
}

function decodeBase64Url(data: string): string {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', '#39': '\'' };

/** HTML → texto plano, sin dependencias. */
export function htmlToText(html: string): string {
    return html
        .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<[^>]+>/g, '')
        .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
        .replace(/&([a-z]+|#39);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Quita el historial citado (`On … wrote:` / `El … escribió:` y líneas `>`) y la firma (`-- `). */
export function stripQuotesAndSignature(text: string): string {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // La cabecera de la cita puede venir partida en dos líneas.
        const quoteHeader = /(wrote|escribió):\s*$/i;
        if (/^\s*(On|El)\s/i.test(line) && (quoteHeader.test(line) || quoteHeader.test(lines[i + 1] ?? ''))) {
            break;
        }
        if (/^-- ?$/.test(line)) {
            break;
        }
        if (/^\s*>/.test(line)) {
            continue;
        }
        kept.push(line);
    }
    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Prefiere text/plain; si solo hay HTML, lo convierte. */
export function extractText(payload: unknown): string {
    const plain: string[] = [];
    const html: string[] = [];
    const walk = (part: unknown, depth: number) => {
        if (depth > 10) {
            return;
        }
        const mime = (str(prop(part, 'mimeType')) ?? '').toLowerCase();
        const data = str(prop(prop(part, 'body'), 'data'));
        const filename = str(prop(part, 'filename'));
        if (data && !filename) {
            if (mime === 'text/plain') {
                plain.push(decodeBase64Url(data));
            } else if (mime === 'text/html') {
                html.push(decodeBase64Url(data));
            }
        }
        for (const child of arr(prop(part, 'parts'))) {
            walk(child, depth + 1);
        }
    };
    walk(payload, 0);
    const raw = plain.length ? plain.join('\n') : htmlToText(html.join('\n'));
    return stripQuotesAndSignature(raw);
}

export function parseMessage(raw: unknown): ParsedMessage {
    const payload = prop(raw, 'payload');
    const headers = headerMap(payload);
    const from = parseAddress(headers.get('From') ?? '');
    const internalDate = Number(str(prop(raw, 'internalDate')) ?? '0');
    return {
        from,
        subject: (headers.get('Subject') ?? '').trim(),
        internalDate: Number.isFinite(internalDate) ? internalDate : 0,
        labelIds: arr(prop(raw, 'labelIds')).filter((l): l is string => typeof l === 'string'),
        text: extractText(payload),
        automatic: isAutomatic(headers, from.email)
    };
}

/**
 * Fuente Gmail de SOLO LECTURA (#26 HU-3): access token por refresh token (cacheado), hilos de la
 * búsqueda configurada, filtro de correos automáticos y un ítem por hilo (`gmail:<threadId>`).
 */
export class GmailSource {
    private accessToken: { value: string; expires: number; key: string } | undefined;
    private profileEmail: string | undefined;
    private labels: { names: Map<string, string>; expires: number } | undefined;

    constructor(
        protected readonly config: TriageConfigService,
        protected readonly store: TriageStore,
        protected readonly now: () => number = Date.now
    ) { }

    /** Olvida tokens e identidad cacheados (tras cambiar la config). */
    reset(): void {
        this.accessToken = undefined;
        this.profileEmail = undefined;
        this.labels = undefined;
    }

    /** users/me/profile (lo usa testConnection). */
    async profile(): Promise<string> {
        const data = await this.api('profile', {});
        const email = str(prop(data, 'emailAddress')) ?? '';
        this.profileEmail = email.toLowerCase();
        return email;
    }

    /**
     * Responde al hilo (#29). Intenta `send` y, si no hay permiso de escritura, deja un `draft`;
     * si tampoco puede, devuelve `clipboard` con el texto para copiar, sin lanzar.
     */
    async sendReply(
        threadId: string, to: string, subject: string, body: string
    ): Promise<{ ok: boolean; mode: 'sent' | 'draft' | 'clipboard'; notice?: string }> {
        const account = (this.profileEmail ?? (await this.profile())).toLowerCase();
        const raw = this.composeRaw(account, to, subject, body);
        try {
            await this.post('messages/send', { raw, threadId });
            return { ok: true, mode: 'sent' };
        } catch (sendErr) {
            const reason = sendErr instanceof TriageHttpError && sendErr.status === 403
                ? 'Gmail no autoriza el envío (falta el scope gmail.send o gmail.modify)'
                : sendErr instanceof Error ? sendErr.message : 'No se pudo enviar la respuesta';
            try {
                await this.post('drafts', { message: { raw, threadId } });
                return { ok: true, mode: 'draft', notice: `No se pudo enviar (${reason}); se dejó un borrador en Gmail.` };
            } catch {
                return {
                    ok: false,
                    mode: 'clipboard',
                    notice: `Gmail no permitió enviar ni guardar un borrador (${reason}). Copia la respuesta y envíala manualmente.`
                };
            }
        }
    }

    async poll(): Promise<SourcePollOutput> {
        const result: TriageSourcePollResult = { source: 'gmail', ok: true, fetched: 0, created: 0, updated: 0, ignored: 0 };
        const output: SourcePollOutput = { result, created: [], updated: [] };
        const startedAt = new Date(this.now()).toISOString();
        const file = await this.config.read();

        const account = this.profileEmail ?? (await this.profile()).toLowerCase();
        if (account) {
            await this.config.rememberIdentity('gmail', account);
        }
        const accountDomain = account.split('@')[1] ?? '';
        const internalDomains = file.internalDomains ?? (accountDomain && !PUBLIC_DOMAINS.has(accountDomain) ? [accountDomain] : []);

        const lastPollAt = await this.store.getGmailLastPollAt();
        const sinceMs = lastPollAt ? Date.parse(lastPollAt) - OVERLAP_MS : this.now() - FIRST_POLL_WINDOW_MS;
        const query = `${file.gmail.query} after:${Math.floor(sinceMs / 1000)}`;

        const threadIds: string[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < MAX_LIST_PAGES; page++) {
            const params: Record<string, string> = { q: query, maxResults: '50' };
            if (pageToken) {
                params.pageToken = pageToken;
            }
            const data = await this.api('threads', params);
            for (const thread of arr(prop(data, 'threads'))) {
                const id = str(prop(thread, 'id'));
                if (id && /^[A-Za-z0-9]+$/.test(id) && !threadIds.includes(id)) {
                    threadIds.push(id);
                }
            }
            pageToken = str(prop(data, 'nextPageToken'));
            if (!pageToken) {
                break;
            }
        }

        for (const threadId of threadIds) {
            const data = await this.api(`threads/${threadId}`, { format: 'full' });
            const messages = arr(prop(data, 'messages')).map(parseMessage).sort((a, b) => a.internalDate - b.internalDate);
            result.fetched++;
            const candidate = await this.toCandidate(threadId, messages, account, internalDomains);
            if (!candidate) {
                result.ignored++;
                continue;
            }
            const { outcome, item } = await this.store.upsertFromSource(candidate);
            if (outcome === 'created') {
                result.created++;
                output.created.push(item);
            } else if (outcome === 'updated') {
                result.updated++;
                output.updated.push(item);
            } else {
                result.ignored++;
            }
        }

        await this.store.setGmailLastPollAt(startedAt);
        return output;
    }

    private async toCandidate(threadId: string, messages: ParsedMessage[], account: string, internalDomains: string[]): Promise<TriageCandidate | undefined> {
        const human = messages.filter(m => !m.automatic && m.from.email);
        if (human.length === 0) {
            return undefined;
        }
        if (human.length === 1 && human[0].from.email === account) {
            return undefined;
        }
        const withText = human.filter(m => m.text.trim());
        if (withText.length === 0) {
            return undefined;
        }
        const first = human[0];
        const last = human[human.length - 1];
        const text = withText.length === 1
            ? withText[0].text
            : withText.map(m => `${m.from.name} <${m.from.email}>:\n${m.text}`).join('\n\n');
        const subject = (messages.find(m => m.subject)?.subject ?? '').slice(0, SUBJECT_MAX);
        return {
            id: `gmail:${threadId}`,
            source: 'gmail',
            channel: `Gmail · ${await this.labelName(first.labelIds)}`,
            author: { name: first.from.name, email: first.from.email },
            authorIsInternal: isInternal(first.from.email, internalDomains),
            receivedAt: new Date(first.internalDate || this.now()).toISOString(),
            lastActivityAt: new Date(last.internalDate || this.now()).toISOString(),
            messageCount: human.length,
            permalink: `https://mail.google.com/mail/u/0/#all/${threadId}`,
            originalSubject: subject,
            originalText: text.slice(0, TRIAGE_DESCRIPTION_MAX_LENGTH)
        };
    }

    /** Primera etiqueta de usuario del mensaje o INBOX. */
    private async labelName(labelIds: string[]): Promise<string> {
        const userLabel = labelIds.find(id => id.startsWith('Label_'));
        if (!userLabel) {
            return 'INBOX';
        }
        if (!this.labels || this.labels.expires < this.now()) {
            const names = new Map<string, string>();
            try {
                const data = await this.api('labels', {});
                for (const label of arr(prop(data, 'labels'))) {
                    const id = str(prop(label, 'id'));
                    const name = str(prop(label, 'name'));
                    if (id && name) {
                        names.set(id, name);
                    }
                }
            } catch {
                // Sin la lista de etiquetas se usa INBOX.
            }
            this.labels = { names, expires: this.now() + LABEL_CACHE_TTL_MS };
        }
        return this.labels.names.get(userLabel) ?? 'INBOX';
    }

    private async api(path: string, params: Record<string, string>): Promise<unknown> {
        const query = new URLSearchParams(params).toString();
        const url = `${GMAIL_API}${path}${query ? `?${query}` : ''}`;
        try {
            return await triageJson({ method: 'GET', url, headers: { Authorization: `Bearer ${await this.token()}`, Accept: 'application/json' } }, 'Gmail');
        } catch (err) {
            if (err instanceof TriageHttpError && err.status === 401) {
                this.accessToken = undefined;
                throw new Error('Gmail rechazó el access token (HTTP 401)');
            }
            if (err instanceof TriageHttpError && err.status === 403) {
                throw new Error('Gmail denegó el acceso (HTTP 403): revisa que el token tenga el scope gmail.readonly');
            }
            throw err;
        }
    }

    private async post(path: string, body: unknown): Promise<unknown> {
        const url = `${GMAIL_API}${path}`;
        try {
            return await triageJson({
                method: 'POST',
                url,
                headers: { Authorization: `Bearer ${await this.token()}`, Accept: 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }, 'Gmail');
        } catch (err) {
            if (err instanceof TriageHttpError && err.status === 401) {
                this.accessToken = undefined;
                throw new Error('Gmail rechazó el access token (HTTP 401)');
            }
            throw err;
        }
    }

    /** Arma el mensaje RFC 2822 y lo codifica en base64url para `raw`. */
    private composeRaw(from: string, to: string, subject: string, body: string): string {
        const headers = [
            `From: ${from}`,
            `To: ${to}`,
            `Subject: ${this.encodeHeader(subject)}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: 8bit'
        ];
        const raw = `${headers.join('\r\n')}\r\n\r\n${body}`;
        return Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    /** Encoded-word para cabeceras con caracteres no ASCII (asuntos con tildes). */
    private encodeHeader(value: string): string {
        return /[^\x00-\x7F]/.test(value) ? `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=` : value;
    }

    private async token(): Promise<string> {
        const file = await this.config.read();
        const clientId = file.gmail.clientId;
        const clientSecret = (await this.config.resolveGmailClientSecret()).value;
        const refreshToken = (await this.config.resolveGmailRefreshToken()).value;
        if (!clientId || !clientSecret || !refreshToken) {
            throw new Error('Faltan credenciales de Gmail');
        }
        const key = `${clientId}\n${clientSecret}\n${refreshToken}`;
        if (this.accessToken && this.accessToken.key === key && this.accessToken.expires > this.now()) {
            return this.accessToken.value;
        }
        if (this.accessToken?.key !== key) {
            this.profileEmail = undefined;
        }
        const response = await triageFetch({
            method: 'POST',
            url: TOKEN_URL,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString()
        });
        let data: unknown;
        try {
            data = await response.json();
        } catch {
            data = {};
        }
        const error = str(prop(data, 'error'));
        if (error === 'invalid_grant') {
            throw new Error('El refresh token de Gmail expiró o fue revocado');
        }
        if (error === 'invalid_client' || error === 'unauthorized_client') {
            throw new Error('El client id o el client secret de Gmail no son válidos');
        }
        const accessToken = str(prop(data, 'access_token'));
        if (response.status < 200 || response.status >= 300 || !accessToken) {
            throw new Error(`Google no entregó un access token (HTTP ${response.status})`);
        }
        const expiresIn = prop(data, 'expires_in');
        const seconds = typeof expiresIn === 'number' ? expiresIn : 3600;
        this.accessToken = { value: accessToken, key, expires: this.now() + Math.max(0, seconds - 60) * 1000 };
        return accessToken;
    }
}
