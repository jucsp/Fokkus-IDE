/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import {
    BitbucketConfigStatus,
    BitbucketPullRequest,
    BitbucketPullRequestFile,
    BitbucketPullRequestState,
    BitbucketRepo,
    BitbucketRepoError,
    BitbucketServer
} from '../common/bitbucket-protocol';
import { FokkusChatDispatcher } from './fokkus-chat-dispatch';
import { GitHubHtml, htmlToPlainText } from './github-html';

export const BITBUCKET_PULL_REQUESTS_WIDGET_ID = 'fokkus-bitbucket-pull-requests';

/** Filtro de estado del PR: los cuatro estados de Bitbucket más la vista global. */
type BitbucketStateFilter = BitbucketPullRequestState | 'ALL';

const REPO_OVERRIDE_KEY = 'fokkus.bitbucket.prs.repo';

/**
 * Valor centinela persistido para distinguir "todos los repositorios elegido por el
 * usuario" de "sin preferencia guardada". Ambos se traducen a filtro vacío (global),
 * pero solo el centinela se escribe en localStorage.
 */
const ALL_REPOS_SENTINEL = '__all__';

function storageKey(workspaceUri: string): string {
    return `${REPO_OVERRIDE_KEY}:${workspaceUri}`;
}

/** Clave estable de una tarjeta de PR: los ids se repiten entre repos. */
function prKey(pr: BitbucketPullRequest): string {
    return `${pr.repo}#${pr.id}`;
}

/** Normaliza para búsqueda local: minúsculas y sin tildes. */
function normalizeForSearch(value: string): string {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

const BITBUCKET_STATE_LABELS: Record<BitbucketPullRequestState, string> = {
    OPEN: 'Abierto',
    MERGED: 'Merged',
    DECLINED: 'Declinado',
    SUPERSEDED: 'Superado'
};

function prStateLabel(pr: BitbucketPullRequest): string {
    return BITBUCKET_STATE_LABELS[pr.state];
}

const BITBUCKET_STATE_TONES: Record<BitbucketPullRequestState, string> = {
    OPEN: 'open',
    MERGED: 'merged',
    DECLINED: 'closed',
    SUPERSEDED: 'draft'
};

function prStateTone(pr: BitbucketPullRequest): string {
    return BITBUCKET_STATE_TONES[pr.state];
}

function formatRelativeDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return iso;
    }
    const minutes = Math.round((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) {
        return 'ahora mismo';
    }
    if (minutes < 60) {
        return `hace ${minutes} min`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
        return `hace ${hours} h`;
    }
    const days = Math.round(hours / 24);
    if (days < 30) {
        return `hace ${days} d`;
    }
    return date.toLocaleDateString();
}

/**
 * Construye el prompt de code review del PR de Bitbucket. Es agnóstico al proveedor
 * de IA: el chat de Fokkus Team decide con qué agentes ejecutarlo. El prompt es
 * ESTRICTAMENTE de solo lectura: únicamente autoriza peticiones GET a la API.
 */
