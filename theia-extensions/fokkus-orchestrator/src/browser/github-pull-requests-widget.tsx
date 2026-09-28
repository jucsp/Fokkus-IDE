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
    GitHubServer
} from '../common/github-protocol';
import { FokkusChatDispatcher } from './fokkus-chat-dispatch';
import { GitHubHtml, htmlToPlainText } from './github-html';

export const GITHUB_PULL_REQUESTS_WIDGET_ID = 'fokkus-github-pull-requests';

/** Lo registra la HU-3; aquí solo se invoca para abrir el panel de configuración del token. */
const GITHUB_PANEL_TOGGLE_COMMAND_ID = 'fokkus-github:toggle';

const REPO_OVERRIDE_KEY = 'fokkus.github.prs.repo';

function storageKey(workspaceUri: string): string {
    return `${REPO_OVERRIDE_KEY}:${workspaceUri}`;
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
        + `INSTRUCCIÓN: Obtén el diff completo del PR (por ejemplo \`git fetch origin pull/${pr.number}/head:fokkus-pr-${pr.number}\` `
        + `y \`git diff origin/${pr.baseRef}...fokkus-pr-${pr.number}\`) y realiza un code review exhaustivo: `
        + 'bugs y errores de lógica, seguridad, rendimiento, legibilidad y cobertura de pruebas. Entrega: '
        + '1) resumen del cambio, 2) hallazgos ordenados por severidad con archivo:línea y sugerencia concreta, '
        + '3) veredicto final (Aprobar / Solicitar cambios). No modifiques archivos, no hagas commits '
        + 'ni publiques comentarios en GitHub: entrega el feedback solo en este chat.';
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
    const [repo, setRepo] = React.useState<string>('');
    const [repoInput, setRepoInput] = React.useState<string>('');
    const [detecting, setDetecting] = React.useState<boolean>(false);
    const [repoError, setRepoError] = React.useState<string | undefined>(undefined);
    const [stateFilter, setStateFilter] = React.useState<'open' | 'closed' | 'all'>('open');
    const [prs, setPrs] = React.useState<GitHubPullRequest[]>([]);
    const [loading, setLoading] = React.useState<boolean>(false);
    const [error, setError] = React.useState<string | undefined>(undefined);
    const [reloadToken, setReloadToken] = React.useState<number>(0);
    const [searchQuery, setSearchQuery] = React.useState<string>('');
    const [expandedNumber, setExpandedNumber] = React.useState<number | undefined>(undefined);
    const [filesByPr, setFilesByPr] = React.useState<Record<number, GitHubPullRequestFile[]>>({});
    const [filesLoadingNumber, setFilesLoadingNumber] = React.useState<number | undefined>(undefined);
    const [filesError, setFilesError] = React.useState<string | undefined>(undefined);
    const [reviewError, setReviewError] = React.useState<string | undefined>(undefined);
    const [reviewingNumber, setReviewingNumber] = React.useState<number | undefined>(undefined);

    const refreshRepo = React.useCallback(async (forceDetect: boolean): Promise<void> => {
        await workspaceService.ready;
        const uri = workspaceService.workspace?.resource.toString() ?? 'no-workspace';
        setWorkspaceUri(uri);
        const key = storageKey(uri);
        if (forceDetect) {
            localStorage.removeItem(key);
        } else {
            const override = localStorage.getItem(key);
            if (override) {
                setRepo(override);
                setRepoInput(override);
                return;
            }
        }
        setDetecting(true);
        setRepoError(undefined);
        try {
            const roots = await workspaceService.roots;
            const root = roots[0];
            const detected = root ? await githubServer.detectRepository(root.resource.toString()) : undefined;
            setRepo(detected ?? '');
            setRepoInput(detected ?? '');
            if (!detected) {
                setRepoError('No se detectó un repositorio de GitHub en la carpeta abierta.');
            }
        } catch (err) {
            setRepoError(err instanceof Error ? err.message : String(err));
            setRepo('');
            setRepoInput('');
        } finally {
            setDetecting(false);
        }
    }, [githubServer, workspaceService]);

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

    // Detección inicial del repositorio.
    React.useEffect(() => {
        refreshRepo(false).catch(err => console.error('[fokkus-github-pr] No se pudo detectar el repositorio', err));
    }, [refreshRepo]);

    // Vuelve a detectar cuando cambia la raíz del workspace.
    React.useEffect(() => {
        const disposable = workspaceService.onWorkspaceChanged(() => {
            refreshRepo(false).catch(err => console.error('[fokkus-github-pr] No se pudo detectar el repositorio', err));
        });
        return () => disposable.dispose();
    }, [workspaceService, refreshRepo]);

    // Recarga los PR cuando cambian el repositorio, el filtro de estado o se fuerza refresco.
    React.useEffect(() => {
        if (!repo) {
            setPrs([]);
            setError(undefined);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(undefined);
        githubServer.listPullRequests(repo, stateFilter)
            .then(list => {
                if (!cancelled) {
                    setPrs(list);
                    setExpandedNumber(undefined);
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
    }, [githubServer, repo, stateFilter, reloadToken]);

    // Carga perezosa de los archivos del PR expandido.
    React.useEffect(() => {
        if (expandedNumber === undefined || !repo) {
            return;
        }
        if (filesByPr[expandedNumber]) {
            return;
        }
        let cancelled = false;
        setFilesLoadingNumber(expandedNumber);
        setFilesError(undefined);
        githubServer.listPullRequestFiles(repo, expandedNumber)
            .then(files => {
                if (!cancelled) {
                    setFilesByPr(prev => ({ ...prev, [expandedNumber]: files }));
                }
            })
            .catch(err => {
                if (!cancelled) {
                    setFilesError(err instanceof Error ? err.message : String(err));
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setFilesLoadingNumber(undefined);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [expandedNumber, repo, githubServer, filesByPr]);

    const handleRepoInputChange = (value: string): void => {
        setRepoInput(value);
    };

    const commitRepo = (): void => {
        const trimmed = repoInput.trim();
        if (!trimmed) {
            setRepo('');
            return;
        }
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(trimmed)) {
            setRepoError('Repositorio inválido, usa owner/nombre');
            return;
        }
        setRepoError(undefined);
        localStorage.setItem(storageKey(workspaceUri), trimmed);
        setRepo(trimmed);
    };

    const handleOpenGithubPanel = (): void => {
        commandService.executeCommand(GITHUB_PANEL_TOGGLE_COMMAND_ID)
            .catch(err => console.error('[fokkus-github-pr] No se pudo abrir el panel GitHub', err));
    };

    const handleReview = async (pr: GitHubPullRequest): Promise<void> => {
        setReviewingNumber(pr.number);
        setReviewError(undefined);
        try {
            let files = filesByPr[pr.number];
            if (!files) {
                files = await githubServer.listPullRequestFiles(repo, pr.number);
                setFilesByPr(prev => ({ ...prev, [pr.number]: files }));
            }
            await dispatcher.send(buildPullRequestReviewPrompt(repo, pr, files));
        } catch (err) {
            setReviewError(err instanceof Error ? err.message : String(err));
        } finally {
            setReviewingNumber(undefined);
        }
    };

    const filteredPrs = React.useMemo(() => {
        const query = normalizeForSearch(searchQuery);
        if (!query) {
            return prs;
        }
        return prs.filter(pr =>
            normalizeForSearch(`#${pr.number}`).includes(query) ||
            normalizeForSearch(pr.title).includes(query)
        );
    }, [prs, searchQuery]);

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
                <input
                    className='fokkus-backlog-input'
                    type='text'
                    value={repoInput}
                    onChange={event => handleRepoInputChange(event.target.value)}
                    onBlur={commitRepo}
                    onKeyDown={event => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            commitRepo();
                        }
                    }}
                    placeholder='owner/repo'
                    disabled={!config?.hasToken}
                    aria-label='Repositorio'
                />
                <button
                    type='button'
                    className='fokkus-github-detect-button'
                    onClick={() => refreshRepo(true).catch(err => console.error('[fokkus-github-pr] No se pudo detectar el repositorio', err))}
                    disabled={detecting || !config?.hasToken}
                >
                    Detectar
                </button>
            </div>
            {repoError && <div className='fokkus-backlog-error'>{repoError}</div>}

            <div className='fokkus-github-filters'>
                <select
                    className='fokkus-backlog-input'
                    value={stateFilter}
                    onChange={event => setStateFilter(event.target.value as 'open' | 'closed' | 'all')}
                    disabled={!config?.hasToken || !repo}
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
                    disabled={loading || !config?.hasToken || !repo}
                >
                    <i className='fa fa-refresh' />
                </button>
            </div>

            <input
                className='fokkus-backlog-input fokkus-github-search'
                type='search'
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                placeholder='Buscar por número o título…'
                disabled={prs.length === 0}
                aria-label='Buscar pull requests'
            />

            {loading && <div className='fokkus-backlog-status'>Cargando pull requests…</div>}
            {error && <div className='fokkus-backlog-error'>{error}</div>}
            {!loading && !error && repo && prs.length === 0 && (
                <div className='fokkus-backlog-status'>Sin pull requests</div>
            )}
            {!loading && !error && prs.length > 0 && filteredPrs.length === 0 && (
                <div className='fokkus-backlog-status'>Sin resultados para la búsqueda</div>
            )}
            {!loading && filteredPrs.map(pr => {
                const expanded = expandedNumber === pr.number;
                const files = filesByPr[pr.number];
                const filesLoading = filesLoadingNumber === pr.number;
                return (
                    <article key={pr.number} className='fokkus-backlog-card'>
                        <button
                            type='button'
                            className='fokkus-github-card-header'
                            onClick={() => setExpandedNumber(expanded ? undefined : pr.number)}
                            aria-expanded={expanded}
                        >
                            <span className='fokkus-backlog-code'>#{pr.number}</span>
                            <span className='fokkus-backlog-title'>{pr.title}</span>
                            <span className={`fokkus-github-badge fokkus-github-badge-${prStateTone(pr)}`}>{prStateLabel(pr)}</span>
                        </button>
                        <div className='fokkus-github-meta'>
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
                                        disabled={reviewingNumber === pr.number}
                                    >
                                        <i className='fa fa-magic' />
                                        {reviewingNumber === pr.number ? 'Enviando…' : 'Revisar con IA'}
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
