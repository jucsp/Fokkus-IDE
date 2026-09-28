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
import { GitHubIssue } from '../common/github-protocol';
import { FokkusChatDispatcher } from './fokkus-chat-dispatch';
import { GitHubHtml, htmlToPlainText } from './github-html';
import { GitHubIssuesService, GitHubIssuesSnapshot } from './github-issues-service';

export const GITHUB_KANBAN_WIDGET_ID = 'fokkus-github-kanban-widget';

/** Construye el prompt que se envía a Fokkus Team al pulsar Play en una tarjeta del Kanban. */
export function buildGitHubDevelopPrompt(issue: GitHubIssue, repo?: string): string {
    // Sin punto final: la plantilla ya agrega uno (evita «1 clic..»).
    const description = htmlToPlainText(issue.bodyHtml).replace(/\.+$/, '') || 'Sin descripción';
    const head = issue.code ? `${issue.code} - ${issue.title}` : issue.title;
    const repoReference = repo ? ` del repositorio ${repo}` : '';
    return `Desarrolla el siguiente Issue de GitHub${repoReference}: ${head}. Descripción: ${description}.\n\n`
        + 'INSTRUCCIÓN CRÍTICA: Debes desarrollar este issue trabajando sí o sí con todo el resto del equipo del IDE (Swarm). '
        + 'Asegúrate de delegar las tareas a los agentes designados según su rol, respetar sus prompts y áreas de especialidad, '
        + 'realizar pruebas de QA exhaustivas, y coordinar todo para asegurar que el trabajo se distribuya por todo el equipo '
        + 'y se cumplan exitosamente todas las etapas del desarrollo.';
}

interface KanbanColumn {
    id: string;
    name: string;
    color?: string;
    issues: GitHubIssue[];
}

interface GitHubKanbanBoardProps {
    snapshot: GitHubIssuesSnapshot;
    windowService: WindowService;
    onPlay: (issue: GitHubIssue) => void;
}

interface KanbanCardProps {
    issue: GitHubIssue;
    selected: boolean;
    onOpen: () => void;
    onPlay: (issue: GitHubIssue) => void;
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
                <span className='fokkus-backlog-code'>{issue.code}</span>
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
            <div className='fokkus-kanban-card-meta'>{issue.author}</div>
        </article>
    );
}

function GitHubKanbanBoard({ snapshot, windowService, onPlay }: GitHubKanbanBoardProps): React.ReactElement {
    const { repo, columns, issues } = snapshot;
    const [selectedIssueId, setSelectedIssueId] = React.useState<string | undefined>(undefined);
    const drawerRef = React.useRef<HTMLElement | undefined>(undefined);

    // Si el issue seleccionado desaparece del snapshot (nuevos filtros), se cierra el drawer.
    React.useEffect(() => {
        if (selectedIssueId && !issues.some(issue => issue.id === selectedIssueId)) {
            setSelectedIssueId(undefined);
        }
    }, [issues, selectedIssueId]);

    const boardColumns = React.useMemo<KanbanColumn[]>(() => {
        const byColumn = new Map<string, GitHubIssue[]>();
        const unknown: GitHubIssue[] = [];
        for (const issue of issues) {
            const column = issue.columnId ? columns.find(item => item.id === issue.columnId) : undefined;
            if (column) {
                const list = byColumn.get(column.id) ?? [];
                list.push(issue);
                byColumn.set(column.id, list);
            } else {
                unknown.push(issue);
            }
        }
        const result = columns.map(column => ({
            id: column.id,
            name: column.name,
            color: column.color,
            issues: byColumn.get(column.id) ?? []
        }));
        if (unknown.length > 0) {
            result.push({ id: '__none__', name: 'Sin columna', color: undefined, issues: unknown });
        }
        return result;
    }, [issues, columns]);

    const selectedIssue = issues.find(issue => issue.id === selectedIssueId);
    const selectedColumn = selectedIssue
        ? columns.find(column => column.id === selectedIssue.columnId)
        : undefined;
    const selectedColumnName = selectedColumn?.name ?? 'Sin columna';

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

    if (!repo) {
        return (
            <div className='fokkus-kanban-empty'>
                Selecciona un repositorio en el panel GitHub Issues y aplica filtros
            </div>
        );
    }

    return (
        <div className='fokkus-kanban'>
            <div className='fokkus-kanban-board'>
                {boardColumns.map(column => (
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
                        <span className='fokkus-backlog-code'>{selectedIssue.code}</span>
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
                        <span>Columna: {selectedColumnName}</span>
                        <span>Estado: {selectedIssue.state === 'open' ? 'Abierto' : 'Cerrado'}</span>
                        <span>Autor: {selectedIssue.author}</span>
                    </div>
                    <div className='fokkus-github-issue-detail'>
                        <GitHubHtml html={selectedIssue.bodyHtml} windowService={windowService} />
                        <div className='fokkus-github-actions'>
                            <button
                                type='button'
                                className='fokkus-backlog-icon-button'
                                onClick={() => windowService.openNewWindow(selectedIssue.htmlUrl, { external: true })}
                            >
                                <i className='fa fa-external-link' /> Abrir en GitHub
                            </button>
                        </div>
                    </div>
                </aside>
            )}
        </div>
    );
}

@injectable()
export class GitHubKanbanWidget extends ReactWidget {

    static readonly ID = GITHUB_KANBAN_WIDGET_ID;
    static readonly LABEL = 'GitHub Kanban';

    @inject(GitHubIssuesService)
    protected readonly kanbanService: GitHubIssuesService;

    @inject(WindowService)
    protected readonly windowService: WindowService;

    @inject(FokkusChatDispatcher)
    protected readonly dispatcher: FokkusChatDispatcher;

    @postConstruct()
    protected init(): void {
        this.id = GitHubKanbanWidget.ID;
        this.title.label = GitHubKanbanWidget.LABEL;
        this.title.caption = GitHubKanbanWidget.LABEL;
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
        const repo = this.kanbanService.snapshot.repo;
        this.title.label = repo ? `GitHub Kanban · ${repo}` : 'GitHub Kanban';
    }

    protected onPlayIssue(issue: GitHubIssue): void {
        this.playIssue(issue).catch(error => console.error('[fokkus-github-kanban] No se pudo enviar el issue a Fokkus Team', error));
    }

    /** Abre Fokkus Team en el panel izquierdo y le envía el prompt de desarrollo del issue. */
    protected async playIssue(issue: GitHubIssue): Promise<void> {
        await this.dispatcher.send(buildGitHubDevelopPrompt(issue, this.kanbanService.snapshot.repo));
    }

    protected render(): React.ReactNode {
        return (
            <GitHubKanbanBoard
                snapshot={this.kanbanService.snapshot}
                windowService={this.windowService}
                onPlay={issue => this.onPlayIssue(issue)}
            />
        );
    }
}