export function buildBitbucketPullRequestReviewPrompt(
    pr: BitbucketPullRequest,
    files: BitbucketPullRequestFile[],
    credentialVariable: string | undefined
): string {
    const [workspace = '', slug = ''] = pr.repo.split('/');
    const description = htmlToPlainText(pr.descriptionHtml).trim() || 'Sin descripción';
    const stateLabel = prStateLabel(pr);
    const fileLines = files.slice(0, 60).map(file => `- ${file.status} ${file.path} (+${file.linesAdded}/-${file.linesRemoved})`);
    const more = files.length > 60 ? `\n- … y ${files.length - 60} archivos más` : '';
    const fileList = `${fileLines.join('\n')}${more}`;
    const repoApi = `https://api.bitbucket.org/2.0/repositories/${workspace}/${slug}`;
    const prApi = `${repoApi}/pullrequests/${pr.id}`;

    let authSegment: string;
    let authInstruction: string;
    if (credentialVariable?.startsWith('BITBUCKET_TOKEN_')) {
        authSegment = `-H "Authorization: Bearer $${credentialVariable}" `;
        authInstruction = `El entorno ya expone la variable $${credentialVariable} con la credencial de este repositorio. `
            + `Úsala SIEMPRE por referencia ("$${credentialVariable}"): nunca imprimas, copies ni registres su valor.`;
    } else if (credentialVariable === 'BITBUCKET_APP_PASSWORD') {
        authSegment = '-u "$BITBUCKET_USERNAME:$BITBUCKET_APP_PASSWORD" ';
        authInstruction = 'El entorno ya expone $BITBUCKET_USERNAME y $BITBUCKET_APP_PASSWORD. '
            + 'Úsalas SIEMPRE por referencia: nunca imprimas, copies ni registres su valor.';
    } else {
        authSegment = '';
        authInstruction = 'No hay credencial configurada para este repositorio: trabaja SOLO con repositorios públicos '
            + 'y no añadas cabeceras de autenticación a las peticiones.';
    }

    const header = `Revisa el Pull Request #${pr.id} del repositorio ${pr.repo}: "${pr.title}".\n`
        + `Autor: ${pr.author}. Rama: ${pr.sourceBranch} → ${pr.destinationBranch}. Estado: ${stateLabel}. URL: ${pr.htmlUrl}\n`
        + `Descripción: ${description}\n`
        + `Archivos modificados (${files.length}):\n${fileList}`;

    const body = [
        'INSTRUCCIÓN: Obtén el diff completo del PR y realiza un code review exhaustivo: '
            + 'bugs y errores de lógica, seguridad, rendimiento, legibilidad y cobertura de pruebas.',
        '',
        authInstruction,
        '',
        'Cómo obtener la información (SOLO peticiones GET, sin git ni credenciales interactivas):',
        `1) Diff completo del PR:\n\`curl -sSfL -X GET ${authSegment}"${prApi}/diff"\``,
        `2) Diffstat (resumen de archivos):\n\`curl -sSfL -X GET ${authSegment}"${prApi}/diffstat?pagelen=100"\``,
        '3) Contenido completo de un archivo: primero obtén el commit de origen (campo source.commit.hash) con\n'
            + `\`curl -sSfL -X GET ${authSegment}"${prApi}"\` y luego\n`
            + `\`curl -sSfL -X GET ${authSegment}"${repoApi}/src/<hash>/<ruta>"\` (sustituye <hash> y <ruta>).`,
        '',
        'REGLAS CRÍTICAS:',
        '- SOLO peticiones GET a la API de Bitbucket.',
        '- PROHIBIDO ejecutar git fetch, git clone, git pull o cualquier comando que solicite credenciales de forma interactiva.',
        '- PROHIBIDO enviar peticiones POST, PUT, DELETE o PATCH.',
        '- PROHIBIDO aprobar, fusionar (merge), declinar o comentar el Pull Request.',
        '- No modifiques archivos ni hagas commits.',
        '- Nunca imprimas, copies ni registres el valor de la credencial.',
        '',
        'Entrega: 1) resumen del cambio, 2) hallazgos ordenados por severidad con archivo:línea y sugerencia concreta, '
            + '3) resumen de riesgos y recomendaciones. El feedback entrégalo SOLO en este chat.'
    ].join('\n');

    return `${header}\n\n${body}`;
}

interface BitbucketPullRequestsAppProps {
    bitbucketServer: BitbucketServer;
    windowService: WindowService;
    workspaceService: WorkspaceService;
    dispatcher: FokkusChatDispatcher;
}

