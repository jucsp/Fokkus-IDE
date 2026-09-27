/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { ApplicationShell, WidgetManager } from '@theia/core/lib/browser';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { PlaneIssue, PlaneServer } from '../common/plane-protocol';
import { FokkusChatWidget } from './fokkus-orchestrator-widget';
import { issueDescriptionToText, PlaneIssueDetail } from './plane-issue-detail';
import { PlaneKanbanService, PlaneKanbanSnapshot } from './plane-kanban-service';

export const PLANE_KANBAN_WIDGET_ID = 'fokkus-kanban-widget';

/** Construye el prompt que se envía a Fokkus Team al pulsar Play en una tarjeta del Kanban. */
export function buildDevelopPrompt(issue: PlaneIssue): string {
    // Sin punto final: la plantilla ya agrega uno (evita «1 clic..»).
    const description = issueDescriptionToText(issue.descriptionHtml).replace(/\.+$/, '') || 'Sin descripción';
    const head = issue.code ? `${issue.code} - ${issue.title}` : issue.title;
    return `Desarrolla la siguiente Historia de Usuario: ${head}. Descripción: ${description}.\n\n`
        + `INSTRUCCIÓN CRÍTICA: Debes desarrollar esta historia trabajando sí o sí con todo el resto del equipo del IDE (Swarm). `
        + `Asegúrate de delegar las tareas (a Claude y Deepseek V4 Pro según corresponda), respetar sus prompts y roles, `
        + `realizar pruebas de QA exhaustivas, y coordinar todo para asegurar que el trabajo se distribuya por todo el equipo `
        + `y se cumplan exitosamente todas las etapas del desarrollo.`;
}

interface KanbanColumn {
    id: string;
    name: string;
    color?: string;
    issues: PlaneIssue[];
}

interface PlaneKanbanBoardProps {
    snapshot: PlaneKanbanSnapshot;
    planeServer: PlaneServer;
    windowService: WindowService;
    onPlay: (issue: PlaneIssue) => void;
}

interface KanbanCardProps {
    issue: PlaneIssue;
    selected: boolean;
    onOpen: () => void;
    onPlay: (issue: PlaneIssue) => void;
}

function KanbanCard({ issue, selected, onOpen, onPlay }: KanbanCardProps): React.ReactElement {
    return (
        <article
            className={'fokkus-kanban-card' + (selected ? ' selected' : '')}
            role='button'
            tabIndex={0}
            onClick={onOpen}
            onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpen();
                }
            }}
        >
            <div className='fokkus-kanban-card-top'>
                {issue.code && <span className='fokkus-backlog-code'>{issue.code}</span>}
                <button
                    type='button'
                    className='fokkus-kanban-play'
                    title='Enviar a Fokkus Team'
                    aria-label='Enviar a Fokkus Team'
                    onClick={event => {
                        event.stopPropagation();
                        onPlay(issue);
                    }}
                >
                    <i className='fa fa-play' />
                </button>
            </div>
            <div className='fokkus-kanban-card-title'>{issue.title}</div>
            <div className='fokkus-kanban-card-meta'>{issue.estimate ?? '—'}</div>
        </article>
    );
}

