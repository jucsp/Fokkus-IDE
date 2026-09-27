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
import {
    PlaneConfigStatus,
    PlaneIssue,
    PlaneMember,
    PlaneModule,
    PlaneProject,
    PlaneServer,
    PlaneState
} from '../common/plane-protocol';
import { PlaneIssueDetail } from './plane-issue-detail';
import { PLANE_KANBAN_OPEN_COMMAND_ID, PlaneKanbanService } from './plane-kanban-service';

export const PLANE_BACKLOG_WIDGET_ID = 'fokkus-backlog-widget';

const FILTERS_STORAGE_KEY = 'fokkus.backlog.filters';

function memberOptionLabel(member: PlaneMember): string {
    const name = member.displayName || member.fullName || member.email || member.id;
    return member.email && name !== member.email ? `${name} <${member.email}>` : name;
}

function resolveMemberId(label: string, members: PlaneMember[]): string | undefined {
    const trimmed = (label || '').trim();
    if (!trimmed) {
        return undefined;
    }
    const member = members.find(item =>
        item.id === trimmed ||
        item.displayName === trimmed ||
        item.fullName === trimmed ||
        item.email === trimmed ||
        memberOptionLabel(item) === trimmed
    );
    return member?.id;
}

/** Normaliza para búsqueda local: minúsculas y sin tildes. */
function normalizeForSearch(value: string): string {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

interface PlaneBacklogAppProps {
    planeServer: PlaneServer;
    windowService: WindowService;
    kanbanService: PlaneKanbanService;
    commandService: CommandService;
}

function PlaneBacklogApp({ planeServer, windowService, kanbanService, commandService }: PlaneBacklogAppProps): React.ReactElement {
    const [config, setConfig] = React.useState<PlaneConfigStatus | undefined>(undefined);
    const [connectionOpen, setConnectionOpen] = React.useState<boolean>(true);

    const [baseUrlInput, setBaseUrlInput] = React.useState<string>('');
    const [workspaceInput, setWorkspaceInput] = React.useState<string>('');
    const [apiKeyInput, setApiKeyInput] = React.useState<string>('');
    const [saving, setSaving] = React.useState<boolean>(false);
    const [saveError, setSaveError] = React.useState<string | undefined>(undefined);
    const [saveSuccess, setSaveSuccess] = React.useState<boolean>(false);

    const [members, setMembers] = React.useState<PlaneMember[]>([]);
    const [projects, setProjects] = React.useState<PlaneProject[]>([]);
    const [modules, setModules] = React.useState<PlaneModule[]>([]);
    const [bootstrapError, setBootstrapError] = React.useState<string | undefined>(undefined);

    const [assigneeInput, setAssigneeInput] = React.useState<string>('');
    const [projectId, setProjectId] = React.useState<string>('');
    const [moduleId, setModuleId] = React.useState<string>('');
    const [stateId, setStateId] = React.useState<string>('');

    const [issues, setIssues] = React.useState<PlaneIssue[]>([]);
    const [issuesLoading, setIssuesLoading] = React.useState<boolean>(false);
    const [issuesError, setIssuesError] = React.useState<string | undefined>(undefined);
    const [searchQuery, setSearchQuery] = React.useState<string>('');
    const [modulesLoading, setModulesLoading] = React.useState<boolean>(false);
    const [states, setStates] = React.useState<PlaneState[]>([]);
    const [statesLoading, setStatesLoading] = React.useState<boolean>(false);

    const [expandedIssueId, setExpandedIssueId] = React.useState<string | undefined>(undefined);

    const applyIssues = React.useCallback(async (projectIdValue: string, assigneeIdValue: string, moduleIdValue: string, stateIdValue: string): Promise<void> => {
        setIssuesLoading(true);
        setIssuesError(undefined);
        try {
            const result = await planeServer.listIssues({
                projectId: projectIdValue,
                assigneeId: assigneeIdValue,
                moduleId: moduleIdValue || undefined,
                stateId: stateIdValue || undefined
            });
            setIssues(result);
            setExpandedIssueId(undefined);
        } catch (error) {
            setIssuesError(error instanceof Error ? error.message : String(error));
            setIssues([]);
        } finally {
            setIssuesLoading(false);
        }
    }, [planeServer]);

    // Carga inicial: config, miembros, proyectos y restauración de filtros.
    React.useEffect(() => {
        let cancelled = false;

        (async () => {
            try {
                const cfg = await planeServer.getConfig();
                if (cancelled) {
                    return;
                }

                setConfig(cfg);
                setBaseUrlInput(cfg.baseUrl);
                setWorkspaceInput(cfg.workspace);
                setConnectionOpen(!cfg.hasApiKey);

                // Miembros y proyectos pueden fallar si todavía no hay API Key configurada.
                let membersList: PlaneMember[] = [];
                let projectsList: PlaneProject[] = [];
                try {
                    const [membersResult, projectsResult] = await Promise.all([
                        planeServer.listMembers(),
                        planeServer.listProjects()
                    ]);
                    membersList = membersResult;
                    projectsList = projectsResult;
                    if (!cancelled) {
                        setMembers(membersList);
                        setProjects(projectsList);
                    }
                } catch (error) {
                    if (!cancelled) {
                        setBootstrapError(error instanceof Error ? error.message : String(error));
                    }
                }

                const saved = localStorage.getItem(FILTERS_STORAGE_KEY);
                if (saved) {
                    try {
                        const parsed = JSON.parse(saved) as { assigneeLabel?: string; projectId?: string; moduleId?: string; stateId?: string };
                        const savedAssignee = typeof parsed.assigneeLabel === 'string' ? parsed.assigneeLabel : '';
                        const savedProject = typeof parsed.projectId === 'string' ? parsed.projectId : '';
                        const savedModule = typeof parsed.moduleId === 'string' ? parsed.moduleId : '';
                        const savedState = typeof parsed.stateId === 'string' ? parsed.stateId : '';

                        setAssigneeInput(savedAssignee);
                        setProjectId(savedProject);
                        setModuleId(savedModule);
                        setStateId(savedState);

                        if (savedAssignee && savedProject) {
                            const memberId = resolveMemberId(savedAssignee, membersList);
                            if (memberId) {
                                await applyIssues(savedProject, memberId, savedModule, savedState);
                            }
                        }
                    } catch {
                        localStorage.removeItem(FILTERS_STORAGE_KEY);
                    }
                }
            } catch (error) {
                if (!cancelled) {
                    setBootstrapError(error instanceof Error ? error.message : String(error));
                }
            }
        })().catch(error => console.error('[fokkus-backlog] Error al iniciar el panel', error));

        return () => {
            cancelled = true;
        };
    }, [planeServer, applyIssues]);

    // Recarga los módulos cuando cambia el proyecto.
    React.useEffect(() => {
        if (!projectId) {
            setModules([]);
            return;
        }

        let cancelled = false;
        setModulesLoading(true);
        planeServer.listModules(projectId)
            .then(mods => {
                if (!cancelled) {
                    setModules(mods);
                }
            })
            .catch(error => {
                if (!cancelled) {
                    setModules([]);
                }
                console.error('[fokkus-backlog] No se pudieron cargar los módulos', error);
            })
            .finally(() => {
                if (!cancelled) {
                    setModulesLoading(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [projectId, planeServer]);

    // Recarga los estados cuando cambia el proyecto.
    React.useEffect(() => {
        if (!projectId) {
            setStates([]);
            return;
        }

        let cancelled = false;
        setStatesLoading(true);
        planeServer.listStates(projectId)
            .then(list => {
                if (!cancelled) {
                    setStates(list);
                }
            })
            .catch(error => {
                if (!cancelled) {
                    setStates([]);
                }
                console.error('[fokkus-backlog] No se pudieron cargar los estados', error);
            })
            .finally(() => {
                if (!cancelled) {
                    setStatesLoading(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [projectId, planeServer]);

    // Si el estado restaurado ya no existe en el proyecto, se limpia (solo con la lista ya cargada,
    // para no borrar el estado guardado mientras se descarga).
    React.useEffect(() => {
        if (statesLoading) {
            return;
        }
        if (stateId && states.length > 0 && !states.some(state => state.id === stateId)) {
            setStateId('');
        }
    }, [stateId, states, statesLoading]);

    const handleSaveConfig = async (): Promise<void> => {
        setSaving(true);
        setSaveError(undefined);
        setSaveSuccess(false);
        try {
            const updated = await planeServer.saveConfig({
                baseUrl: baseUrlInput.trim(),
                workspace: workspaceInput.trim(),
                apiKey: apiKeyInput || undefined
            });
            setConfig(updated);
            setBaseUrlInput(updated.baseUrl);
            setWorkspaceInput(updated.workspace);
            setApiKeyInput('');
            setSaveSuccess(true);
        } catch (error) {
            setSaveError(error instanceof Error ? error.message : String(error));
            setSaving(false);
            return;
        }
        // Recarga miembros y proyectos con la nueva configuración. Si falla (key inválida) la sección
        // Conexión queda abierta y el error se muestra en Filtros.
        try {
            const [membersList, projectsList] = await Promise.all([
                planeServer.listMembers(),
                planeServer.listProjects()
            ]);
            setMembers(membersList);
            setProjects(projectsList);
            setBootstrapError(undefined);
            setConnectionOpen(false);
        } catch (error) {
            setBootstrapError(error instanceof Error ? error.message : String(error));
        } finally {
            setSaving(false);
        }
    };

    const handleProjectChange = (value: string): void => {
        setProjectId(value);
        setModuleId('');
        setStateId('');
    };

    const handleApplyFilters = async (): Promise<void> => {
        const memberId = resolveMemberId(assigneeInput, members);
        if (!projectId || !memberId) {
            setIssuesError('Selecciona un usuario válido y un proyecto.');
            return;
        }
        localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify({
            assigneeLabel: assigneeInput,
            projectId,
            moduleId,
            stateId
        }));
        await applyIssues(projectId, memberId, moduleId, stateId);
    };

    const handleToggleIssue = (id: string): void => {
        setExpandedIssueId(prev => prev === id ? undefined : id);
    };

    const memberIdResolved = resolveMemberId(assigneeInput, members);
    const canApply = Boolean(projectId && memberIdResolved);

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

    // Publica el estado actual del Backlog para el tablero Kanban.
    React.useEffect(() => {
        kanbanService.publish({
            project: projects.find(project => project.id === projectId),
            states,
            issues: filteredIssues,
            config
        });
    }, [kanbanService, projects, projectId, states, filteredIssues, config]);

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
                            <span className='fokkus-backlog-label'>Base URL</span>
                            <input
                                className='fokkus-backlog-input'
                                type='text'
                                value={baseUrlInput}
                                onChange={event => setBaseUrlInput(event.target.value)}
                                placeholder='https://plane.garagelabs.cl'
                            />
                        </label>
                        <label className='fokkus-backlog-field'>
                            <span className='fokkus-backlog-label'>Workspace</span>
                            <input
                                className='fokkus-backlog-input'
                                type='text'
                                value={workspaceInput}
                                onChange={event => setWorkspaceInput(event.target.value)}
                                placeholder='garage-labs'
                            />
                        </label>
                        <label className='fokkus-backlog-field'>
                            <span className='fokkus-backlog-label'>API Key</span>
                            <input
                                className='fokkus-backlog-input'
                                type='password'
                                value={apiKeyInput}
                                onChange={event => setApiKeyInput(event.target.value)}
                                placeholder={config?.hasApiKey ? '•••• guardada' : 'Pega tu API Key'}
                            />
                        </label>
                        <button
                            type='button'
                            className='fokkus-backlog-apply'
                            onClick={handleSaveConfig}
                            disabled={saving}
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
                        <span className='fokkus-backlog-label'>Usuario</span>
                        <input
                            className='fokkus-backlog-input'
                            list='fokkus-backlog-members'
                            value={assigneeInput}
                            onChange={event => setAssigneeInput(event.target.value)}
                            placeholder='Buscar por nombre o correo'
                        />
                        <datalist id='fokkus-backlog-members'>
                            {members.map(member => (
                                <option key={member.id} value={memberOptionLabel(member)} />
                            ))}
                        </datalist>
                    </label>
                    <label className='fokkus-backlog-field'>
                        <span className='fokkus-backlog-label'>Proyecto</span>
                        <select
                            className='fokkus-backlog-input'
                            value={projectId}
                            onChange={event => handleProjectChange(event.target.value)}
                        >
                            <option value='' disabled>Selecciona proyecto</option>
                            {projects.map(project => (
                                <option key={project.id} value={project.id}>
                                    {project.identifier} — {project.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className='fokkus-backlog-field'>
                        <span className='fokkus-backlog-label'>Módulo</span>
                        <select
                            className='fokkus-backlog-input'
                            value={moduleId}
                            onChange={event => setModuleId(event.target.value)}
                            disabled={!projectId || modulesLoading}
                        >
                            <option value=''>Todos los módulos</option>
                            {modules.map(module => (
                                <option key={module.id} value={module.id}>{module.name}</option>
                            ))}
                        </select>
                    </label>
                    <label className='fokkus-backlog-field'>
                        <span className='fokkus-backlog-label'>Estado</span>
                        <select
                            className='fokkus-backlog-input'
                            value={stateId}
                            onChange={event => setStateId(event.target.value)}
                            disabled={!projectId || statesLoading}
                        >
                            <option value=''>Todos los estados</option>
                            {states.map(state => (
                                <option key={state.id} value={state.id}>{state.name}</option>
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
                            disabled={!projectId}
                            onClick={() => {
                                commandService.executeCommand(PLANE_KANBAN_OPEN_COMMAND_ID).catch(error => console.error('[fokkus-backlog] No se pudo abrir el Kanban', error));
                            }}
                        >
                            <i className='fa fa-columns' />
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
                                {issue.code && <span className='fokkus-backlog-code'>{issue.code}</span>}
                                <span className='fokkus-backlog-title'>{issue.title}</span>
                                <span className='fokkus-backlog-estimate'>{issue.estimate ? issue.estimate : '—'}</span>
                            </button>
                            {expandedIssueId === issue.id && (
                                <PlaneIssueDetail
                                    issue={issue}
                                    config={config}
                                    planeServer={planeServer}
                                    windowService={windowService}
                                />
                            )}
                        </article>
                    ))}
                </div>
            </section>
        </div>
    );
}

@injectable()
export class PlaneBacklogWidget extends ReactWidget {

    static readonly ID = PLANE_BACKLOG_WIDGET_ID;
    static readonly LABEL = 'Backlog';

    @inject(PlaneServer)
    protected readonly planeServer: PlaneServer;

    @inject(WindowService)
    protected readonly windowService: WindowService;

    @inject(PlaneKanbanService)
    protected readonly kanbanService: PlaneKanbanService;

    @inject(CommandService)
    protected readonly commandService: CommandService;

    @postConstruct()
    protected init(): void {
        this.id = PlaneBacklogWidget.ID;
        this.title.label = PlaneBacklogWidget.LABEL;
        this.title.caption = PlaneBacklogWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'fa fa-list-alt';
        this.update();
    }

    protected render(): React.ReactNode {
        return <PlaneBacklogApp
            planeServer={this.planeServer}
            windowService={this.windowService}
            kanbanService={this.kanbanService}
            commandService={this.commandService}
        />;
    }
}
