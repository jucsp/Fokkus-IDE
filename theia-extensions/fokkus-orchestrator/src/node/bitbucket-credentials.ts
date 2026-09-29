/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { promises as fs } from 'fs';
import * as os from 'os';
import { join } from 'path';

/** Ruta del archivo de credenciales de Bitbucket (tipo dotenv). */
export const BITBUCKET_CREDENTIALS_PATH: string =
    process.env.FOKKUS_BITBUCKET_CREDENTIALS_FILE?.trim() || join(os.homedir(), '.bitbucket_credentials.env');

/** Credencial de un repositorio con su propio access token. */
export interface BitbucketRepoCredential {
    /** `workspace/slug`, en minúsculas. */
    fullName: string;
    workspace: string;
    slug: string;
    /** CLAVE que identifica la variable (`BITBUCKET_TOKEN_<CLAVE>`). */
    key: string;
    /** Nombre de la variable de entorno (`BITBUCKET_TOKEN_<CLAVE>`). */
    variable: string;
    token: string;
}

export interface BitbucketCredentials {
    /** TODAS las variables `BITBUCKET_*` del archivo (nombre -> valor). */
    variables: Record<string, string>;
    /** `BITBUCKET_USERNAME`, si está definido. */
    username?: string;
    /** `BITBUCKET_APP_PASSWORD`, si está definido. */
    appPassword?: string;
    /** Un elemento por cada `BITBUCKET_TOKEN_<CLAVE>` cuyo repo se pudo resolver. */
    repositories: BitbucketRepoCredential[];
}

const VARIABLE_RE = /^BITBUCKET_[A-Z0-9_]+$/;
const TOKEN_VARIABLE_RE = /^BITBUCKET_TOKEN_([A-Z0-9_]+)$/;
const REPO_VARIABLE_RE = /^BITBUCKET_REPO_([A-Z0-9_]+)$/;
const REPO_SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;
const REPO_COMMENT_RE = /^repositorio\s*:\s*([A-Za-z0-9_.-]+)\s*\(\s*([A-Za-z0-9_.-]+)\s*\)(?:\s.*)?$/i;

type ParsedLine = { kind: 'assignment'; key: string; value: string } | { kind: 'comment'; text: string };

interface RepoReference {
    workspace: string;
    slug: string;
}

function emptyCredentials(): BitbucketCredentials {
    return { variables: {}, repositories: [] };
}

/** Parsea una línea: admite prefijo `export`, comillas y comentario final (sin comillas). */
function parseLine(rawLine: string): ParsedLine | undefined {
    const line = rawLine.trim();
    if (!line) {
        return undefined;
    }
    if (line.startsWith('#')) {
        return { kind: 'comment', text: line.slice(1).trim() };
    }

    const assignment = line.replace(/^export\s+/, '');
    const eq = assignment.indexOf('=');
    if (eq <= 0) {
        return undefined;
    }

    const key = assignment.slice(0, eq).trim();
    let value = assignment.slice(eq + 1).trim();

    const quote = value[0];
    if (quote === '"' || quote === "'") {
        const end = value.indexOf(quote, 1);
        value = end >= 0 ? value.slice(1, end).trim() : value.slice(1).trim();
    } else {
        const commentStart = value.indexOf(' #');
        if (commentStart >= 0) {
            value = value.slice(0, commentStart).trim();
        }
    }

    return { kind: 'assignment', key, value };
}

/** Extrae `# Repositorio: <slug> (<workspace>)` de un comentario. */
function parseRepoComment(text: string): RepoReference | undefined {
    const match = text.match(REPO_COMMENT_RE);
    if (!match) {
        return undefined;
    }
    return { workspace: match[2].toLowerCase(), slug: match[1].toLowerCase() };
}

/** Normaliza `workspace/slug` y valida cada segmento. */
function normalizeRepoReference(raw: string): RepoReference | undefined {
    const parts = raw.trim().split('/');
    if (parts.length !== 2) {
        return undefined;
    }
    const [workspace, slug] = parts;
    if (!REPO_SEGMENT_RE.test(workspace) || !REPO_SEGMENT_RE.test(slug)) {
        return undefined;
    }
    return { workspace: workspace.toLowerCase(), slug: slug.toLowerCase() };
}

/** Parser PURA (sin IO) del archivo de credenciales de Bitbucket. */
export function parseBitbucketCredentials(content: string): BitbucketCredentials {
    const variables: Record<string, string> = {};
    const repoByKey = new Map<string, RepoReference>();
    const lines = content.split(/\r?\n/);

    // Primera pasada: variables + resolución prioritaria `BITBUCKET_REPO_<CLAVE>`.
    for (const rawLine of lines) {
        const parsed = parseLine(rawLine);
        if (!parsed || parsed.kind !== 'assignment') {
            continue;
        }
        if (!VARIABLE_RE.test(parsed.key)) {
            continue;
        }
        variables[parsed.key] = parsed.value;

        const repoMatch = parsed.key.match(REPO_VARIABLE_RE);
        if (repoMatch) {
            const normalized = normalizeRepoReference(parsed.value);
            if (normalized) {
                repoByKey.set(repoMatch[1], normalized);
            }
        }
    }

    // Segunda pasada: comentarios `# Repositorio: ...` asociados al siguiente token.
    const repositories: BitbucketRepoCredential[] = [];
    const seenFullNames = new Set<string>();
    let pendingComment: RepoReference | undefined;

    for (const rawLine of lines) {
        const parsed = parseLine(rawLine);
        if (!parsed) {
            continue;
        }
        if (parsed.kind === 'comment') {
            const repoComment = parseRepoComment(parsed.text);
            if (repoComment) {
                pendingComment = repoComment;
            }
            continue;
        }

        const tokenMatch = parsed.key.match(TOKEN_VARIABLE_RE);
        if (!tokenMatch) {
            continue;
        }

        const key = tokenMatch[1];
        const repo = repoByKey.get(key) ?? pendingComment;
        pendingComment = undefined;
        if (!repo) {
            continue;
        }

        const fullName = `${repo.workspace}/${repo.slug}`;
        if (seenFullNames.has(fullName)) {
            continue;
        }
        seenFullNames.add(fullName);
        repositories.push({
            fullName,
            workspace: repo.workspace,
            slug: repo.slug,
            key,
            variable: `BITBUCKET_TOKEN_${key}`,
            token: parsed.value
        });
    }

    const credentials: BitbucketCredentials = { variables, repositories };
    const username = variables.BITBUCKET_USERNAME;
    if (username) {
        credentials.username = username;
    }
    const appPassword = variables.BITBUCKET_APP_PASSWORD;
    if (appPassword) {
        credentials.appPassword = appPassword;
    }
    return credentials;
}

/**
 * Lee el archivo de credenciales. Si no existe devuelve `exists: false` con
 * credenciales vacías; cualquier otro error se propaga.
 */
export async function readBitbucketCredentials(path?: string): Promise<{ exists: boolean; credentials: BitbucketCredentials }> {
    const target = path ?? BITBUCKET_CREDENTIALS_PATH;
    try {
        const content = await fs.readFile(target, 'utf8');
        return { exists: true, credentials: parseBitbucketCredentials(content) };
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return { exists: false, credentials: emptyCredentials() };
        }
        throw err;
    }
}