function PlaneKanbanBoard({ snapshot, planeServer, windowService, onPlay }: PlaneKanbanBoardProps): React.ReactElement {
    const { project, states, issues, config } = snapshot;
    const [selectedIssueId, setSelectedIssueId] = React.useState<string | undefined>(undefined);
    const drawerRef = React.useRef<HTMLElement | undefined>(undefined);

    // Si la issue seleccionada desaparece del snapshot (nuevos filtros), se cierra el drawer.
    React.useEffect(() => {
        if (selectedIssueId && !issues.some(issue => issue.id === selectedIssueId)) {
            setSelectedIssueId(undefined);
        }
    }, [issues, selectedIssueId]);

    const columns = React.useMemo<KanbanColumn[]>(() => {
        const byState = new Map<string, PlaneIssue[]>();
        const unknown: PlaneIssue[] = [];
        for (const issue of issues) {
            const state = issue.stateId ? states.find(item => item.id === issue.stateId) : undefined;
            if (state) {
                const list = byState.get(state.id) ?? [];
                list.push(issue);
                byState.set(state.id, list);
            } else {
                unknown.push(issue);
            }
        }
        const result = states.map(state => ({
            id: state.id,
            name: state.name,
            color: state.color,
            issues: byState.get(state.id) ?? []
        }));
        if (unknown.length > 0) {
            result.push({ id: '__none__', name: 'Sin estado', color: undefined, issues: unknown });
        }
        return result;
    }, [issues, states]);

    const selectedIssue = issues.find(issue => issue.id === selectedIssueId);
    const selectedStateName = selectedIssue
        ? states.find(state => state.id === selectedIssue.stateId)?.name ?? 'Sin estado'
        : 'Sin estado';

    // Cierra el drawer al hacer clic fuera o al pulsar Escape. El clic sobre una tarjeta
    // solo cambia la selección (no cierra y reabre) para que el usuario no pierda contexto.
    React.useEffect(() => {
        if (!selectedIssueId) {
            return;
        }
        const handleMouseDown = (event: MouseEvent): void => {
            const target = event.target as HTMLElement | undefined;
            if (!target) {
                return;
            }
            if (drawerRef.current && drawerRef.current.contains(target)) {
                return;
            }
            if (target.closest('.fokkus-kanban-card')) {
                return;
            }
            setSelectedIssueId(undefined);
        };
        const handleKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                setSelectedIssueId(undefined);
            }
        };
        document.addEventListener('mousedown', handleMouseDown, true);
        document.addEventListener('keydown', handleKeyDown, true);
        return () => {
            document.removeEventListener('mousedown', handleMouseDown, true);
            document.removeEventListener('keydown', handleKeyDown, true);
        };
    }, [selectedIssueId]);

    if (!project) {
        return (
            <div className='fokkus-kanban-empty'>
                Selecciona un proyecto en el panel Backlog y aplica filtros
            </div>
        );
    }

    return (
        <div className='fokkus-kanban'>
            <div className='fokkus-kanban-board'>
                {columns.map(column => (
                    <section key={column.id} className='fokkus-kanban-column'>
                        <header className='fokkus-kanban-column-header'>
                            <span
                                className='fokkus-kanban-dot'
                                style={{ background: column.color || 'var(--theia-descriptionForeground)' }}
                            />
                            <span className='fokkus-kanban-column-name'>{column.name}</span>
                            <span className='fokkus-kanban-count'>{column.issues.length}</span>
                        </header>
                        <div className='fokkus-kanban-column-body'>
                            {column.issues.length === 0 ? (
                                <div className='fokkus-kanban-column-empty'>Sin issues</div>
                            ) : (
                                column.issues.map(issue => (
                                    <KanbanCard
                                        key={issue.id}
                                        issue={issue}
                                        selected={selectedIssueId === issue.id}
                                        onOpen={() => setSelectedIssueId(issue.id)}
                                        onPlay={onPlay}
                                    />
                                ))
                            )}
                        </div>
                    </section>
                ))}
            </div>
            {selectedIssue && (
                <aside
                    className='fokkus-kanban-drawer'
                    ref={element => { drawerRef.current = element ?? undefined; }}
                >
                    <header className='fokkus-kanban-drawer-header'>
                        {selectedIssue.code && <span className='fokkus-backlog-code'>{selectedIssue.code}</span>}
                        <button
                            type='button'
                            className='fokkus-kanban-play fokkus-kanban-play-labeled'
                            onClick={() => onPlay(selectedIssue)}
                        >
                            <i className='fa fa-play' /> Desarrollar
                        </button>
                        <button
                            type='button'
                            className='fokkus-kanban-drawer-close'
                            aria-label='Cerrar detalle'
                            onClick={() => setSelectedIssueId(undefined)}
                        >
                            ×
                        </button>
                    </header>
                    <h2 className='fokkus-kanban-drawer-title'>{selectedIssue.title}</h2>
                    <div className='fokkus-kanban-drawer-meta'>
                        <span>Estado: {selectedStateName}</span>
                        <span>Estimación: {selectedIssue.estimate ?? '—'}</span>
                    </div>
                    <PlaneIssueDetail
                        issue={selectedIssue}
                        config={config}
                        planeServer={planeServer}
                        windowService={windowService}
                    />
                </aside>
            )}
        </div>
    );
}

@injectable()
export class PlaneKanbanWidget extends ReactWidget {

    static readonly ID = PLANE_KANBAN_WIDGET_ID;
    static readonly LABEL = 'Kanban';

    @inject(PlaneKanbanService)
    protected readonly kanbanService: PlaneKanbanService;

    @inject(PlaneServer)
    protected readonly planeServer: PlaneServer;

    @inject(WindowService)
    protected readonly windowService: WindowService;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;

    @postConstruct()
    protected init(): void {
        this.id = PlaneKanbanWidget.ID;
        this.title.label = PlaneKanbanWidget.LABEL;
        this.title.caption = PlaneKanbanWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'fa fa-columns';
        this.toDispose.push(this.kanbanService.onDidChange(() => {
            this.updateTitle();
            this.update();
        }));
        this.updateTitle();
        this.update();
    }

    protected updateTitle(): void {
        const project = this.kanbanService.snapshot.project;
        this.title.label = project ? `Kanban · ${project.identifier}` : 'Kanban';
    }

    protected onPlayIssue(issue: PlaneIssue): void {
        this.playIssue(issue).catch(error => console.error('[fokkus-kanban] No se pudo enviar el issue a Fokkus Team', error));
    }

    /** Abre Fokkus Team en el panel izquierdo y le envía el prompt de desarrollo del issue. */
    protected async playIssue(issue: PlaneIssue): Promise<void> {
        const chat = await this.widgetManager.getOrCreateWidget<FokkusChatWidget>(FokkusChatWidget.ID);
        if (!chat.isAttached) {
            await this.shell.addWidget(chat, { area: 'left', rank: 100 });
        }
        await this.shell.activateWidget(chat.id);
        chat.sendPrompt(buildDevelopPrompt(issue));
    }

    protected render(): React.ReactNode {
        return (
            <PlaneKanbanBoard
                snapshot={this.kanbanService.snapshot}
                planeServer={this.planeServer}
                windowService={this.windowService}
                onPlay={issue => this.onPlayIssue(issue)}
            />
        );
    }
}
