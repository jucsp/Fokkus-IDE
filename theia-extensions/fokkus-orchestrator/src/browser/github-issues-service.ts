/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Emitter, Event } from '@theia/core/lib/common/event';
import { injectable } from '@theia/core/shared/inversify';
import {
    GitHubColumn,
    GitHubConfigStatus,
    GitHubIssue,
    GitHubProject
} from '../common/github-protocol';

export const GITHUB_KANBAN_OPEN_COMMAND_ID = 'fokkus-github-kanban:open';

/** Snapshot que el panel GitHub Issues publica para alimentar el tablero Kanban. */
export interface GitHubIssuesSnapshot {
    repo?: string;
    project?: GitHubProject;
    columns: GitHubColumn[];
    issues: GitHubIssue[];
    config?: GitHubConfigStatus;
}

/**
 * Singleton que guarda el último estado del panel de issues (repositorio, proyecto,
 * columnas, issues filtrados y config) y notifica a los suscriptores (el widget Kanban)
 * cada vez que cambia.
 */
@injectable()
export class GitHubIssuesService {

    protected readonly onDidChangeEmitter = new Emitter<GitHubIssuesSnapshot>();
    readonly onDidChange: Event<GitHubIssuesSnapshot> = this.onDidChangeEmitter.event;

    protected current: GitHubIssuesSnapshot = { columns: [], issues: [] };

    get snapshot(): GitHubIssuesSnapshot {
        return this.current;
    }

    publish(snapshot: GitHubIssuesSnapshot): void {
        this.current = snapshot;
        this.onDidChangeEmitter.fire(snapshot);
    }
}
