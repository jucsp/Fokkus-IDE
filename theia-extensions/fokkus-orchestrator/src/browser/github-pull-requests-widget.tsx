/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { CommandService } from '@theia/core/lib/common/command';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { WorkspaceService } from '@theia/workspace/lib/browser';
import {
    GitHubConfigStatus,
    GitHubPullRequest,
    GitHubPullRequestFile,
    GitHubRepo,
    GitHubServer
} from '../common/github-protocol';
import { FokkusChatDispatcher } from './fokkus-chat-dispatch';
import { GitHubHtml, htmlToPlainText } from './github-html';

export const GITHUB_PULL_REQUESTS_WIDGET_ID = 'fokkus-github-pull-requests';

/** Lo registra la HU-3; aquí solo se invoca para abrir el panel de configuración del token. */
const GITHUB_PANEL_TOGGLE_COMMAND_ID = 'fokkus-github:toggle';

const REPO_OVERRIDE_KEY = 'fokkus.github.prs.repo';

/**
 * Valor centinela persistido para distinguir "todos los repositorios elegido por el
 * usuario" de "sin preferencia guardada". Ambos se traducen a filtro vacío (global),
 * pero solo el centinela se escribe en localStorage.
 */
const ALL_REPOS_SENTINEL = '__all__';

function storageKey(workspaceUri: string): string {
    return `${REPO_OVERRIDE_KEY}:${workspaceUri}`;
}

/** Clave estable de una tarjeta de PR: los números se repiten entre repos. */
function prKey(pr: GitHubPullRequest): string {
    return `${pr.repo}#${pr.number}`;
}

