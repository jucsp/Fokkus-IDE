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
    GitHubColumn,
    GitHubConfigStatus,
    GitHubIssue,
    GitHubLabel,
    GitHubMilestone,
    GitHubProject,
    GitHubRepo,
    GitHubServer,
    GitHubUser
} from '../common/github-protocol';
import { GitHubHtml } from './github-html';
import { GITHUB_KANBAN_OPEN_COMMAND_ID, GitHubIssuesService } from './github-issues-service';

export const GITHUB_ISSUES_WIDGET_ID = 'fokkus-github-issues-widget';

const FILTERS_STORAGE_KEY = 'fokkus.github.issues.filters';

interface SavedFilters {
    repo?: string;
    projectId?: string;
    state?: 'open' | 'closed' | 'all';
    assignee?: string;
    label?: string;
    milestone?: string;
}

/** Normaliza para búsqueda local: minúsculas y sin tildes. */
function normalizeForSearch(value: string): string {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function loadSavedFilters(): SavedFilters {
    try {
        const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
        if (!raw) {
            return {};
        }
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object') {
            return parsed as SavedFilters;
        }
        return {};
    } catch {
        localStorage.removeItem(FILTERS_STORAGE_KEY);
        return {};
    }
}

/** Elige un color de texto legible (blanco o casi negro) según la luminosidad del color de la etiqueta. */
function labelForeground(color?: string): string {
    if (!color || !/^[0-9a-fA-F]{6}$/.test(color)) {
        return '#ffffff';
    }
    const red = parseInt(color.slice(0, 2), 16);
    const green = parseInt(color.slice(2, 4), 16);
    const blue = parseInt(color.slice(4, 6), 16);
    const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
    return luminance > 0.6 ? '#111827' : '#ffffff';
}

function labelChipStyle(label: GitHubLabel): React.CSSProperties {
    return {
        backgroundColor: label.color ? `#${label.color}` : '#6b7280',
        color: labelForeground(label.color)
    };
}

interface GitHubIssuesAppProps {
    githubServer: GitHubServer;
    windowService: WindowService;
    workspaceService: WorkspaceService;
    kanbanService: GitHubIssuesService;
    commandService: CommandService;
}

