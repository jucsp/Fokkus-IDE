/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export const BitbucketServerPath = '/services/fokkus-bitbucket';
export const BitbucketServer = Symbol('BitbucketServer');

/** Integración SOLO LECTURA: el backend únicamente hace GET a api.bitbucket.org. */
export interface BitbucketConfigStatus {
    /** Existe el archivo de credenciales (`~/.bitbucket_credentials.env`). */
    hasCredentials: boolean;
    /** Usuario (`BITBUCKET_USERNAME`), si está definido. */
    username?: string;
    /** Hay app password (`BITBUCKET_USERNAME` + `BITBUCKET_APP_PASSWORD`). */
    hasAppPassword: boolean;
    /** Repos (`workspace/slug`) con un repository access token propio. Nunca incluye el token. */
    tokenRepositories: string[];
}
export interface BitbucketRepo {
    /** `workspace/slug`. */
    fullName: string;
    workspace: string;
    slug: string;
    /** Cómo se autentica: token del repo (Bearer) o app password (Basic). */
    auth: 'token' | 'app-password';
    /**
     * Nombre de la variable de entorno con la credencial (`BITBUCKET_TOKEN_<CLAVE>` o
     * `BITBUCKET_APP_PASSWORD`). Solo el NOMBRE, jamás el valor: se usa en el prompt de los agentes.
     */
    credentialVariable: string;
}
export type BitbucketPullRequestState = 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
export interface BitbucketPullRequest {
    id: number;
    /** `workspace/slug`. */
    repo: string;
    title: string;
    state: BitbucketPullRequestState;
    author: string;
    sourceBranch: string;
    destinationBranch: string;
    htmlUrl: string;
    /** `summary.html` de Bitbucket (sin sanitizar; el frontend sanitiza). */
    descriptionHtml: string;
    createdAt: string;
    updatedAt: string;
    commentCount: number;
}
export interface BitbucketPullRequestFile {
    /** Ruta nueva (o la antigua si el archivo se eliminó). */
    path: string;
    oldPath?: string;
    /** `added` | `removed` | `modified` | `renamed`. */
    status: string;
    linesAdded: number;
    linesRemoved: number;
}
/** Error de un repositorio concreto en la vista global (p. ej. 403 por workspace desactivado). */
export interface BitbucketRepoError {
    repo: string;
    status?: number;
    message: string;
}
export interface BitbucketAllPullRequestsResult {
    pullRequests: BitbucketPullRequest[];
    errors: BitbucketRepoError[];
}
export interface BitbucketServer {
    getConfig(): Promise<BitbucketConfigStatus>;
    /** Lee `git remote get-url origin` (ruta o URI file://) y devuelve `workspace/slug` si es de bitbucket.org. */
    detectRepository(workspaceRoot: string): Promise<string | undefined>;
    /** Repos con token + repos descubiertos con app password (si la hay). Ordenados por fullName. */
    listRepositories(): Promise<BitbucketRepo[]>;
    listPullRequests(repo: string, state: BitbucketPullRequestState | 'ALL'): Promise<BitbucketPullRequest[]>;
    /** PRs OPEN de todos los repos conocidos, ordenados por updatedAt desc, con los errores por repo. */
    listOpenPullRequestsAllRepos(): Promise<BitbucketAllPullRequestsResult>;
    listPullRequestFiles(repo: string, pullRequestId: number): Promise<BitbucketPullRequestFile[]>;
}
