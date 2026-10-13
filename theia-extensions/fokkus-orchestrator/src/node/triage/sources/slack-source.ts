/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { TRIAGE_DESCRIPTION_MAX_LENGTH, TriageItem, TriageSourcePollResult } from '../../../common/triage-protocol';
import { TriageConfigService } from '../triage-config';
import { arr, prop, str, triageJson, TriageHttpError } from '../triage-http';
import { TriageCandidate, TriageStore } from '../triage-store';

const SLACK_API = 'https://slack.com/api/';
const FIRST_POLL_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_PAGES = 10;
const MAX_REPLY_PAGES = 5;
const USER_CACHE_TTL_MS = 60 * 60 * 1000;
const MIN_USEFUL_CHARS = 15;
const SUBJECT_MAX = 120;

export interface SourcePollOutput {
    result: TriageSourcePollResult;
    created: TriageItem[];
    updated: TriageItem[];
}

interface SlackUser {
    name: string;
    email?: string;
    external: boolean;
    expires: number;
}

interface SlackMessage {
    ts: string;
    user?: string;
    text: string;
    subtype?: string;
    botId?: string;
    threadTs?: string;
    replyCount: number;
    latestReply?: string;
}

/** Error de canal que corta solo ese canal (el sondeo sigue con los demás). */
class ChannelError extends Error { }

function slackErrorMessage(code: string, channelId?: string): string {
    switch (code) {
        case 'invalid_auth':
        case 'not_authed':
        case 'token_revoked':
        case 'account_inactive':
            return 'Token de Slack inválido';
        case 'not_in_channel':
            return `El bot no está en el canal ${channelId ?? ''}`.trim();
        case 'channel_not_found':
            return `No se encontró el canal ${channelId ?? ''}`.trim();
        case 'missing_scope':
            return 'Falta un scope de lectura en la app de Slack';
        case 'ratelimited':
            return 'Slack limitó las peticiones';
        default:
            return `Slack respondió un error (${code.replace(/[^a-z_]/gi, '').slice(0, 40)})`;
    }
}

function toMessage(raw: unknown): SlackMessage | undefined {
    const ts = str(prop(raw, 'ts'));
    if (!ts) {
        return undefined;
    }
    const replyCount = prop(raw, 'reply_count');
    return {
        ts,
        user: str(prop(raw, 'user')),
        text: str(prop(raw, 'text')) ?? '',
        subtype: str(prop(raw, 'subtype')),
        botId: str(prop(raw, 'bot_id')),
        threadTs: str(prop(raw, 'thread_ts')),
        replyCount: typeof replyCount === 'number' ? replyCount : 0,
        latestReply: str(prop(raw, 'latest_reply'))
    };
}