function GitHubIssuesApp({ githubServer, windowService, workspaceService, kanbanService, commandService }: GitHubIssuesAppProps): React.ReactElement {
    const [config, setConfig] = React.useState<GitHubConfigStatus | undefined>(undefined);
    const [connectionOpen, setConnectionOpen] = React.useState<boolean>(true);

    const [tokenInput, setTokenInput] = React.useState<string>('');
    const [saving, setSaving] = React.useState<boolean>(false);
    const [saveError, setSaveError] = React.useState<string | undefined>(undefined);
    const [saveSuccess, setSaveSuccess] = React.useState<boolean>(false);

    const [repos, setRepos] = React.useState<GitHubRepo[]>([]);
    const [projects, setProjects] = React.useState<GitHubProject[]>([]);
    const [assignees, setAssignees] = React.useState<GitHubUser[]>([]);
    const [labels, setLabels] = React.useState<GitHubLabel[]>([]);
    const [milestones, setMilestones] = React.useState<GitHubMilestone[]>([]);
    const [bootstrapError, setBootstrapError] = React.useState<string | undefined>(undefined);

    const [repo, setRepo] = React.useState<string>('');
    const [projectId, setProjectId] = React.useState<string>('');
    const [stateFilter, setStateFilter] = React.useState<'open' | 'closed' | 'all'>('open');
    const [assignee, setAssignee] = React.useState<string>('');
    const [label, setLabel] = React.useState<string>('');
    const [milestone, setMilestone] = React.useState<string>('');

    const [issues, setIssues] = React.useState<GitHubIssue[]>([]);
    const [columns, setColumns] = React.useState<GitHubColumn[]>([]);
    const [issuesLoading, setIssuesLoading] = React.useState<boolean>(false);
    const [issuesError, setIssuesError] = React.useState<string | undefined>(undefined);
    const [searchQuery, setSearchQuery] = React.useState<string>('');

    const [expandedIssueId, setExpandedIssueId] = React.useState<string | undefined>(undefined);

    const applyIssues = React.useCallback(async (
        repoValue: string,
        stateValue: 'open' | 'closed' | 'all',
        assigneeValue: string,
        labelValue: string,
        milestoneValue: string,
        projectIdValue: string
    ): Promise<void> => {
        setIssuesLoading(true);
        setIssuesError(undefined);
        try {
            const milestoneNumber = milestoneValue ? Number(milestoneValue) : undefined;
            const result = await githubServer.listIssues({
                repo: repoValue,
                state: stateValue,
                assignee: assigneeValue || undefined,
                label: labelValue || undefined,
                milestone: milestoneNumber !== undefined && Number.isFinite(milestoneNumber) ? milestoneNumber : undefined,
                projectId: projectIdValue || undefined
            });
            setIssues(result.issues);
            setColumns(result.columns);
            setExpandedIssueId(undefined);
        } catch (error) {
            setIssuesError(error instanceof Error ? error.message : String(error));
            setIssues([]);
            setColumns([]);
        } finally {
            setIssuesLoading(false);
        }
    }, [githubServer]);

    // Carga inicial: config, repositorios, detección del repo del workspace y restauración de filtros.
    React.useEffect(() => {
        let cancelled = false;

        (async () => {
            try {
                const cfg = await githubServer.getConfig();
                if (cancelled) {
                    return;
                }

                setConfig(cfg);
                setConnectionOpen(!cfg.hasToken);
                if (!cfg.hasToken) {
                    return;
                }

                const saved = loadSavedFilters();
                let reposList: GitHubRepo[] = [];
                try {
                    reposList = await githubServer.listRepositories();
                    if (cancelled) {
                        return;
                    }
                    setRepos(reposList);

                    const roots = await workspaceService.roots;
                    const root = roots[0];
                    const detected = root ? await githubServer.detectRepository(root.resource.toString()) : undefined;
                    const savedRepo = typeof saved.repo === 'string' && reposList.some(item => item.fullName === saved.repo)
                        ? saved.repo
                        : undefined;
                    const initialRepo = savedRepo ?? detected ?? '';

                    setRepo(initialRepo);
                    setProjectId(typeof saved.projectId === 'string' ? saved.projectId : '');
                    const restoredState = saved.state === 'closed' || saved.state === 'all' ? saved.state : 'open';
                    setStateFilter(restoredState);
                    setAssignee(typeof saved.assignee === 'string' ? saved.assignee : '');
                    setLabel(typeof saved.label === 'string' ? saved.label : '');
                    setMilestone(typeof saved.milestone === 'string' ? saved.milestone : '');

                    if (initialRepo) {
                        await applyIssues(
                            initialRepo,
                            restoredState,
                            typeof saved.assignee === 'string' ? saved.assignee : '',
                            typeof saved.label === 'string' ? saved.label : '',
                            typeof saved.milestone === 'string' ? saved.milestone : '',
                            typeof saved.projectId === 'string' ? saved.projectId : ''
                        );
                    }
                } catch (error) {
                    if (!cancelled) {
                        setBootstrapError(error instanceof Error ? error.message : String(error));
                    }
                }
            } catch (error) {
                if (!cancelled) {
                    setBootstrapError(error instanceof Error ? error.message : String(error));
                }
            }
        })().catch(error => console.error('[fokkus-github-issues] Error al iniciar el panel', error));

        return () => {
            cancelled = true;
        };
    }, [githubServer, workspaceService, applyIssues]);

    // Recarga proyectos, assignees, labels y milestones cuando cambia el repositorio.
    React.useEffect(() => {
        if (!repo) {
            setProjects([]);
            setAssignees([]);
            setLabels([]);
            setMilestones([]);
            return;
        }

        let cancelled = false;
        setBootstrapError(undefined);
        Promise.all([
            // Los Projects v2 requieren el scope read:project: si falla, se sigue sin proyectos.
            githubServer.listProjects(repo).catch((): GitHubProject[] => []),
            githubServer.listAssignees(repo),
            githubServer.listLabels(repo),
            githubServer.listMilestones(repo)
        ])
            .then(([projectsList, assigneesList, labelsList, milestonesList]) => {
                if (!cancelled) {
                    setProjects(projectsList);
                    setAssignees(assigneesList);
                    setLabels(labelsList);
                    setMilestones(milestonesList);
                }
            })
            .catch(error => {
                if (!cancelled) {
                    setProjects([]);
                    setAssignees([]);
                    setLabels([]);
                    setMilestones([]);
                    setBootstrapError(error instanceof Error ? error.message : String(error));
                }
            });

        return () => {
            cancelled = true;
        };
    }, [githubServer, repo]);

    const handleSaveConfig = async (): Promise<void> => {
        setSaving(true);
        setSaveError(undefined);
        setSaveSuccess(false);
        try {
            const updated = await githubServer.saveConfig({ token: tokenInput.trim() || undefined });
            setConfig(updated);
            setTokenInput('');
            setSaveSuccess(true);
        } catch (error) {
            setSaveError(error instanceof Error ? error.message : String(error));
            setSaving(false);
            return;
        }
        // Recarga repositorios y preselecciona el del workspace. Si falla (token inválido),
        // la sección Conexión queda abierta y el error se muestra en Filtros.
        try {
            const reposList = await githubServer.listRepositories();
            setRepos(reposList);
            setBootstrapError(undefined);
            setConnectionOpen(false);

            const roots = await workspaceService.roots;
            const root = roots[0];
            const detected = root ? await githubServer.detectRepository(root.resource.toString()) : undefined;
            const initialRepo = detected ?? '';

            setRepo(initialRepo);
            setProjectId('');
            setStateFilter('open');
            setAssignee('');
            setLabel('');
            setMilestone('');
            localStorage.removeItem(FILTERS_STORAGE_KEY);

            if (initialRepo) {
                await applyIssues(initialRepo, 'open', '', '', '', '');
            }
        } catch (error) {
            setBootstrapError(error instanceof Error ? error.message : String(error));
        } finally {
            setSaving(false);
        }
    };

    const handleRepoChange = (value: string): void => {
        setRepo(value);
        setProjectId('');
        setAssignee('');
        setLabel('');
        setMilestone('');
        setExpandedIssueId(undefined);
    };

    const handleApplyFilters = async (): Promise<void> => {
        if (!repo) {
            setIssuesError('Selecciona un repositorio.');
            return;
        }
        localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify({
            repo,
            projectId,
            state: stateFilter,
            assignee,
            label,
            milestone
        }));
        await applyIssues(repo, stateFilter, assignee, label, milestone, projectId);
    };

    const handleToggleIssue = (id: string): void => {
        setExpandedIssueId(prev => prev === id ? undefined : id);
    };

    const canApply = Boolean(repo);

    // Filtro local (sin llamadas a la API) por código y título, sin distinguir mayúsculas ni tildes.
    const hasSearchQuery = searchQuery.trim().length > 0;
    const filteredIssues = React.useMemo(() => {
        const query = normalizeForSearch(searchQuery);
        if (!query) {
            return issues;
        }
        return issues.filter(issue =>
            normalizeForSearch(issue.code).includes(query) ||
            normalizeForSearch(issue.title).includes(query)
        );
    }, [issues, searchQuery]);

    // Publica el estado actual del panel para el tablero Kanban.
    React.useEffect(() => {
        kanbanService.publish({
            repo,
            project: projects.find(project => project.id === projectId),
            columns,
            issues: filteredIssues,
            config
        });
    }, [kanbanService, repo, projects, projectId, columns, filteredIssues, config]);

    return (
        <div className='fokkus-backlog'>
            {/* Conexión */}
            <section className='fokkus-backlog-section'>
                <button
                    type='button'
                    className='fokkus-backlog-section-header'
                    onClick={() => setConnectionOpen(open => !open)}
                    aria-expanded={connectionOpen}
                >
                    <span>Conexión</span>
                    <span className='fokkus-backlog-section-chevron'>{connectionOpen ? '▾' : '▸'}</span>
                </button>
                {connectionOpen && (
                    <div className='fokkus-backlog-section-body'>
                        <label className='fokkus-backlog-field'>
                            <span className='fokkus-backlog-label'>Token de GitHub</span>
                            <input
                                className='fokkus-backlog-input'
                                type='password'
                                value={tokenInput}
                                onChange={event => setTokenInput(event.target.value)}
                                placeholder={config?.hasToken ? '•••• guardado' : 'Pega tu token de GitHub'}
                            />
                        </label>
                        <button
                            type='button'
                            className='fokkus-backlog-apply'
                            onClick={handleSaveConfig}
                            disabled={saving || (!config?.hasToken && tokenInput.trim().length === 0)}
                        >
                            {saving ? 'Guardando…' : 'Guardar'}
                        </button>
                        {saveError && <div className='fokkus-backlog-error'>{saveError}</div>}
                        {saveSuccess && <div className='fokkus-backlog-success'>Configuración guardada.</div>}
                    </div>
                )}
            </section>

            {/* Filtros */}
            <section className='fokkus-backlog-section'>
                <div className='fokkus-backlog-section-header fokkus-backlog-section-header-static'>
                    <span>Filtros</span>
                </div>
                <div className='fokkus-backlog-section-body'>
                    <label className='fokkus-backlog-field'>
                        <span className='fokkus-backlog-label'>Repositorio</span>
                        <select
                            className='fokkus-backlog-input'
                            value={repo}
                            onChange={event => handleRepoChange(event.target.value)}
                            disabled={!config?.hasToken}
                        >
                            <option value='' disabled>Selecciona repositorio</option>
                            {repos.map(item => (
                                <option key={item.fullName} value={item.fullName}>{item.fullName}</option>
                            ))}
                        </select>
                    </label>
                    <label className='fokkus-backlog-field'>
                        <span className='fokkus-backlog-label'>Proyecto v2</span>
                        <select
                            className='fokkus-backlog-input'
                            value={projectId}
                            onChange={event => setProjectId(event.target.value)}
                            disabled={!repo}
                        >
                            <option value=''>Sin proyecto (todos los issues)</option>
                            {projects.map(project => (
                                <option key={project.id} value={project.id}>{project.title}</option>
                            ))}
                        </select>
                    </label>
                    <label className='fokkus-backlog-field'>
                        <span className='fokkus-backlog-label'>Estado</span>
                        <select
                            className='fokkus-backlog-input'
                            value={stateFilter}
                            onChange={event => setStateFilter(event.target.value as 'open' | 'closed' | 'all')}
                            disabled={!repo}
                        >
                            <option value='open'>Abiertos</option>
                            <option value='closed'>Cerrados</option>
                            <option value='all'>Todos</option>
                        </select>
                    </label>
                    <label className='fokkus-backlog-field'>
                        <span className='fokkus-backlog-label'>Asignado a</span>
                        <select
                            className='fokkus-backlog-input'
                            value={assignee}
                            onChange={event => setAssignee(event.target.value)}
                            disabled={!repo}
                        >
                            <option value=''>Todos los assignees</option>
                            {assignees.map(user => (
                                <option key={user.login} value={user.login}>{user.login}</option>
                            ))}
                        </select>
                    </label>
                    <label className='fokkus-backlog-field'>
                        <span className='fokkus-backlog-label'>Etiqueta</span>
                        <select
                            className='fokkus-backlog-input'
                            value={label}
                            onChange={event => setLabel(event.target.value)}
                            disabled={!repo}
                        >
                            <option value=''>Todas las etiquetas</option>
                            {labels.map(item => (
                                <option key={item.name} value={item.name}>{item.name}</option>
                            ))}
                        </select>
                    </label>
                    <label className='fokkus-backlog-field'>
                        <span className='fokkus-backlog-label'>Milestone</span>
                        <select
                            className='fokkus-backlog-input'
                            value={milestone}
                            onChange={event => setMilestone(event.target.value)}
                            disabled={!repo}
                        >
                            <option value=''>Todos los milestones</option>
                            {milestones.map(item => (
                                <option key={item.number} value={`${item.number}`}>{item.title}</option>
                            ))}
                        </select>
                    </label>
                    <button
                        type='button'
                        className='fokkus-backlog-apply'
                        onClick={handleApplyFilters}
                        disabled={!canApply}
                    >
                        Aplicar filtros
                    </button>
                    {bootstrapError && <div className='fokkus-backlog-error'>{bootstrapError}</div>}
                </div>
            </section>

            {/* Lista de issues */}
            <section className='fokkus-backlog-section'>
                <div className='fokkus-backlog-section-header fokkus-backlog-section-header-static'>
                    <span>Issues</span>
                    <span className='fokkus-backlog-header-actions'>
                        {issues.length > 0 && (
                            <span className='fokkus-backlog-count'>
                                {hasSearchQuery ? `${filteredIssues.length} / ${issues.length}` : issues.length}
                            </span>
                        )}
                        <button
                            type='button'
                            className='fokkus-backlog-icon-button'
                            title='Abrir Kanban'
                            aria-label='Abrir Kanban'
                            disabled={!repo}
                            onClick={() => {
                                commandService.executeCommand(GITHUB_KANBAN_OPEN_COMMAND_ID)
                                    .catch(error => console.error('[fokkus-github-issues] No se pudo abrir el Kanban', error));
                            }}
                        >
                            <i className='fa fa-columns' /> Kanban
                        </button>
                    </span>
                </div>
                <div className='fokkus-backlog-section-body fokkus-backlog-list'>
                    <input
                        className='fokkus-backlog-input'
                        type='search'
                        value={searchQuery}
                        onChange={event => setSearchQuery(event.target.value)}
                        placeholder='Buscar por código o título…'
                        disabled={issues.length === 0}
                        aria-label='Buscar issues'
                    />
                    {issuesLoading && <div className='fokkus-backlog-status'>Cargando issues…</div>}
                    {issuesError && <div className='fokkus-backlog-error'>{issuesError}</div>}
                    {!issuesLoading && !issuesError && issues.length === 0 && (
                        <div className='fokkus-backlog-status'>Sin issues para estos filtros</div>
                    )}
                    {!issuesLoading && !issuesError && issues.length > 0 && filteredIssues.length === 0 && (
                        <div className='fokkus-backlog-status'>Sin resultados para la búsqueda</div>
                    )}
                    {!issuesLoading && filteredIssues.map(issue => (
                        <article key={issue.id} className='fokkus-backlog-card'>
                            <button
                                type='button'
                                className='fokkus-backlog-card-header'
                                onClick={() => handleToggleIssue(issue.id)}
                                aria-expanded={expandedIssueId === issue.id}
                            >
                                <span className='fokkus-backlog-code'>{issue.code}</span>
                                <span className='fokkus-backlog-title'>{issue.title}</span>
                                <span className='fokkus-backlog-estimate'>{issue.state === 'open' ? 'Abierto' : 'Cerrado'}</span>
                            </button>
                            <div className='fokkus-github-issue-meta'>
                                {issue.labels.length > 0 && (
                                    <span className='fokkus-github-label-list'>
                                        {issue.labels.map(item => (
                                            <span
                                                key={item.name}
                                                className='fokkus-github-label-chip'
                                                style={labelChipStyle(item)}
                                            >
                                                {item.name}
                                            </span>
                                        ))}
                                    </span>
                                )}
                                {issue.assignees.length > 0 && (
                                    <span className='fokkus-github-assignees'>
                                        {issue.assignees.map(login => (
                                            <span key={login} className='fokkus-github-assignee'>{login}</span>
                                        ))}
                                    </span>
                                )}
                                <span>Autor: {issue.author}</span>
                            </div>
                            {expandedIssueId === issue.id && (
                                <div className='fokkus-github-issue-detail'>
                                    <GitHubHtml html={issue.bodyHtml} windowService={windowService} />
                                    <div className='fokkus-github-actions'>
                                        <button
                                            type='button'
                                            className='fokkus-backlog-icon-button'
                                            onClick={() => windowService.openNewWindow(issue.htmlUrl, { external: true })}
                                        >
                                            <i className='fa fa-external-link' /> Abrir en GitHub
                                        </button>
                                    </div>
                                </div>
                            )}
                        </article>
                    ))}
                </div>
            </section>
        </div>
    );
}

@injectable()
export class GitHubIssuesWidget extends ReactWidget {

    static readonly ID = GITHUB_ISSUES_WIDGET_ID;
    static readonly LABEL = 'GitHub Issues';

    @inject(GitHubServer)
    protected readonly githubServer: GitHubServer;

    @inject(WindowService)
    protected readonly windowService: WindowService;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @inject(GitHubIssuesService)
    protected readonly kanbanService: GitHubIssuesService;

    @inject(CommandService)
    protected readonly commandService: CommandService;

    @postConstruct()
    protected init(): void {
        this.id = GitHubIssuesWidget.ID;
        this.title.label = GitHubIssuesWidget.LABEL;
        this.title.caption = GitHubIssuesWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-github';
        this.update();
    }

    protected render(): React.ReactNode {
        return <GitHubIssuesApp
            githubServer={this.githubServer}
            windowService={this.windowService}
            workspaceService={this.workspaceService}
            kanbanService={this.kanbanService}
            commandService={this.commandService}
        />;
    }
}
