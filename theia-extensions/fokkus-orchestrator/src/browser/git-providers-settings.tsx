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
    GIT_CREDENTIAL_MAX_LENGTH,
    GitCredentialSource,
    GitCredentialsServer,
    GitCredentialsStatus,
    GitCredentialsTestResult,
    GitProviderId
} from '../common/git-credentials-protocol';

/** Si el backend no está desplegado, el proxy RPC nunca responde: se corta con un timeout. */
const RPC_TIMEOUT_MS = 15000;

const SOURCE_LABELS: Record<GitCredentialSource, string> = {
    'env': 'Variable de entorno',
    'secret-storage': 'Almacén seguro',
    'legacy-file': 'Archivo plano (legado)',
    'none': 'Sin configurar'
};

function withTimeout<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(
            () => reject(new Error('El servicio de credenciales no respondió. Revisa que el backend de Fokkus esté actualizado.')),
            RPC_TIMEOUT_MS
        );
        promise.then(
            value => { window.clearTimeout(timer); resolve(value); },
            error => { window.clearTimeout(timer); reject(error); }
        );
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export interface GitProvidersSettingsProps {
    server: GitCredentialsServer;
    /** Diálogo de confirmación del IDE (resuelve true si el usuario acepta). */
    confirm(title: string, message: string): Promise<boolean>;
}

type Busy = 'github-save' | 'github-test' | 'github-clear' | 'bitbucket-save' | 'bitbucket-test' | 'bitbucket-clear' | 'import';

interface Feedback {
    kind: 'success' | 'error';
    text: string;
}

