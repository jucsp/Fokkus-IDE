/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export const GitHubServerPath = '/services/fokkus-github';
export const GitHubServer = Symbol('GitHubServer');

export interface GitHubConfigStatus {
    hasToken: boolean;
    /** De dónde sale el token: variable de entorno, almacén seguro, ~/.fokkus/github.json o ninguno. */
    tokenSource: 'env' | 'secret-storage' | 'file' | 'none';
    /** Login del usuario autenticado (GET /user), si el token es válido. */
    login?: string;
}
export interface GitHubConfigInput {
    /** Vacío o undefined = conservar el token actual. */
    token?: string;
}
export interface GitHubRepo { fullName: string; owner: string; name: string; private: boolean; }
export interface GitHubUser { login: string; avatarUrl?: string; }
export interface GitHubLabel { name: string; color?: string; }
export interface GitHubMilestone { number: number; title: string; }
export interface GitHubProject { id: string; number: number; title: string; }
/** Columna del Kanban: opción del campo Status de un GitHub Project, o Abierto/Cerrado sin proyecto. */
export interface GitHubColumn { id: string; name: string; color?: string; }
export interface GitHubIssue {
    id: string;            // node_id
    number: number;
    code: string;          // `#<number>`
    title: string;
    state: 'open' | 'closed';
    bodyHtml: string;      // body_html de GitHub (sin sanitizar; el frontend sanitiza)
    htmlUrl: string;
    author: string;
    assignees: string[];
    labels: GitHubLabel[];
    milestone?: string;
    updatedAt: string;
    /** id de la GitHubColumn a la que pertenece. */
    columnId: string;
}
export interface GitHubIssueQuery {
    repo: string;                      // owner/name
    state: 'open' | 'closed' | 'all';
    assignee?: string;                 // login
    label?: string;
    milestone?: number;
    projectId?: string;                // node id de ProjectV2
}
export interface GitHubIssueResult { columns: GitHubColumn[]; issues: GitHubIssue[]; }
export interface GitHubPullRequest {
    number: number;
    /** Repositorio del PR en formato owner/name. */
    repo: string;
    title: string;
    state: 'open' | 'closed' | 'merged';
    draft: boolean;
    author: string;
    headRef: string;
    baseRef: string;
    htmlUrl: string;
    bodyHtml: string;
    createdAt: string;
    updatedAt: string;
}
export interface GitHubPullRequestFile { filename: string; status: string; additions: number; deletions: number; }
export interface GitHubServer {
    getConfig(): Promise<GitHubConfigStatus>;
    saveConfig(input: GitHubConfigInput): Promise<GitHubConfigStatus>;
    /** Lee `git remote get-url origin` del directorio dado (ruta de filesystem o URI file://) y devuelve `owner/name` si es de github.com. */
    detectRepository(workspaceRoot: string): Promise<string | undefined>;
    listRepositories(): Promise<GitHubRepo[]>;
    listAssignees(repo: string): Promise<GitHubUser[]>;
    listLabels(repo: string): Promise<GitHubLabel[]>;
    listMilestones(repo: string): Promise<GitHubMilestone[]>;
    listProjects(repo: string): Promise<GitHubProject[]>;
    listIssues(query: GitHubIssueQuery): Promise<GitHubIssueResult>;
    listPullRequests(repo: string, state: 'open' | 'closed' | 'all'): Promise<GitHubPullRequest[]>;
    /** PRs abiertos de todos los repositorios accesibles (hasta ALL_REPOS_MAX), ordenados por updatedAt desc. */
    listOpenPullRequestsAllRepos(): Promise<GitHubPullRequest[]>;
    listPullRequestFiles(repo: string, pullNumber: number): Promise<GitHubPullRequestFile[]>;
}
