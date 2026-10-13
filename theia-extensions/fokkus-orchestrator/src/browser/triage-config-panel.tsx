/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from '@theia/core/shared/react';
import {
    TargetProviderId,
    TargetProviderStatus,
    TRIAGE_DEFAULT_GMAIL_QUERY,
    TriageConfigStatus,
    TriageConnectionTestResult,
    TriageSecretSource,
    TriageServer,
    TriageSource
} from '../common/triage-protocol';
import { triageErrorMessage, withTriageTimeout } from './triage-service';

const SECRET_SOURCE_LABELS: Record<TriageSecretSource, string> = {
    'env': 'variable de entorno',
    'secret-storage': 'almacén seguro',
    'none': 'sin configurar'
};

/** Acepta ids separados por comas, espacios o saltos de línea; quita el `#` si se pegó un nombre. */
export function parseChannelIds(raw: string): string[] {
    const ids = raw.split(/[\s,]+/).map(value => value.trim().replace(/^#/, '')).filter(Boolean);
    return Array.from(new Set(ids));
}

type Section = 'slack' | 'gmail' | 'jira';
type Busy = `${Section}-save` | `${Section}-clear` | `${TriageSource | TargetProviderId}-test`;

interface Feedback {
    kind: 'success' | 'error';
    text: string;
}

export interface TriageConfigPanelProps {
    server: TriageServer;
    providers: TargetProviderStatus[];
    /** Se llama tras guardar/borrar para que la bandeja recargue proveedores y estado. */
    onChanged(): void;
    confirm(title: string, message: string): Promise<boolean>;
}

export function TriageConfigPanel({ server, providers, onChanged, confirm }: TriageConfigPanelProps): React.ReactElement {
    const [config, setConfig] = React.useState<TriageConfigStatus>();
    const [loadError, setLoadError] = React.useState<string>();
    const [busy, setBusy] = React.useState<Busy>();
    const [feedback, setFeedback] = React.useState<Partial<Record<Section | TargetProviderId, Feedback>>>({});

    const [slackEnabled, setSlackEnabled] = React.useState(true);
    const [slackToken, setSlackToken] = React.useState('');
    const [slackCookieD, setSlackCookieD] = React.useState('');
    const [slackChannels, setSlackChannels] = React.useState('');

    const [gmailEnabled, setGmailEnabled] = React.useState(true);
    const [gmailUseJson, setGmailUseJson] = React.useState(false);
    const [gmailCredentialsJson, setGmailCredentialsJson] = React.useState('');
    const [gmailClientId, setGmailClientId] = React.useState('');
    const [gmailClientSecret, setGmailClientSecret] = React.useState('');
    const [gmailRefreshToken, setGmailRefreshToken] = React.useState('');
    const [gmailQuery, setGmailQuery] = React.useState('');

    const [jiraBaseUrl, setJiraBaseUrl] = React.useState('');
    const [jiraEmail, setJiraEmail] = React.useState('');
    const [jiraApiToken, setJiraApiToken] = React.useState('');

    /** Sin `section` refresca todo el formulario; con `section` solo esa, para no pisar lo que se edita en las otras. */
    const applyConfig = React.useCallback((next: TriageConfigStatus, section?: Section) => {
        setConfig(next);
        setLoadError(undefined);
        if (!section || section === 'slack') {
            setSlackEnabled(next.slack.enabled);
            setSlackChannels(next.slack.channelIds.join(', '));
        }
        if (!section || section === 'gmail') {
            setGmailEnabled(next.gmail.enabled);
            setGmailClientId(next.gmail.clientId);
            setGmailQuery(next.gmail.query);
        }
        if (!section || section === 'jira') {
            setJiraBaseUrl(next.jira.baseUrl);
            setJiraEmail(next.jira.email);
        }
    }, []);

    const reload = React.useCallback(async () => {
        try {
            applyConfig(await withTriageTimeout(server.getConfig()));
        } catch (error) {
            setLoadError(triageErrorMessage(error));
        }
    }, [server, applyConfig]);

    React.useEffect(() => {
        reload();
    }, [reload]);

    const setSectionFeedback = (key: Section | TargetProviderId, value?: Feedback): void =>
        setFeedback(current => ({ ...current, [key]: value }));

    const run = async (key: Busy, section: Section, action: () => Promise<TriageConfigStatus>, success: string): Promise<void> => {
        setBusy(key);
        setSectionFeedback(section);
        try {
            applyConfig(await withTriageTimeout(action()), section);
            setSectionFeedback(section, { kind: 'success', text: success });
            onChanged();
        } catch (error) {
            setSectionFeedback(section, { kind: 'error', text: triageErrorMessage(error) });
        } finally {
            setBusy(undefined);
        }
    };

    const test = async (target: TriageSource | TargetProviderId, section: Section | TargetProviderId): Promise<void> => {
        setBusy(`${target}-test`);
        setSectionFeedback(section);
        try {
            const result: TriageConnectionTestResult = await withTriageTimeout(server.testConnection(target));
            const text = result.ok && result.identity ? `${result.message} (${result.identity})` : result.message;
            setSectionFeedback(section, { kind: result.ok ? 'success' : 'error', text });
        } catch (error) {
            setSectionFeedback(section, { kind: 'error', text: triageErrorMessage(error) });
        } finally {
            setBusy(undefined);
        }
    };

    const clear = async (section: Section, label: string, action: () => Promise<TriageConfigStatus>): Promise<void> => {
        const accepted = await confirm(`Eliminar configuración de ${label}`,
            `Se borrarán los secretos de ${label} guardados en el almacén seguro. Las variables de entorno no se modifican.`);
        if (accepted) {
            await run(`${section}-clear`, section, action, 'Configuración eliminada.');
        }
    };

    const renderFeedback = (key: Section | TargetProviderId): React.ReactNode => {
        const value = feedback[key];
        return value && (
            <div className={value.kind === 'success' ? 'fokkus-backlog-success' : 'fokkus-backlog-error'} role='status'>{value.text}</div>
        );
    };

    if (loadError) {
        return (
            <div className='fokkus-triage-config'>
                <div className='fokkus-backlog-error' role='alert'>{loadError}</div>
                <button type='button' className='fokkus-backlog-apply' onClick={reload}>Reintentar</button>
            </div>
        );
    }
    if (!config) {
        return <div className='fokkus-backlog-status'>Cargando configuración…</div>;
    }

    const disabled = busy !== undefined;
    const plane = providers.find(item => item.id === 'plane');
    const github = providers.find(item => item.id === 'github');
    // Un token xoxc- recién escrito manda; si no hay, vale el modo con el que está guardado.
    const typedSlackToken = slackToken.trim();
    const slackSession = typedSlackToken ? typedSlackToken.startsWith('xoxc-') : config.slack.authMode === 'session';
    const cookieDSource = config.slack.cookieDSource ?? 'none';

    return (
        <div className='fokkus-triage-config'>
            {config.storage === 'memory' && (
                <div className='fokkus-backlog-error' role='alert'>
                    El almacén de credenciales del sistema no está disponible: los secretos que guardes se perderán al cerrar el IDE.
                </div>
            )}

            {/* Slack */}
            <fieldset className='fokkus-triage-config-card' disabled={disabled}>
                <legend className='fokkus-triage-config-title'><i className='fa fa-slack' /> Slack</legend>
                <label className='fokkus-triage-checkbox'>
                    <input type='checkbox' checked={slackEnabled} onChange={event => setSlackEnabled(event.target.checked)} />
                    Revisar Slack cada 5 minutos
                </label>
                {config.slack.tokenSource !== 'none' && (
                    <div className='fokkus-triage-provider-status'>
                        <span className={config.slack.configured ? 'fokkus-triage-dot fokkus-triage-dot-ok' : 'fokkus-triage-dot'} />
                        <span className='fokkus-triage-provider-status-text'>
                            {config.slack.configured ? 'Conectado' : 'Token guardado, faltan canales'}
                        </span>
                        <span className='fokkus-triage-mode-badge'>{config.slack.authMode === 'session' ? 'Sesión Web' : 'Bot Token'}</span>
                    </div>
                )}
                <label className='fokkus-backlog-field'>
                    <span className='fokkus-backlog-label'>Token (xoxb-/xoxp-/xoxc-) · {SECRET_SOURCE_LABELS[config.slack.tokenSource]}</span>
                    <input
                        className='fokkus-backlog-input'
                        type='password'
                        autoComplete='new-password'
                        value={slackToken}
                        onChange={event => setSlackToken(event.target.value)}
                        placeholder={config.slack.tokenSource !== 'none' ? '•••• guardado (vacío = conservar)' : 'Pega el token de Slack'}
                    />
                </label>
                <label className={slackSession ? 'fokkus-backlog-field fokkus-triage-session-field' : 'fokkus-backlog-field'}>
                    <span className='fokkus-backlog-label'>
                        Cookie d (xoxd-) · {slackSession ? 'requerida para tokens xoxc-' : 'solo para tokens xoxc-'} · {SECRET_SOURCE_LABELS[cookieDSource]}
                    </span>
                    <input
                        className='fokkus-backlog-input'
                        type='password'
                        autoComplete='new-password'
                        value={slackCookieD}
                        onChange={event => setSlackCookieD(event.target.value)}
                        placeholder={cookieDSource !== 'none' ? '•••• guardada (vacío = conservar)' : 'xoxd-…'}
                    />
                    {slackSession && (
                        <span className='fokkus-triage-hint'>
                            Requerido para tokens xoxc-. Cópialo de la cookie <strong>d</strong> de slack.com en las herramientas de
                            desarrollador del navegador (Aplicación › Cookies) con tu sesión de Slack abierta.
                        </span>
                    )}
                </label>
                <label className='fokkus-backlog-field'>
                    <span className='fokkus-backlog-label'>Canales (ids C…/G…, separados por comas)</span>
                    <input
                        className='fokkus-backlog-input'
                        value={slackChannels}
                        onChange={event => setSlackChannels(event.target.value)}
                        placeholder='C01ABCDEF, C02GHIJKL'
                    />
                </label>
                <span className='fokkus-triage-hint'>
                    {slackSession
                        ? 'Sesión web: usa tus permisos de usuario, sin crear una App de Slack. Fokkus nunca escribe en Slack.'
                        : 'Solo lectura: scopes channels:history, groups:history, channels:read, users:read. Fokkus nunca escribe en Slack.'}
                    {config.slack.teamName && <> Workspace: <strong>{config.slack.teamName}</strong>.</>}
                </span>
                <div className='fokkus-triage-actions'>
                    <button
                        type='button'
                        className='fokkus-backlog-apply'
                        onClick={() => run('slack-save', 'slack', () => server.saveSlackConfig({
                            enabled: slackEnabled,
                            token: slackToken.trim() || undefined,
                            cookieD: slackCookieD.trim() || undefined,
                            channelIds: parseChannelIds(slackChannels)
                        }).then(next => { setSlackToken(''); setSlackCookieD(''); return next; }), 'Slack guardado.')}
                    >
                        {busy === 'slack-save' ? 'Guardando…' : 'Guardar'}
                    </button>
                    <button type='button' className='fokkus-backlog-icon-button' disabled={!config.slack.configured} onClick={() => test('slack', 'slack')}>
                        <i className='fa fa-plug' /> {busy === 'slack-test' ? 'Probando…' : 'Probar'}
                    </button>
                    <button type='button' className='fokkus-backlog-icon-button' onClick={() => clear('slack', 'Slack', () => server.clearSlackConfig())}>
                        <i className='fa fa-trash' /> Eliminar
                    </button>
                </div>
                {renderFeedback('slack')}
            </fieldset>

            {/* Gmail */}
            <fieldset className='fokkus-triage-config-card' disabled={disabled}>
                <legend className='fokkus-triage-config-title'><i className='fa fa-envelope' /> Gmail</legend>
                <label className='fokkus-triage-checkbox'>
                    <input type='checkbox' checked={gmailEnabled} onChange={event => setGmailEnabled(event.target.checked)} />
                    Revisar Gmail cada 5 minutos
                </label>
                <label className='fokkus-triage-checkbox'>
                    <input type='checkbox' checked={gmailUseJson} onChange={event => setGmailUseJson(event.target.checked)} />
                    Pegar credenciales JSON (client_secret.json)
                </label>
                {gmailUseJson ? (
                    <label className='fokkus-backlog-field'>
                        <span className='fokkus-backlog-label'>Credenciales JSON</span>
                        <textarea
                            className='fokkus-backlog-input fokkus-triage-textarea fokkus-triage-json'
                            value={gmailCredentialsJson}
                            onChange={event => setGmailCredentialsJson(event.target.value)}
                            autoComplete='off'
                            spellCheck={false}
                            placeholder='{"installed": {"client_id": "…", "client_secret": "…"}}'
                        />
                        <span className='fokkus-triage-hint'>
                            Acepta el client_secret.json de Google Cloud Console (installed o web) o el JSON de un cliente MCP con
                            client_id, client_secret y refresh_token. Si el JSON no trae refresh_token, pégalo abajo.
                        </span>
                    </label>
                ) : (
                    <>
                        <label className='fokkus-backlog-field'>
                            <span className='fokkus-backlog-label'>OAuth Client ID</span>
                            <input
                                className='fokkus-backlog-input'
                                value={gmailClientId}
                                onChange={event => setGmailClientId(event.target.value)}
                                placeholder='xxxxxxxx.apps.googleusercontent.com'
                            />
                        </label>
                        <label className='fokkus-backlog-field'>
                            <span className='fokkus-backlog-label'>Client Secret · {SECRET_SOURCE_LABELS[config.gmail.clientSecretSource]}</span>
                            <input
                                className='fokkus-backlog-input'
                                type='password'
                                autoComplete='new-password'
                                value={gmailClientSecret}
                                onChange={event => setGmailClientSecret(event.target.value)}
                                placeholder={config.gmail.clientSecretSource !== 'none' ? '•••• guardado (vacío = conservar)' : 'Client secret'}
                            />
                        </label>
                    </>
                )}
                <label className='fokkus-backlog-field'>
                    <span className='fokkus-backlog-label'>Refresh Token · {SECRET_SOURCE_LABELS[config.gmail.refreshTokenSource]}</span>
                    <input
                        className='fokkus-backlog-input'
                        type='password'
                        autoComplete='new-password'
                        value={gmailRefreshToken}
                        onChange={event => setGmailRefreshToken(event.target.value)}
                        placeholder={config.gmail.refreshTokenSource !== 'none' ? '•••• guardado (vacío = conservar)' : 'Refresh token (scope gmail.readonly)'}
                    />
                </label>
                <label className='fokkus-backlog-field'>
                    <span className='fokkus-backlog-label'>Búsqueda de Gmail</span>
                    <input
                        className='fokkus-backlog-input'
                        value={gmailQuery}
                        onChange={event => setGmailQuery(event.target.value)}
                        placeholder={TRIAGE_DEFAULT_GMAIL_QUERY}
                    />
                </label>
                <span className='fokkus-triage-hint'>
                    Solo lectura (scope gmail.readonly): no marca correos como leídos ni los mueve.
                    {config.gmail.account && <> Cuenta: <strong>{config.gmail.account}</strong>.</>}
                </span>
                <div className='fokkus-triage-actions'>
                    <button
                        type='button'
                        className='fokkus-backlog-apply'
                        onClick={() => run('gmail-save', 'gmail', () => server.saveGmailConfig(gmailUseJson
                            ? {
                                // Con JSON el client id/secret salen de ahí; con el JSON vacío se conserva el client id guardado.
                                enabled: gmailEnabled,
                                clientId: gmailCredentialsJson.trim() ? '' : gmailClientId.trim(),
                                credentialsJson: gmailCredentialsJson.trim() || undefined,
                                refreshToken: gmailRefreshToken.trim() || undefined,
                                query: gmailQuery.trim() || undefined
                            }
                            : {
                                enabled: gmailEnabled,
                                clientId: gmailClientId.trim(),
                                clientSecret: gmailClientSecret.trim() || undefined,
                                refreshToken: gmailRefreshToken.trim() || undefined,
                                query: gmailQuery.trim() || undefined
                            }).then(next => {
                            setGmailClientSecret('');
                            setGmailRefreshToken('');
                            setGmailCredentialsJson('');
                            setGmailUseJson(false);
                            return next;
                        }), 'Gmail guardado.')}
                    >
                        {busy === 'gmail-save' ? 'Guardando…' : 'Guardar'}
                    </button>
                    <button type='button' className='fokkus-backlog-icon-button' disabled={!config.gmail.configured} onClick={() => test('gmail', 'gmail')}>
                        <i className='fa fa-plug' /> {busy === 'gmail-test' ? 'Probando…' : 'Probar'}
                    </button>
                    <button type='button' className='fokkus-backlog-icon-button' onClick={() => clear('gmail', 'Gmail', () => server.clearGmailConfig())}>
                        <i className='fa fa-trash' /> Eliminar
                    </button>
                </div>
                {renderFeedback('gmail')}
            </fieldset>

            {/* Jira (destino) */}
            <fieldset className='fokkus-triage-config-card' disabled={disabled}>
                <legend className='fokkus-triage-config-title'><i className='fa fa-ticket' /> Jira (destino)</legend>
                <label className='fokkus-backlog-field'>
                    <span className='fokkus-backlog-label'>URL del sitio</span>
                    <input
                        className='fokkus-backlog-input'
                        type='url'
                        value={jiraBaseUrl}
                        onChange={event => setJiraBaseUrl(event.target.value)}
                        placeholder='https://empresa.atlassian.net'
                    />
                </label>
                <label className='fokkus-backlog-field'>
                    <span className='fokkus-backlog-label'>Email de la cuenta</span>
                    <input
                        className='fokkus-backlog-input'
                        type='email'
                        value={jiraEmail}
                        onChange={event => setJiraEmail(event.target.value)}
                        placeholder='usuario@empresa.cl'
                    />
                </label>
                <label className='fokkus-backlog-field'>
                    <span className='fokkus-backlog-label'>API Token · {SECRET_SOURCE_LABELS[config.jira.apiTokenSource]}</span>
                    <input
                        className='fokkus-backlog-input'
                        type='password'
                        autoComplete='new-password'
                        value={jiraApiToken}
                        onChange={event => setJiraApiToken(event.target.value)}
                        placeholder={config.jira.apiTokenSource !== 'none' ? '•••• guardado (vacío = conservar)' : 'API token de Atlassian'}
                    />
                </label>
                {config.jira.accountName && <span className='fokkus-triage-hint'>Cuenta: <strong>{config.jira.accountName}</strong>.</span>}
                <div className='fokkus-triage-actions'>
                    <button
                        type='button'
                        className='fokkus-backlog-apply'
                        onClick={() => run('jira-save', 'jira', () => server.saveJiraConfig({
                            baseUrl: jiraBaseUrl.trim(),
                            email: jiraEmail.trim(),
                            apiToken: jiraApiToken.trim() || undefined
                        }).then(next => { setJiraApiToken(''); return next; }), 'Jira guardado.')}
                    >
                        {busy === 'jira-save' ? 'Guardando…' : 'Guardar'}
                    </button>
                    <button type='button' className='fokkus-backlog-icon-button' disabled={!config.jira.configured} onClick={() => test('jira', 'jira')}>
                        <i className='fa fa-plug' /> {busy === 'jira-test' ? 'Probando…' : 'Probar'}
                    </button>
                    <button type='button' className='fokkus-backlog-icon-button' onClick={() => clear('jira', 'Jira', () => server.clearJiraConfig())}>
                        <i className='fa fa-trash' /> Eliminar
                    </button>
                </div>
                {renderFeedback('jira')}
            </fieldset>

            {/* Plane y GitHub reutilizan su configuración existente */}
            <fieldset className='fokkus-triage-config-card' disabled={disabled}>
                <legend className='fokkus-triage-config-title'><i className='fa fa-plug' /> Plane y GitHub (destinos)</legend>
                {[plane, github].map(item => item && (
                    <div key={item.id} className='fokkus-triage-provider-status'>
                        <span className={item.configured ? 'fokkus-triage-dot fokkus-triage-dot-ok' : 'fokkus-triage-dot'} />
                        <span className='fokkus-triage-provider-status-text'>
                            <strong>{item.label}</strong>: {item.configured ? 'configurado' : (item.message ?? 'sin configurar')}
                        </span>
                        <button type='button' className='fokkus-backlog-icon-button' disabled={!item.configured} onClick={() => test(item.id, item.id)}>
                            <i className='fa fa-plug' /> {busy === `${item.id}-test` ? 'Probando…' : 'Probar'}
                        </button>
                    </div>
                ))}
                {renderFeedback('plane')}
                {renderFeedback('github')}
                <span className='fokkus-triage-hint'>
                    Plane usa la conexión del panel Plane Backlog y GitHub el token de Preferencias › Git Providers
                    (para crear issues necesita permiso de escritura en Issues).
                </span>
            </fieldset>
        </div>
    );
}
