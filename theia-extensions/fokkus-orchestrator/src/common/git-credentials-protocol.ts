/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Contrato de la sección «Fokkus › Integrations › Git Providers» de Preferencias (#22).
 *
 * Los secretos viajan SOLO del frontend al backend (save*). Ningún método devuelve un
 * token, un app password ni un fragmento de ellos: el estado solo informa si existen
 * y de dónde salen. El backend los guarda en el almacén de credenciales del sistema
 * operativo (KeyStoreService de Theia → keytar: Credential Manager en Windows,
 * Secret Service/libsecret en Linux, Keychain en macOS).
 */
export const GitCredentialsServerPath = '/services/fokkus-git-credentials';
export const GitCredentialsServer = Symbol('GitCredentialsServer');

/** Nombre del servicio en el almacén del sistema. Las cuentas están en GitCredentialAccounts. */
export const GIT_CREDENTIALS_KEYSTORE_SERVICE = 'fokkus-ide.git-providers';
export const GitCredentialAccounts = {
    githubToken: 'github.token',
    bitbucketUsername: 'bitbucket.username',
    bitbucketAppPassword: 'bitbucket.appPassword'
} as const;

/** Límite que el backend valida antes de guardar (el frontend lo usa como `maxLength`). */
export const GIT_CREDENTIAL_MAX_LENGTH = 2048;

/**
 * Dónde persisten los secretos:
 * - `os-keychain`: almacén del sistema operativo (persiste entre sesiones).
 * - `memory`: keytar no está disponible y Theia cayó a su proveedor en memoria;
 *   lo guardado se pierde al cerrar el IDE. La UI lo muestra como advertencia.
 */
export type GitCredentialsStorage = 'os-keychain' | 'memory';

/**
 * Origen efectivo de una credencial, en orden de precedencia:
 * `env` (variable del proceso) > `secret-storage` > `legacy-file` (~/.fokkus/github.json o
 * ~/.bitbucket_credentials.env) > `none`.
 */
export type GitCredentialSource = 'env' | 'secret-storage' | 'legacy-file' | 'none';

export interface GitHubCredentialsStatus {
    configured: boolean;
    source: GitCredentialSource;
    /** Hay un token guardado en el almacén, aunque el efectivo venga de `env`. */
    storedInSecretStorage: boolean;
}

export interface BitbucketCredentialsStatus {
    /** Hay usuario + app password efectivos. */
    configured: boolean;
    source: GitCredentialSource;
    storedInSecretStorage: boolean;
    /** El usuario no es secreto: se muestra para que el usuario sepa qué cuenta está activa. */
    username?: string;
    /** Repos con repository access token en ~/.bitbucket_credentials.env (siguen funcionando, solo informativo). */
    legacyTokenRepositories: string[];
}

export interface GitCredentialsStatus {
    storage: GitCredentialsStorage;
    github: GitHubCredentialsStatus;
    bitbucket: BitbucketCredentialsStatus;
    /** Hay credenciales en archivos planos que se pueden importar al almacén seguro. */
    legacyImportAvailable: boolean;
}

export interface GitHubCredentialsInput {
    /** Personal Access Token. Obligatorio y no vacío. */
    token: string;
}

export interface BitbucketCredentialsInput {
    /** Usuario de Bitbucket. Obligatorio y no vacío. */
    username: string;
    /** Vacío o undefined = conservar el app password guardado (permite cambiar solo el usuario). */
    appPassword?: string;
}

export type GitProviderId = 'github' | 'bitbucket';

export interface GitCredentialsTestResult {
    provider: GitProviderId;
    ok: boolean;
    /** Código HTTP de la API, si hubo respuesta. */
    status?: number;
    /** Login (GitHub) o username (Bitbucket) devuelto por la API cuando `ok`. */
    identity?: string;
    /** Mensaje legible en español. Nunca incluye el secreto. */
    message: string;
}

export interface GitCredentialsServer {
    getStatus(): Promise<GitCredentialsStatus>;
    saveGitHub(input: GitHubCredentialsInput): Promise<GitCredentialsStatus>;
    clearGitHub(): Promise<GitCredentialsStatus>;
    saveBitbucket(input: BitbucketCredentialsInput): Promise<GitCredentialsStatus>;
    clearBitbucket(): Promise<GitCredentialsStatus>;
    /** Prueba la credencial efectiva con un único GET (GitHub `/user`, Bitbucket `/2.0/user`). */
    testConnection(provider: GitProviderId): Promise<GitCredentialsTestResult>;
    /**
     * Copia al almacén seguro el token de ~/.fokkus/github.json y BITBUCKET_USERNAME /
     * BITBUCKET_APP_PASSWORD de ~/.bitbucket_credentials.env. No sobrescribe lo ya guardado.
     * Tras importar, elimina `token` de github.json; el .env de Bitbucket NO se modifica
     * (contiene tokens por repo que siguen en uso).
     */
    importLegacyCredentials(): Promise<GitCredentialsStatus>;
}