function BitbucketPullRequestsApp({ bitbucketServer, windowService, workspaceService, dispatcher }: BitbucketPullRequestsAppProps): React.ReactElement {
    const [config, setConfig] = React.useState<BitbucketConfigStatus | undefined>(undefined);
    const [workspaceUri, setWorkspaceUri] = React.useState<string>('');
    const [repositories, setRepositories] = React.useState<BitbucketRepo[]>([]);
    const [repoFilter, setRepoFilter] = React.useState<string>('');
    const [detecting, setDetecting] = React.useState<boolean>(false);
    const [repoError, setRepoError] = React.useState<string | undefined>(undefined);
    const [stateFilter, setStateFilter] = React.useState<BitbucketStateFilter>('OPEN');
    const [prs, setPrs] = React.useState<BitbucketPullRequest[]>([]);
    const [errors, setErrors] = React.useState<BitbucketRepoError[]>([]);
    const [loading, setLoading] = React.useState<boolean>(false);
    const [error, setError] = React.useState<string | undefined>(undefined);
    const [reloadToken, setReloadToken] = React.useState<number>(0);
    const [searchQuery, setSearchQuery] = React.useState<string>('');
    const [expandedKey, setExpandedKey] = React.useState<string | undefined>(undefined);
    const [filesByPr, setFilesByPr] = React.useState<Record<string, BitbucketPullRequestFile[]>>({});
    const [filesLoadingKey, setFilesLoadingKey] = React.useState<string | undefined>(undefined);
    const [filesError, setFilesError] = React.useState<string | undefined>(undefined);
    const [reviewError, setReviewError] = React.useState<string | undefined>(undefined);
    const [reviewingKey, setReviewingKey] = React.useState<string | undefined>(undefined);

    const hasCredentials = config?.hasCredentials === true;

    // Lee la preferencia de filtro guardada para el workspace actual.
    // Sin preferencia guardada el default es TODOS (no el repo detectado).
    const loadWorkspacePreference = React.useCallback(async (): Promise<void> => {
        await workspaceService.ready;
        const uri = workspaceService.workspace?.resource.toString() ?? 'no-workspace';
        setWorkspaceUri(uri);
        const saved = localStorage.getItem(storageKey(uri)) ?? undefined;
        if (!saved || saved === ALL_REPOS_SENTINEL) {
            setRepoFilter('');
        } else {
            setRepoFilter(saved);
        }
    }, [workspaceService]);

    // Carga la configuración una sola vez.
    React.useEffect(() => {
        let cancelled = false;
        bitbucketServer.getConfig()
            .then(cfg => {
                if (!cancelled) {
                    setConfig(cfg);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setConfig({ hasCredentials: false, hasAppPassword: false, tokenRepositories: [] });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [bitbucketServer]);

    // Preferencia inicial del workspace.
    React.useEffect(() => {
        loadWorkspacePreference().catch(err => console.error('[fokkus-bitbucket] No se pudo cargar la preferencia de workspace', err));
    }, [loadWorkspacePreference]);

    // Vuelve a leer la preferencia cuando cambia la raíz del workspace.
    React.useEffect(() => {
        const disposable = workspaceService.onWorkspaceChanged(() => {
            loadWorkspacePreference().catch(err => console.error('[fokkus-bitbucket] No se pudo cargar la preferencia de workspace', err));
        });
        return () => disposable.dispose();
    }, [workspaceService, loadWorkspacePreference]);

    // Carga la lista de repositorios accesibles para el filtro.
    React.useEffect(() => {
        if (!hasCredentials) {
            setRepositories([]);
            return;
        }
        let cancelled = false;
        bitbucketServer.listRepositories()
            .then(list => {
                if (!cancelled) {
                    setRepositories(list);
                }
            })
            .catch(err => {
                if (!cancelled) {
                    console.error('[fokkus-bitbucket] No se pudieron listar los repositorios', err);
                    setRepositories([]);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [bitbucketServer, hasCredentials]);

    // Recarga los PR: sin filtro → todos los abiertos de todos los repos (con errores);
    // con filtro → PR del repo según el estado elegido.
    React.useEffect(() => {
        if (!hasCredentials) {
            setPrs([]);
            setErrors([]);
            setError(undefined);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(undefined);
        const load = async (): Promise<{ pullRequests: BitbucketPullRequest[]; errors: BitbucketRepoError[] }> => {
            if (repoFilter === '') {
                const result = await bitbucketServer.listOpenPullRequestsAllRepos();
                return { pullRequests: result.pullRequests, errors: result.errors };
            }
            const list = await bitbucketServer.listPullRequests(repoFilter, stateFilter);
            return { pullRequests: list, errors: [] };
        };
        load()
            .then(result => {
                if (!cancelled) {
                    setPrs(result.pullRequests);
                    setErrors(result.errors);
                    setExpandedKey(undefined);
                    setFilesByPr({});
                }
            })
            .catch(err => {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : String(err));
                    setPrs([]);
                    setErrors([]);
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setLoading(false);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [bitbucketServer, hasCredentials, repoFilter, stateFilter, reloadToken]);

    // Carga perezosa de los archivos del PR expandido, usando pr.repo.
    React.useEffect(() => {
        if (!expandedKey || !hasCredentials) {
            return;
        }
        if (filesByPr[expandedKey]) {
            return;
        }
        const pr = prs.find(item => prKey(item) === expandedKey);
        if (!pr) {
            return;
        }
        let cancelled = false;
        setFilesLoadingKey(expandedKey);
        setFilesError(undefined);
        bitbucketServer.listPullRequestFiles(pr.repo, pr.id)
            .then(files => {
                if (!cancelled) {
                    setFilesByPr(prev => ({ ...prev, [expandedKey]: files }));
                }
            })
            .catch(err => {
                if (!cancelled) {
                    setFilesError(err instanceof Error ? err.message : String(err));
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setFilesLoadingKey(undefined);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [expandedKey, hasCredentials, prs, bitbucketServer, filesByPr]);

    const handleRepoFilterChange = (value: string): void => {
        if (value === '') {
            // En modo global el estado se fija visualmente en "Abiertos".
            setStateFilter('OPEN');
            localStorage.setItem(storageKey(workspaceUri), ALL_REPOS_SENTINEL);
        } else {
            localStorage.setItem(storageKey(workspaceUri), value);
        }
        setRepoFilter(value);
    };

    const handleDetect = React.useCallback(async (): Promise<void> => {
        setDetecting(true);
        setRepoError(undefined);
        try {
            const roots = await workspaceService.roots;
            const root = roots[0];
            const detected = root ? await bitbucketServer.detectRepository(root.resource.toString()) : undefined;
            if (detected) {
                setRepoFilter(detected);
                localStorage.setItem(storageKey(workspaceUri), detected);
            } else {
                setRepoError('No se detectó un repositorio de Bitbucket en la carpeta abierta.');
            }
        } catch (err) {
            setRepoError(err instanceof Error ? err.message : String(err));
        } finally {
            setDetecting(false);
        }
    }, [bitbucketServer, workspaceService, workspaceUri]);

    const handleReview = async (pr: BitbucketPullRequest): Promise<void> => {
        const key = prKey(pr);
        setReviewingKey(key);
        setReviewError(undefined);
        try {
            let files = filesByPr[key];
            if (!files) {
                files = await bitbucketServer.listPullRequestFiles(pr.repo, pr.id);
                setFilesByPr(prev => ({ ...prev, [key]: files }));
            }
            const credentialVariable = repositories.find(item => item.fullName === pr.repo)?.credentialVariable;
            await dispatcher.send(buildBitbucketPullRequestReviewPrompt(pr, files, credentialVariable));
        } catch (err) {
            setReviewError(err instanceof Error ? err.message : String(err));
        } finally {
            setReviewingKey(undefined);
        }
    };

    // Asegura que el repo seleccionado (detectado o persistido) aparezca como opción
    // aunque listRepositories no lo devuelva.
    const repoOptions = React.useMemo<BitbucketRepo[]>(() => {
        if (!repoFilter || repositories.some(repo => repo.fullName === repoFilter)) {
            return repositories;
        }
        const [workspace = '', slug = ''] = repoFilter.split('/');
        return [...repositories, { fullName: repoFilter, workspace, slug, auth: 'token', credentialVariable: '' }];
    }, [repositories, repoFilter]);

    const filteredPrs = React.useMemo(() => {
        const query = normalizeForSearch(searchQuery);
        if (!query) {
            return prs;
        }
        return prs.filter(pr =>
            normalizeForSearch(`#${pr.id}`).includes(query) ||
            normalizeForSearch(pr.title).includes(query) ||
            normalizeForSearch(pr.repo).includes(query)
        );
    }, [prs, searchQuery]);

    const isGlobalMode = repoFilter === '';

    return (
        <div className='fokkus-github-pr'>
            {config && !config.hasCredentials && (
                <div className='fokkus-github-token-warning'>
                    <span>Bitbucket no está configurado.</span>
                    <span>
                        Crea <code>~/.bitbucket_credentials.env</code> con <code>BITBUCKET_USERNAME</code> y una de estas opciones:
                    </span>
                    <pre className='fokkus-bb-credentials-example'>{[
                        'BITBUCKET_USERNAME=tu_usuario',
                        'BITBUCKET_APP_PASSWORD=tu_app_password'
                    ].join('\n')}</pre>
                    <span>O, para dar acceso a un repositorio concreto (token de repositorio):</span>
                    <pre className='fokkus-bb-credentials-example'>{[
                        'BITBUCKET_USERNAME=tu_usuario',
                        '# Repositorio: <slug> (<workspace>)',
                        'BITBUCKET_TOKEN_<CLAVE>=tu_token'
                    ].join('\n')}</pre>
                </div>
            )}

            <div className='fokkus-github-repo-row'>
                <select
                    className='fokkus-backlog-input'
                    value={repoFilter}
                    onChange={event => handleRepoFilterChange(event.target.value)}
                    disabled={!hasCredentials}
                    aria-label='Repositorio'
                >
                    <option value=''>Todos los repositorios</option>
                    {repoOptions.map(repo => (
                        <option key={repo.fullName} value={repo.fullName}>{repo.fullName}</option>
                    ))}
                </select>
                <button
                    type='button'
                    className='fokkus-github-detect-button'
                    onClick={() => handleDetect().catch(err => console.error('[fokkus-bitbucket] No se pudo detectar el repositorio', err))}
                    disabled={detecting || !hasCredentials}
                >
                    Detectar
                </button>
            </div>
            {repoError && <div className='fokkus-backlog-error'>{repoError}</div>}

            <div className='fokkus-github-filters'>
                <select
                    className='fokkus-backlog-input'
                    value={isGlobalMode ? 'OPEN' : stateFilter}
                    onChange={event => setStateFilter(event.target.value as BitbucketStateFilter)}
                    disabled={!hasCredentials || isGlobalMode}
                    aria-label='Estado'
                >
                    <option value='OPEN'>Abiertos</option>
                    <option value='MERGED'>Merged</option>
                    <option value='DECLINED'>Declinados</option>
                    <option value='SUPERSEDED'>Superados</option>
                    <option value='ALL'>Todos</option>
                </select>
                <button
                    type='button'
                    className='fokkus-backlog-icon-button'
                    title='Refrescar'
                    aria-label='Refrescar'
                    onClick={() => setReloadToken(token => token + 1)}
                    disabled={loading || !hasCredentials}
                >
                    <i className='fa fa-refresh' />
                </button>
            </div>

            <input
                className='fokkus-backlog-input fokkus-github-search'
                type='search'
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                placeholder='Buscar por repo, id o título…'
                disabled={prs.length === 0}
                aria-label='Buscar pull requests'
            />

            {loading && <div className='fokkus-backlog-status'>Cargando pull requests…</div>}
            {error && <div className='fokkus-backlog-error'>{error}</div>}

            {isGlobalMode && !loading && errors.length > 0 && (
                <div className='fokkus-bb-errors'>
                    <div className='fokkus-bb-errors-title'>Repositorios con errores</div>
                    {errors.map(repoErr => (
                        <div key={repoErr.repo} className='fokkus-bb-error-item'>
                            <span className='fokkus-bb-error-repo'>{repoErr.repo}:</span>
                            {/* El backend ya antepone `Bitbucket <status>:` al mensaje. */}
                            <span className='fokkus-bb-error-message'>{repoErr.message}</span>
                        </div>
                    ))}
                </div>
            )}

            {!loading && !error && hasCredentials && prs.length === 0 && (
                <div className='fokkus-backlog-status'>Sin pull requests</div>
            )}
            {!loading && !error && prs.length > 0 && filteredPrs.length === 0 && (
                <div className='fokkus-backlog-status'>Sin resultados para la búsqueda</div>
            )}
            {!loading && filteredPrs.map(pr => {
                const key = prKey(pr);
                const expanded = expandedKey === key;
                const files = filesByPr[key];
                const filesLoading = filesLoadingKey === key;
                return (
                    <article key={key} className='fokkus-backlog-card'>
                        <button
                            type='button'
                            className='fokkus-github-card-header'
                            onClick={() => setExpandedKey(expanded ? undefined : key)}
                            aria-expanded={expanded}
                        >
                            <span className='fokkus-backlog-code'>#{pr.id}</span>
                            <span className='fokkus-backlog-title'>{pr.title}</span>
                            <span className={`fokkus-github-badge fokkus-github-badge-${prStateTone(pr)}`}>{prStateLabel(pr)}</span>
                        </button>
                        <div className='fokkus-github-meta'>
                            {isGlobalMode && <span className='fokkus-github-repo'>{pr.repo} · </span>}
                            {pr.author} · {pr.sourceBranch} → {pr.destinationBranch} · {formatRelativeDate(pr.updatedAt)}
                        </div>
                        {expanded && (
                            <div className='fokkus-github-detail'>
                                <GitHubHtml html={pr.descriptionHtml} windowService={windowService} />
                                <div className='fokkus-github-files'>
                                    <div className='fokkus-github-files-title'>Archivos modificados</div>
                                    {filesLoading && <div className='fokkus-backlog-status'>Cargando archivos…</div>}
                                    {filesError && <div className='fokkus-backlog-error'>{filesError}</div>}
                                    {files && !filesLoading && (
                                        <ul className='fokkus-github-file-list'>
                                            {files.slice(0, 100).map(file => (
                                                <li key={`${file.path}:${file.oldPath ?? ''}`} className='fokkus-github-file-item'>
                                                    <span className='fokkus-github-file-status'>{file.status}</span>
                                                    <span className='fokkus-github-file-name'>{file.path}</span>
                                                    <span className='fokkus-github-file-diff'>
                                                        <span className='fokkus-github-adds'>+{file.linesAdded}</span>
                                                        <span className='fokkus-github-dels'>-{file.linesRemoved}</span>
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                                {reviewError && <div className='fokkus-backlog-error'>{reviewError}</div>}
                                <div className='fokkus-github-actions'>
                                    <button
                                        type='button'
                                        className='fokkus-backlog-apply'
                                        onClick={() => handleReview(pr).catch(err => console.error('[fokkus-bitbucket] No se pudo enviar la revisión', err))}
                                        disabled={reviewingKey === key}
                                    >
                                        <i className='fa fa-magic' />
                                        {reviewingKey === key ? 'Enviando…' : 'Pedir revisión a agentes'}
                                    </button>
                                    <button
                                        type='button'
                                        className='fokkus-backlog-icon-button'
                                        onClick={() => windowService.openNewWindow(pr.htmlUrl, { external: true })}
                                    >
                                        <i className='fa fa-external-link' />
                                        Abrir en Bitbucket
                                    </button>
                                </div>
                            </div>
                        )}
                    </article>
                );
            })}
        </div>
    );
}

@injectable()
export class BitbucketPullRequestsWidget extends ReactWidget {

    static readonly ID = BITBUCKET_PULL_REQUESTS_WIDGET_ID;
    static readonly LABEL = 'Bitbucket Pull Requests';

    @inject(BitbucketServer)
    protected readonly bitbucketServer: BitbucketServer;

    @inject(WindowService)
    protected readonly windowService: WindowService;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(FokkusChatDispatcher)
    protected readonly dispatcher: FokkusChatDispatcher;

    @postConstruct()
    protected init(): void {
        this.id = BitbucketPullRequestsWidget.ID;
        this.title.label = BitbucketPullRequestsWidget.LABEL;
        this.title.caption = BitbucketPullRequestsWidget.LABEL;
        this.title.closable = false;
        this.title.iconClass = 'fa fa-bitbucket';
        this.update();
    }

    protected render(): React.ReactNode {
        return (
            <BitbucketPullRequestsApp
                bitbucketServer={this.bitbucketServer}
                windowService={this.windowService}
                workspaceService={this.workspaceService}
                dispatcher={this.dispatcher}
            />
        );
    }
}