export function tsToIso(ts: string): string {
    const ms = Math.round(Number(ts) * 1000);
    return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

function tsGreater(a: string, b: string | undefined): boolean {
    return b === undefined || Number(a) > Number(b);
}

/** Convierte el mrkdwn de Slack a texto plano. `names` resuelve `<@U…>`. */
export function slackToPlainText(text: string, names: (userId: string) => string | undefined): string {
    return text
        .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id: string, label?: string) => `@${label ?? names(id) ?? id}`)
        .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, (_m, name: string) => `#${name}`)
        .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
        .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_m, label?: string) => label ?? '@grupo')
        .replace(/<((?:https?|mailto):[^>|]+)\|([^>]+)>/g, '$2')
        .replace(/<((?:https?|mailto):[^>]+)>/g, '$1')
        .replace(/```/g, '')
        .replace(/(^|[\s(])[*_~]+([^*_~\n]+?)[*_~]+(?=$|[\s).,;:!?])/gm, '$1$2')
        .replace(/`([^`\n]+)`/g, '$1')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .trim();
}

/** Texto útil: sin menciones, enlaces, emojis ni espacios. */
export function usefulLength(plain: string): number {
    return plain
        .replace(/https?:\/\/\S+/g, '')
        .replace(/[@#][\w.-]+/g, '')
        .replace(/:[a-z0-9_+-]+:/gi, '')
        .replace(/\s+/g, '')
        .length;
}

/**
 * Fuente Slack de SOLO LECTURA (#26 HU-2). Lee cada canal desde su cursor, agrupa por hilo
 * (`slack:<canal>:<thread_ts>`), ignora el ruido y respeta los 429 sin perder el cursor.
 *
 * Respuestas nuevas en hilos viejos: se detectan por el `latest_reply` del padre mientras el padre
 * esté dentro de la ventana de 2 días que se relee en cada pasada. Limitación conocida: si el padre
 * tiene más de 2 días, la respuesta solo se detecta si además se publica en el canal (`thread_broadcast`).
 */
export class SlackSource {
    private readonly users = new Map<string, SlackUser>();
    private readonly channelNames = new Map<string, string>();
    private identity: { tokenKey: string; userId?: string; teamId?: string; team?: string } | undefined;

    constructor(
        protected readonly config: TriageConfigService,
        protected readonly store: TriageStore,
        protected readonly now: () => number = Date.now
    ) { }

    /** Olvida identidad y cachés (tras cambiar la config). */
    reset(): void {
        this.identity = undefined;
        this.users.clear();
        this.channelNames.clear();
    }

    /** auth.test (lo usa también testConnection). Lanza con mensaje legible si falla. */
    async authTest(token: string): Promise<{ team: string; userId?: string; teamId?: string }> {
        const data = await this.call(token, 'auth.test', {});
        const team = str(prop(data, 'team')) ?? '';
        const result = { team, userId: str(prop(data, 'user_id')), teamId: str(prop(data, 'team_id')) };
        this.identity = { tokenKey: token, ...result };
        return result;
    }

    /**
     * Responde en el hilo (#29) vía `chat.postMessage` con `thread_ts`, aprovechando la autenticación
     * existente (token xoxb/xoxp/xoxc y cookie d de sesión web).
     */
    async replyThread(channelId: string, threadTs: string, text: string): Promise<void> {
        const token = (await this.config.resolveSlackToken()).value;
        if (!token) {
            throw new Error('No hay token de Slack configurado');
        }
        const cookieD = (await this.config.resolveSlackCookieD()).value;
        const headers: Record<string, string> = {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json'
        };
        if (cookieD) {
            headers.Cookie = `d=${cookieD}`;
        }
        const data = await triageJson({
            method: 'POST',
            url: `${SLACK_API}chat.postMessage`,
            headers,
            body: JSON.stringify({ channel: channelId, thread_ts: threadTs, text })
        }, 'Slack');
        if (prop(data, 'ok') !== true) {
            const code = str(prop(data, 'error')) ?? 'unknown_error';
            throw new Error(slackErrorMessage(code, channelId));
        }
    }

    async poll(): Promise<SourcePollOutput> {
        const result: TriageSourcePollResult = { source: 'slack', ok: true, fetched: 0, created: 0, updated: 0, ignored: 0 };
        const output: SourcePollOutput = { result, created: [], updated: [] };
        const token = (await this.config.resolveSlackToken()).value;
        const file = await this.config.read();
        if (!token) {
            throw new Error('No hay token de Slack configurado');
        }
        if (!this.identity || this.identity.tokenKey !== token) {
            this.users.clear();
            const identity = await this.authTest(token);
            if (identity.team) {
                await this.config.rememberIdentity('slack', identity.team);
            }
        }

        const errors: string[] = [];
        for (const channelId of file.slack.channelIds) {
            try {
                await this.pollChannel(token, channelId, output);
            } catch (err) {
                errors.push(err instanceof Error ? err.message : 'Error desconocido en Slack');
                // Token inválido: no tiene sentido seguir con los demás canales.
                if (err instanceof Error && err.message === 'Token de Slack inválido') {
                    this.identity = undefined;
                    break;
                }
            }
        }
        if (errors.length) {
            result.ok = false;
            result.error = errors.join(' · ');
        }
        return output;
    }

    private async pollChannel(token: string, channelId: string, output: SourcePollOutput): Promise<void> {
        const cursor = await this.store.getSlackCursor(channelId);
        // Siempre se relee al menos la ventana de 2 días: así los padres traen `latest_reply` y se detectan
        // respuestas nuevas en hilos cuyo mensaje padre es anterior al cursor.
        const windowStart = ((this.now() - FIRST_POLL_WINDOW_MS) / 1000).toFixed(6);
        const oldest = cursor && Number(cursor) < Number(windowStart) ? cursor : windowStart;
        const channelName = await this.channelName(token, channelId);

        const messages: SlackMessage[] = [];
        let pageCursor: string | undefined;
        for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
            const params: Record<string, string> = { channel: channelId, oldest, limit: '200' };
            if (pageCursor) {
                params.cursor = pageCursor;
            }
            const data = await this.callChannel(token, 'conversations.history', params, channelId, channelName);
            messages.push(...arr(prop(data, 'messages')).map(toMessage).filter((m): m is SlackMessage => !!m));
            pageCursor = str(prop(prop(data, 'response_metadata'), 'next_cursor')) || undefined;
            if (!pageCursor) {
                break;
            }
        }

        // El cursor es la actividad más reciente vista (mensaje o última respuesta de un hilo).
        let maxTs = cursor;
        const threads = new Set<string>();
        const singles: SlackMessage[] = [];
        for (const message of messages.sort((a, b) => Number(a.ts) - Number(b.ts))) {
            const activity = message.latestReply && tsGreater(message.latestReply, message.ts) ? message.latestReply : message.ts;
            if (!tsGreater(activity, cursor)) {
                continue;
            }
            output.result.fetched++;
            if (tsGreater(activity, maxTs)) {
                maxTs = activity;
            }
            const root = message.replyCount > 0 ? message.ts : message.threadTs && message.threadTs !== message.ts ? message.threadTs : undefined;
            if (root) {
                threads.add(root);
            } else {
                singles.push(message);
            }
        }

        const permalinkFor = async (ts: string) => this.permalink(token, channelId, ts);
        for (const message of singles) {
            await this.handleGroup(token, channelId, channelName, message.ts, [message], output, permalinkFor);
        }
        for (const root of threads) {
            const thread = await this.replies(token, channelId, channelName, root);
            await this.handleGroup(token, channelId, channelName, root, thread, output, permalinkFor);
        }

        if (maxTs && maxTs !== cursor) {
            await this.store.setSlackCursor(channelId, maxTs);
        }
    }

    private async handleGroup(
        token: string, channelId: string, channelName: string, rootTs: string, group: SlackMessage[],
        output: SourcePollOutput, permalinkFor: (ts: string) => Promise<string | undefined>
    ): Promise<void> {
        const selfId = this.identity?.userId;
        const useful: { message: SlackMessage; plain: string; author: SlackUser }[] = [];
        for (const message of group) {
            const userId = message.user;
            const noise = (message.subtype && message.subtype !== 'thread_broadcast') || !!message.botId || userId === selfId;
            if (!userId || noise) {
                continue;
            }
            const author = await this.user(token, userId);
            const plain = slackToPlainText(message.text, id => this.users.get(id)?.name);
            if (!plain) {
                continue;
            }
            useful.push({ message, plain, author });
        }
        const totalUseful = useful.reduce((sum, u) => sum + usefulLength(u.plain), 0);
        if (useful.length === 0 || totalUseful < MIN_USEFUL_CHARS) {
            output.result.ignored++;
            return;
        }

        const first = useful[0];
        const last = useful[useful.length - 1];
        const text = useful.length === 1
            ? first.plain
            : useful.map(u => `${u.author.name}:\n${u.plain}`).join('\n\n');
        const existing = await this.store.get(`slack:${channelId}:${rootTs}`);
        const candidate: TriageCandidate = {
            id: `slack:${channelId}:${rootTs}`,
            source: 'slack',
            channel: channelName,
            author: {
                name: first.author.name,
                ...(first.author.email ? { email: first.author.email } : {}),
                slackUserId: first.message.user
            },
            authorIsInternal: !first.author.external,
            receivedAt: tsToIso(first.message.ts),
            lastActivityAt: tsToIso(last.message.ts),
            messageCount: useful.length,
            permalink: existing?.permalink ?? await permalinkFor(rootTs),
            originalSubject: (first.plain.split('\n').map(l => l.trim()).find(Boolean) ?? '').slice(0, SUBJECT_MAX),
            originalText: text.slice(0, TRIAGE_DESCRIPTION_MAX_LENGTH)
        };
        const { outcome, item } = await this.store.upsertFromSource(candidate);
        if (outcome === 'created') {
            output.result.created++;
            output.created.push(item);
        } else if (outcome === 'updated') {
            output.result.updated++;
            output.updated.push(item);
        } else {
            output.result.ignored++;
        }
    }

    private async replies(token: string, channelId: string, channelName: string, rootTs: string): Promise<SlackMessage[]> {
        const all: SlackMessage[] = [];
        let pageCursor: string | undefined;
        for (let page = 0; page < MAX_REPLY_PAGES; page++) {
            const params: Record<string, string> = { channel: channelId, ts: rootTs, limit: '200' };
            if (pageCursor) {
                params.cursor = pageCursor;
            }
            const data = await this.callChannel(token, 'conversations.replies', params, channelId, channelName);
            all.push(...arr(prop(data, 'messages')).map(toMessage).filter((m): m is SlackMessage => !!m));
            pageCursor = str(prop(prop(data, 'response_metadata'), 'next_cursor')) || undefined;
            if (!pageCursor) {
                break;
            }
        }
        const seen = new Set<string>();
        return all.filter(m => !seen.has(m.ts) && !!seen.add(m.ts)).sort((a, b) => Number(a.ts) - Number(b.ts));
    }

    private async user(token: string, userId: string): Promise<SlackUser> {
        const cached = this.users.get(userId);
        if (cached && cached.expires > this.now()) {
            return cached;
        }
        let user: SlackUser = { name: userId, external: false, expires: this.now() + USER_CACHE_TTL_MS };
        try {
            const data = await this.call(token, 'users.info', { user: userId });
            const raw = prop(data, 'user');
            const profile = prop(raw, 'profile');
            const name = str(prop(profile, 'display_name')) || str(prop(profile, 'real_name')) || str(prop(raw, 'real_name')) || str(prop(raw, 'name')) || userId;
            const teamId = str(prop(raw, 'team_id'));
            const ownTeam = this.identity?.teamId;
            user = {
                name,
                email: str(prop(profile, 'email')),
                external: prop(raw, 'is_stranger') === true || (!!teamId && !!ownTeam && teamId !== ownTeam),
                expires: this.now() + USER_CACHE_TTL_MS
            };
        } catch (err) {
            if (err instanceof TriageHttpError && err.status === 429) {
                throw new ChannelError('Slack limitó las peticiones');
            }
            // Sin users:read el autor se muestra con su id.
        }
        this.users.set(userId, user);
        return user;
    }

    private async channelName(token: string, channelId: string): Promise<string> {
        const cached = this.channelNames.get(channelId);
        if (cached) {
            return cached;
        }
        let name = channelId;
        try {
            const data = await this.call(token, 'conversations.info', { channel: channelId });
            const raw = str(prop(prop(data, 'channel'), 'name'));
            if (raw) {
                name = `#${raw}`;
                this.channelNames.set(channelId, name);
            }
        } catch {
            // Sin channels:read se usa el id; la lectura del historial decide si el canal es accesible.
        }
        return name;
    }

    private async permalink(token: string, channelId: string, ts: string): Promise<string | undefined> {
        try {
            const data = await this.call(token, 'chat.getPermalink', { channel: channelId, message_ts: ts });
            const link = str(prop(data, 'permalink'));
            return link && link.startsWith('https://') ? link : undefined;
        } catch {
            return undefined;
        }
    }

    /** Llamada de canal: un 429 o un error corta solo este canal, con un mensaje que nombra el canal. */
    private async callChannel(token: string, method: string, params: Record<string, string>, channelId: string, channelName: string): Promise<unknown> {
        try {
            return await this.call(token, method, params, channelId);
        } catch (err) {
            if (err instanceof TriageHttpError && err.status === 429) {
                const wait = err.retryAfterMs ? ` (espera ${Math.ceil(err.retryAfterMs / 1000)} s)` : '';
                throw new ChannelError(`Slack limitó las peticiones en ${channelName}${wait}; se reintentará en la próxima revisión`);
            }
            throw err;
        }
    }

    private async call(token: string, method: string, params: Record<string, string>, channelId?: string): Promise<unknown> {
        const query = new URLSearchParams(params).toString();
        const cookieD = (await this.config.resolveSlackCookieD()).value;
        const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
        if (cookieD) {
            headers.Cookie = `d=${cookieD}`;
        }
        const data = await triageJson({
            method: 'GET',
            url: `${SLACK_API}${method}${query ? `?${query}` : ''}`,
            headers
        }, 'Slack');
        if (prop(data, 'ok') !== true) {
            const code = str(prop(data, 'error')) ?? 'unknown_error';
            if (code === 'ratelimited') {
                throw new TriageHttpError('Slack limitó las peticiones', 429);
            }
            throw new Error(slackErrorMessage(code, channelId));
        }
        return data;
    }
}