/** Normaliza para búsqueda local: minúsculas y sin tildes. */
function normalizeForSearch(value: string): string {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function prStateLabel(pr: GitHubPullRequest): string {
    if (pr.draft) {
        return 'Draft';
    }
    if (pr.state === 'merged') {
        return 'Merged';
    }
    if (pr.state === 'closed') {
        return 'Cerrado';
    }
    return 'Abierto';
}

function prStateTone(pr: GitHubPullRequest): string {
    if (pr.draft) {
        return 'draft';
    }
    if (pr.state === 'merged') {
        return 'merged';
    }
    if (pr.state === 'closed') {
        return 'closed';
    }
    return 'open';
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
 * Construye el prompt de code review del PR. Es agnóstico al proveedor de IA:
 * el chat de Fokkus Team decide con qué agentes ejecutarlo.
 */
export function buildPullRequestReviewPrompt(repo: string, pr: GitHubPullRequest, files: GitHubPullRequestFile[]): string {
    const description = htmlToPlainText(pr.bodyHtml).trim() || 'Sin descripción';
    const stateLabel = prStateLabel(pr);
    const fileLines = files.slice(0, 60).map(file => `- ${file.status} ${file.filename} (+${file.additions}/-${file.deletions})`);
    const more = files.length > 60 ? `\n- … y ${files.length - 60} archivos más` : '';
    const fileList = `${fileLines.join('\n')}${more}`;

    return `Revisa el Pull Request #${pr.number} del repositorio ${repo}: "${pr.title}".\n`
        + `Autor: ${pr.author}. Rama: ${pr.headRef} → ${pr.baseRef}. Estado: ${stateLabel}. URL: ${pr.htmlUrl}\n`
        + `Descripción: ${description}\n`
        + `Archivos modificados (${files.length}):\n${fileList}\n\n`
        + 'INSTRUCCIÓN: Obtén el diff completo del PR y realiza un code review exhaustivo: '
        + 'bugs y errores de lógica, seguridad, rendimiento, legibilidad y cobertura de pruebas.\n\n'
        + 'Cómo obtener el diff:\n'
        + '1) El entorno ya expone la variable $GITHUB_TOKEN con el token de la integración GitHub del IDE. '
        + 'Úsala siempre por referencia ("$GITHUB_TOKEN"): nunca imprimas, copies ni registres su valor.\n'
        + '2) Método preferido — diff por la API REST (sin git ni credenciales interactivas):\n'
        + '`curl -sSfL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github.v3.diff" '
        + `https://api.github.com/repos/${repo}/pulls/${pr.number}\`\n`
        + '3) Si el diff es demasiado grande (la API responde 406/422), usa la lista de archivos con sus parches:\n'
        + '`curl -sSfL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github+json" '
        + `"https://api.github.com/repos/${repo}/pulls/${pr.number}/files?per_page=100&page=1"\` `
        + '(paginando page=2, page=3, …).\n'
        + '4) Solo si necesitas el código completo: git fetch con el token embebido en la URL de esa única orden, '
        + 'sin añadir remotes ni guardarla en la config:\n'
        + `\`git -c credential.helper= fetch "https://x-access-token:$GITHUB_TOKEN@github.com/${repo}.git" `
        + `+refs/heads/${pr.baseRef}:refs/fokkus/pr-${pr.number}-base +refs/pull/${pr.number}/head:refs/fokkus/pr-${pr.number}\` `
        + `y luego \`git diff refs/fokkus/pr-${pr.number}-base...refs/fokkus/pr-${pr.number}\`.\n`
        + '5) Si $GITHUB_TOKEN está vacío, repite las mismas llamadas curl SIN la cabecera Authorization '
        + '(solo sirve para repos públicos). Nunca uses comandos que pidan usuario/contraseña de forma interactiva; '
        + 'si una orden pide credenciales, abórtala y usa la API.\n\n'
        + 'Entrega: '
        + '1) resumen del cambio, 2) hallazgos ordenados por severidad con archivo:línea y sugerencia concreta, '
        + '3) resumen de riesgos y recomendaciones. NO apruebes ni rechaces el PR: tu rol es solo revisar y dar feedback. '
        + 'No modifiques archivos, no hagas commits ni publiques comentarios en GitHub: entrega el feedback solo en este chat.';
}

interface GitHubPullRequestsAppProps {
    githubServer: GitHubServer;
    windowService: WindowService;
    workspaceService: WorkspaceService;
    dispatcher: FokkusChatDispatcher;
    commandService: CommandService;
}

function GitHubPullRequestsApp({ githubServer, windowService, workspaceService, dispatcher, commandService }: GitHubPullRequestsAppProps): React.ReactElement {
    const [config, setConfig] = React.useState<GitHubConfigStatus | undefined>(undefined);
    const [workspaceUri, setWorkspaceUri] = React.useState<string>('');
    const [repositories, setRepositories] = React.useState<GitHubRepo[]>([]);
    const [repoFilter, setRepoFilter] = React.useState<string>('');
    const [detecting, setDetecting] = React.useState<boolean>(false);
    const [repoError, setRepoError] = React.useState<string | undefined>(undefined);
    const [stateFilter, setStateFilter] = React.useState<'open' | 'closed' | 'all'>('open');
    const [prs, setPrs] = React.useState<GitHubPullRequest[]>([]);
    const [loading, setLoading] = React.useState<boolean>(false);
    const [error, setError] = React.useState<string | undefined>(undefined);
    const [reloadToken, setReloadToken] = React.useState<number>(0);
    const [searchQuery, setSearchQuery] = React.useState<string>('');
    const [expandedKey, setExpandedKey] = React.useState<string | undefined>(undefined);
    const [filesByPr, setFilesByPr] = React.useState<Record<string, GitHubPullRequestFile[]>>({});
    const [filesLoadingKey, setFilesLoadingKey] = React.useState<string | undefined>(undefined);
    const [filesError, setFilesError] = React.useState<string | undefined>(undefined);
    const [reviewError, setReviewError] = React.useState<string | undefined>(undefined);
    const [reviewingKey, setReviewingKey] = React.useState<string | undefined>(undefined);

    const hasToken = config?.hasToken === true;

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
        githubServer.getConfig()
            .then(cfg => {
                if (!cancelled) {
                    setConfig(cfg);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setConfig({ hasToken: false, tokenSource: 'none' });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [githubServer]);

    // Preferencia inicial del workspace.
    React.useEffect(() => {
        loadWorkspacePreference().catch(err => console.error('[fokkus-github-pr] No se pudo cargar la preferencia de workspace', err));
    }, [loadWorkspacePreference]);

    // Vuelve a leer la preferencia cuando cambia la raíz del workspace.
    React.useEffect(() => {
        const disposable = workspaceService.onWorkspaceChanged(() => {
            loadWorkspacePreference().catch(err => console.error('[fokkus-github-pr] No se pudo cargar la preferencia de workspace', err));
        });
        return () => disposable.dispose();
    }, [workspaceService, loadWorkspacePreference]);

    // Carga la lista de repositorios accesibles para el filtro.
    React.useEffect(() => {
        if (!hasToken) {
            setRepositories([]);
            return;
        }
        let cancelled = false;
        githubServer.listRepositories()
            .then(list => {
                if (!cancelled) {
                    setRepositories(list);
                }
            })
            .catch(err => {
                if (!cancelled) {
                    console.error('[fokkus-github-pr] No se pudieron listar los repositorios', err);
                    setRepositories([]);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [githubServer, hasToken]);

    // Recarga los PR: sin filtro → todos los abiertos de todos los repos; con filtro → PR del repo.
    React.useEffect(() => {
        if (!hasToken) {
            setPrs([]);
            setError(undefined);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(undefined);
        const request = repoFilter === ''
            ? githubServer.listOpenPullRequestsAllRepos()
            : githubServer.listPullRequests(repoFilter, stateFilter);
        request
            .then(list => {
                if (!cancelled) {
                    setPrs(list);
                    setExpandedKey(undefined);
                    setFilesByPr({});
                }
            })
            .catch(err => {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : String(err));
                    setPrs([]);
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
    }, [githubServer, hasToken, repoFilter, stateFilter, reloadToken]);

    // Carga perezosa de los archivos del PR expandido, usando pr.repo.
    React.useEffect(() => {
        if (!expandedKey || !hasToken) {
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
        githubServer.listPullRequestFiles(pr.repo, pr.number)
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
    }, [expandedKey, hasToken, prs, githubServer, filesByPr]);

    const handleRepoFilterChange = (value: string): void => {
        if (value === '') {
            // En modo global el estado se fija visualmente en "Abiertos".
            setStateFilter('open');
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
            const detected = root ? await githubServer.detectRepository(root.resource.toString()) : undefined;
            if (detected) {
                setRepoFilter(detected);
                localStorage.setItem(storageKey(workspaceUri), detected);
            } else {
                setRepoError('No se detectó un repositorio de GitHub en la carpeta abierta.');
            }
        } catch (err) {
            setRepoError(err instanceof Error ? err.message : String(err));
        } finally {
            setDetecting(false);
        }
    }, [githubServer, workspaceService, workspaceUri]);

    const handleOpenGithubPanel = (): void => {
        commandService.executeCommand(GITHUB_PANEL_TOGGLE_COMMAND_ID)
            .catch(err => console.error('[fokkus-github-pr] No se pudo abrir el panel GitHub', err));
    };

    const handleReview = async (pr: GitHubPullRequest): Promise<void> => {
        const key = prKey(pr);
        setReviewingKey(key);
        setReviewError(undefined);
        try {
            let files = filesByPr[key];
            if (!files) {
                files = await githubServer.listPullRequestFiles(pr.repo, pr.number);
                setFilesByPr(prev => ({ ...prev, [key]: files }));
            }
            await dispatcher.send(buildPullRequestReviewPrompt(pr.repo, pr, files));
        } catch (err) {
            setReviewError(err instanceof Error ? err.message : String(err));
        } finally {
            setReviewingKey(undefined);
        }
    };

    // Asegura que el repo seleccionado (detectado o persistido) aparezca como opción
    // aunque listRepositories no lo devuelva.
    const repoOptions = React.useMemo<GitHubRepo[]>(() => {
        if (!repoFilter || repositories.some(repo => repo.fullName === repoFilter)) {
            return repositories;
        }
        const [owner = '', repoName = ''] = repoFilter.split('/');
        return [...repositories, { fullName: repoFilter, owner, name: repoName, private: false }];
    }, [repositories, repoFilter]);

    const filteredPrs = React.useMemo(() => {
        const query = normalizeForSearch(searchQuery);
        if (!query) {
            return prs;
        }
        return prs.filter(pr =>
            normalizeForSearch(`#${pr.number}`).includes(query) ||
            normalizeForSearch(pr.title).includes(query) ||
            normalizeForSearch(pr.repo).includes(query)
        );
    }, [prs, searchQuery]);

    const isGlobalMode = repoFilter === '';

    return (
        <div className='fokkus-github-pr'>
            {config && !config.hasToken && (
                <div className='fokkus-github-token-warning'>
                    <span>Configura tu token de GitHub en el panel GitHub.</span>
                    <button type='button' className='fokkus-backlog-apply' onClick={handleOpenGithubPanel}>
                        Abrir panel
                    </button>
                </div>
            )}

            <div className='fokkus-github-repo-row'>
                <select
                    className='fokkus-backlog-input'
                    value={repoFilter}
                    onChange={event => handleRepoFilterChange(event.target.value)}
                    disabled={!hasToken}
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
                    onClick={() => handleDetect().catch(err => console.error('[fokkus-github-pr] No se pudo detectar el repositorio', err))}
                    disabled={detecting || !hasToken}
                >
                    Detectar
                </button>
            </div>
            {repoError && <div className='fokkus-backlog-error'>{repoError}</div>}

            <div className='fokkus-github-filters'>
                <select
                    className='fokkus-backlog-input'
                    value={isGlobalMode ? 'open' : stateFilter}
                    onChange={event => setStateFilter(event.target.value as 'open' | 'closed' | 'all')}
                    disabled={!hasToken || isGlobalMode}
                    aria-label='Estado'
                >
                    <option value='open'>Abiertos</option>
                    <option value='closed'>Cerrados</option>
                    <option value='all'>Todos</option>
                </select>
                <button
                    type='button'
                    className='fokkus-backlog-icon-button'
                    title='Refrescar'
                    aria-label='Refrescar'
                    onClick={() => setReloadToken(token => token + 1)}
                    disabled={loading || !hasToken}
                >
                    <i className='fa fa-refresh' />
                </button>
            </div>

            <input
                className='fokkus-backlog-input fokkus-github-search'
                type='search'
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                placeholder='Buscar por repo, número o título…'
                disabled={prs.length === 0}
                aria-label='Buscar pull requests'
            />

            {loading && <div className='fokkus-backlog-status'>Cargando pull requests…</div>}
            {error && <div className='fokkus-backlog-error'>{error}</div>}
            {!loading && !error && hasToken && prs.length === 0 && (
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
                            <span className='fokkus-backlog-code'>#{pr.number}</span>
                            <span className='fokkus-backlog-title'>{pr.title}</span>
                            <span className={`fokkus-github-badge fokkus-github-badge-${prStateTone(pr)}`}>{prStateLabel(pr)}</span>
                        </button>
                        <div className='fokkus-github-meta'>
                            {isGlobalMode && <span className='fokkus-github-repo'>{pr.repo} · </span>}
                            {pr.author} · {pr.headRef} → {pr.baseRef} · {formatRelativeDate(pr.updatedAt)}
                        </div>
                        {expanded && (
                            <div className='fokkus-github-detail'>
                                <GitHubHtml html={pr.bodyHtml} windowService={windowService} />
                                <div className='fokkus-github-files'>
                                    <div className='fokkus-github-files-title'>Archivos modificados</div>
                                    {filesLoading && <div className='fokkus-backlog-status'>Cargando archivos…</div>}
                                    {filesError && <div className='fokkus-backlog-error'>{filesError}</div>}
                                    {files && !filesLoading && (
                                        <ul className='fokkus-github-file-list'>
                                            {files.slice(0, 100).map(file => (
                                                <li key={file.filename} className='fokkus-github-file-item'>
                                                    <span className='fokkus-github-file-status'>{file.status}</span>
                                                    <span className='fokkus-github-file-name'>{file.filename}</span>
                                                    <span className='fokkus-github-file-diff'>
                                                        <span className='fokkus-github-adds'>+{file.additions}</span>
                                                        <span className='fokkus-github-dels'>-{file.deletions}</span>
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
                                        onClick={() => handleReview(pr).catch(err => console.error('[fokkus-github-pr] No se pudo enviar la revisión', err))}
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
                                        Abrir en GitHub
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
export class GitHubPullRequestsWidget extends ReactWidget {

    static readonly ID = GITHUB_PULL_REQUESTS_WIDGET_ID;
    static readonly LABEL = 'Pull Requests';

    @inject(GitHubServer)
    protected readonly githubServer: GitHubServer;

    @inject(WindowService)
    protected readonly windowService: WindowService;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(FokkusChatDispatcher)
    protected readonly dispatcher: FokkusChatDispatcher;

    @inject(CommandService)
    protected readonly commandService: CommandService;

    @postConstruct()
    protected init(): void {
        this.id = GitHubPullRequestsWidget.ID;
        this.title.label = GitHubPullRequestsWidget.LABEL;
        this.title.caption = GitHubPullRequestsWidget.LABEL;
        this.title.closable = false;
        this.title.iconClass = 'fa fa-code-fork';
        this.update();
    }

    protected render(): React.ReactNode {
        return (
            <GitHubPullRequestsApp
                githubServer={this.githubServer}
                windowService={this.windowService}
                workspaceService={this.workspaceService}
                dispatcher={this.dispatcher}
                commandService={this.commandService}
            />
        );
    }
}