export function GitProvidersSettings({ server, confirm }: GitProvidersSettingsProps): React.ReactElement {
    const [status, setStatus] = React.useState<GitCredentialsStatus>();
    const [loadError, setLoadError] = React.useState<string>();
    const [busy, setBusy] = React.useState<Busy>();
    const [feedback, setFeedback] = React.useState<Partial<Record<GitProviderId | 'import', Feedback>>>({});

    const [githubToken, setGithubToken] = React.useState('');
    const [bitbucketUsername, setBitbucketUsername] = React.useState('');
    const [bitbucketAppPassword, setBitbucketAppPassword] = React.useState('');
    const [revealed, setRevealed] = React.useState<Partial<Record<GitProviderId, boolean>>>({});

    const applyStatus = React.useCallback((next: GitCredentialsStatus) => {
        setStatus(next);
        setLoadError(undefined);
        setBitbucketUsername(next.bitbucket.username ?? '');
    }, []);

    const reload = React.useCallback(async () => {
        try {
            applyStatus(await withTimeout(server.getStatus()));
        } catch (error) {
            setLoadError(errorMessage(error));
        }
    }, [server, applyStatus]);

    React.useEffect(() => {
        reload();
    }, [reload]);

    const setProviderFeedback = (key: GitProviderId | 'import', value?: Feedback): void =>
        setFeedback(current => ({ ...current, [key]: value }));

    const run = async (kind: Busy, key: GitProviderId | 'import', action: () => Promise<GitCredentialsStatus>, success: string): Promise<boolean> => {
        setBusy(kind);
        setProviderFeedback(key);
        try {
            applyStatus(await withTimeout(action()));
            setProviderFeedback(key, { kind: 'success', text: success });
            return true;
        } catch (error) {
            setProviderFeedback(key, { kind: 'error', text: errorMessage(error) });
            return false;
        } finally {
            setBusy(undefined);
        }
    };

    const describeTest = (result: GitCredentialsTestResult): Feedback => ({
        kind: result.ok ? 'success' : 'error',
        text: result.ok && result.identity ? `${result.message} (${result.identity})` : result.message
    });

    const testConnection = async (provider: GitProviderId): Promise<void> => {
        setBusy(provider === 'github' ? 'github-test' : 'bitbucket-test');
        setProviderFeedback(provider);
        try {
            setProviderFeedback(provider, describeTest(await withTimeout(server.testConnection(provider))));
        } catch (error) {
            setProviderFeedback(provider, { kind: 'error', text: errorMessage(error) });
        } finally {
            setBusy(undefined);
        }
    };

    const saveGitHub = async (): Promise<void> => {
        const token = githubToken.trim();
        if (await run('github-save', 'github', () => server.saveGitHub({ token }), 'Token guardado en el almacén seguro.')) {
            setGithubToken('');
            setRevealed(current => ({ ...current, github: false }));
        }
    };

    const saveBitbucket = async (): Promise<void> => {
        const input = { username: bitbucketUsername.trim(), appPassword: bitbucketAppPassword.trim() || undefined };
        if (await run('bitbucket-save', 'bitbucket', () => server.saveBitbucket(input), 'Credenciales de Bitbucket guardadas en el almacén seguro.')) {
            setBitbucketAppPassword('');
            setRevealed(current => ({ ...current, bitbucket: false }));
        }
    };

    const clearProvider = async (provider: GitProviderId): Promise<void> => {
        const name = provider === 'github' ? 'GitHub' : 'Bitbucket';
        const accepted = await confirm(
            `Eliminar credenciales de ${name}`,
            'Se borrarán del almacén seguro. Las variables de entorno y los archivos legados no se modifican.'
        );
        if (!accepted) {
            return;
        }
        await run(
            provider === 'github' ? 'github-clear' : 'bitbucket-clear',
            provider,
            () => provider === 'github' ? server.clearGitHub() : server.clearBitbucket(),
            `Credenciales de ${name} eliminadas del almacén seguro.`
        );
    };

    if (loadError && !status) {
        return (
            <div className='fokkus-gitprov'>
                <div className='fokkus-gitprov-banner fokkus-gitprov-banner-error' role='alert'>
                    <span className='codicon codicon-error' />
                    <span>No se pudo leer el estado de las credenciales: {loadError}</span>
                </div>
                <button type='button' className='theia-button secondary' onClick={reload}>Reintentar</button>
            </div>
        );
    }
    if (!status) {
        return <div className='fokkus-gitprov fokkus-gitprov-muted'>Cargando estado de credenciales…</div>;
    }

    const disabled = busy !== undefined;
    const { github, bitbucket } = status;
    const bitbucketNeedsPassword = !bitbucket.storedInSecretStorage;

    return (
        <div className='fokkus-gitprov'>
            {status.storage === 'os-keychain' ? (
                <div className='fokkus-gitprov-banner fokkus-gitprov-banner-ok'>
                    <span className='codicon codicon-lock' />
                    <span>Los secretos se guardan cifrados en el almacén de credenciales del sistema operativo, nunca en settings.json.</span>
                </div>
            ) : (
                <div className='fokkus-gitprov-banner fokkus-gitprov-banner-warning' role='alert'>
                    <span className='codicon codicon-warning' />
                    <span>
                        El almacén de credenciales del sistema no está disponible (en Linux requiere libsecret y un servicio
                        como GNOME Keyring o KWallet). Lo que guardes aquí solo durará hasta cerrar el IDE.
                    </span>
                </div>
            )}

            {status.legacyImportAvailable && (
                <div className='fokkus-gitprov-banner fokkus-gitprov-banner-info'>
                    <span className='codicon codicon-info' />
                    <span className='fokkus-gitprov-banner-text'>
                        Hay credenciales en archivos de texto plano (~/.fokkus/github.json o ~/.bitbucket_credentials.env).
                        Puedes importarlas al almacén seguro.
                    </span>
                    <button
                        type='button'
                        className='theia-button secondary'
                        disabled={disabled}
                        onClick={() => run('import', 'import', () => server.importLegacyCredentials(), 'Credenciales importadas al almacén seguro.')}
                    >
                        {busy === 'import' ? 'Importando…' : 'Importar'}
                    </button>
                </div>
            )}
            <FeedbackLine feedback={feedback.import} />

            <section className='fokkus-gitprov-card' aria-labelledby='fokkus-gitprov-github-title'>
                <header className='fokkus-gitprov-card-header'>
                    <span id='fokkus-gitprov-github-title' className='fokkus-gitprov-card-title'>GitHub</span>
                    <SourceBadge source={github.source} />
                </header>
                {github.source === 'env' && (
                    <p className='fokkus-gitprov-hint'>
                        GITHUB_TOKEN / GH_TOKEN del entorno tiene prioridad. Lo que guardes aquí se usará cuando la variable no esté definida.
                    </p>
                )}
                <label className='fokkus-gitprov-field'>
                    <span className='fokkus-gitprov-label'>Personal Access Token</span>
                    <SecretInput
                        value={githubToken}
                        onChange={setGithubToken}
                        revealed={!!revealed.github}
                        onToggleReveal={() => setRevealed(current => ({ ...current, github: !current.github }))}
                        placeholder={github.storedInSecretStorage ? '•••••••• guardado — escribe uno nuevo para reemplazarlo' : 'ghp_… o github_pat_…'}
                        disabled={disabled}
                    />
                    <span className='fokkus-gitprov-hint'>
                        Lo usan Source Control, Issues/Kanban y los agentes (como GITHUB_TOKEN). Permisos mínimos: lectura de repo, issues y pull requests.
                    </span>
                </label>
                <div className='fokkus-gitprov-actions'>
                    <button
                        type='button'
                        className='theia-button main'
                        disabled={disabled || githubToken.trim().length === 0}
                        onClick={saveGitHub}
                    >
                        {busy === 'github-save' ? 'Guardando…' : 'Guardar'}
                    </button>
                    <button type='button' className='theia-button secondary' disabled={disabled || !github.configured} onClick={() => testConnection('github')}>
                        {busy === 'github-test' ? 'Probando…' : 'Probar conexión'}
                    </button>
                    <button
                        type='button'
                        className='theia-button secondary'
                        disabled={disabled || !github.storedInSecretStorage}
                        onClick={() => clearProvider('github')}
                    >
                        {busy === 'github-clear' ? 'Eliminando…' : 'Eliminar'}
                    </button>
                </div>
                <FeedbackLine feedback={feedback.github} />
            </section>

            <section className='fokkus-gitprov-card' aria-labelledby='fokkus-gitprov-bitbucket-title'>
                <header className='fokkus-gitprov-card-header'>
                    <span id='fokkus-gitprov-bitbucket-title' className='fokkus-gitprov-card-title'>Bitbucket</span>
                    <SourceBadge source={bitbucket.source} />
                </header>
                {bitbucket.source === 'env' && (
                    <p className='fokkus-gitprov-hint'>
                        BITBUCKET_USERNAME / BITBUCKET_APP_PASSWORD del entorno tienen prioridad sobre lo guardado aquí.
                    </p>
                )}
                <label className='fokkus-gitprov-field'>
                    <span className='fokkus-gitprov-label'>Username</span>
                    <input
                        className='theia-input fokkus-gitprov-input'
                        type='text'
                        value={bitbucketUsername}
                        onChange={event => setBitbucketUsername(event.target.value)}
                        placeholder='usuario de Bitbucket'
                        autoComplete='off'
                        spellCheck={false}
                        maxLength={GIT_CREDENTIAL_MAX_LENGTH}
                        disabled={disabled}
                    />
                </label>
                <label className='fokkus-gitprov-field'>
                    <span className='fokkus-gitprov-label'>App Password</span>
                    <SecretInput
                        value={bitbucketAppPassword}
                        onChange={setBitbucketAppPassword}
                        revealed={!!revealed.bitbucket}
                        onToggleReveal={() => setRevealed(current => ({ ...current, bitbucket: !current.bitbucket }))}
                        placeholder={bitbucket.storedInSecretStorage ? '•••••••• guardado — déjalo vacío para conservarlo' : 'App password (o API token de Atlassian)'}
                        disabled={disabled}
                    />
                    <span className='fokkus-gitprov-hint'>
                        Integración de solo lectura: basta con permisos de lectura de cuenta, repositorios y pull requests.
                    </span>
                </label>
                {bitbucket.legacyTokenRepositories.length > 0 && (
                    <div className='fokkus-gitprov-hint'>
                        Tokens por repositorio en ~/.bitbucket_credentials.env (siguen activos):{' '}
                        {bitbucket.legacyTokenRepositories.map(repo => <code key={repo} className='fokkus-gitprov-repo'>{repo}</code>)}
                    </div>
                )}
                <div className='fokkus-gitprov-actions'>
                    <button
                        type='button'
                        className='theia-button main'
                        disabled={disabled || bitbucketUsername.trim().length === 0 || (bitbucketNeedsPassword && bitbucketAppPassword.trim().length === 0)}
                        onClick={saveBitbucket}
                    >
                        {busy === 'bitbucket-save' ? 'Guardando…' : 'Guardar'}
                    </button>
                    <button type='button' className='theia-button secondary' disabled={disabled || !bitbucket.configured} onClick={() => testConnection('bitbucket')}>
                        {busy === 'bitbucket-test' ? 'Probando…' : 'Probar conexión'}
                    </button>
                    <button
                        type='button'
                        className='theia-button secondary'
                        disabled={disabled || !bitbucket.storedInSecretStorage}
                        onClick={() => clearProvider('bitbucket')}
                    >
                        {busy === 'bitbucket-clear' ? 'Eliminando…' : 'Eliminar'}
                    </button>
                </div>
                <FeedbackLine feedback={feedback.bitbucket} />
            </section>
        </div>
    );
}

interface SecretInputProps {
    value: string;
    onChange(value: string): void;
    revealed: boolean;
    onToggleReveal(): void;
    placeholder: string;
    disabled: boolean;
}

function SecretInput({ value, onChange, revealed, onToggleReveal, placeholder, disabled }: SecretInputProps): React.ReactElement {
    return (
        <span className='fokkus-gitprov-secret'>
            <input
                className='theia-input fokkus-gitprov-input'
                type={revealed ? 'text' : 'password'}
                value={value}
                onChange={event => onChange(event.target.value)}
                placeholder={placeholder}
                autoComplete='new-password'
                spellCheck={false}
                maxLength={GIT_CREDENTIAL_MAX_LENGTH}
                disabled={disabled}
            />
            <button
                type='button'
                className='fokkus-gitprov-reveal'
                onClick={onToggleReveal}
                disabled={disabled || value.length === 0}
                title={revealed ? 'Ocultar' : 'Mostrar'}
                aria-label={revealed ? 'Ocultar valor' : 'Mostrar valor'}
                aria-pressed={revealed}
            >
                <span className={`codicon ${revealed ? 'codicon-eye-closed' : 'codicon-eye'}`} />
            </button>
        </span>
    );
}

function SourceBadge({ source }: { source: GitCredentialSource }): React.ReactElement {
    return <span className={`fokkus-gitprov-badge fokkus-gitprov-badge-${source}`}>{SOURCE_LABELS[source]}</span>;
}

function FeedbackLine({ feedback }: { feedback?: Feedback }): React.ReactElement | null {
    if (!feedback) {
        // eslint-disable-next-line no-null/no-null
        return null;
    }
    return (
        <div className={`fokkus-gitprov-feedback fokkus-gitprov-feedback-${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'}>
            {feedback.text}
        </div>
    );
}
