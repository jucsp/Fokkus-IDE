/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { RpcServer } from '@theia/core/lib/common/messaging/proxy-factory';

/**
 * Contrato de la Bandeja Pre-Kanban (Inbox / Triage) — Issue #26. CONGELADO: no cambiar sin avisar a QA.
 *
 * Flujo: el backend revisa Slack y Gmail cada TRIAGE_POLL_INTERVAL_MS, descarta ruido, agrupa por hilo,
 * clasifica en una de las 5 categorías y guarda cada solicitud como `pending`. Desde la bandeja el usuario
 * la edita y la aprueba hacia un destino agnóstico (Plane | Jira | GitHub Issues) o la descarta.
 *
 * Reglas:
 * - Los secretos (token de Slack, client secret y refresh token de Gmail, API token de Jira) viajan SOLO del
 *   frontend al backend (save*). Ningún método los devuelve, ni enteros ni en fragmentos.
 * - Slack y Gmail son de SOLO LECTURA para el sondeo: el backend nunca marca como leído ni modifica la bandeja.
 * - El único efecto externo es crear el ticket en el destino al aprobar (`approveItem`) y, a petición explícita
 *   del usuario, enviar la respuesta al cliente (`sendReply`, #29). Las reglas de auto-descarte (#28) no salen
 *   de la máquina: solo filtran el ruido entrante durante `upsertFromSource`.
 * - Todos los mensajes de error van en español y nunca incluyen un secreto.
 */
export const TriageServerPath = '/services/fokkus-triage';
export const TriageServer = Symbol('TriageServer');

/** Intervalo fijo del sondeo de fuentes (5 minutos). */
export const TRIAGE_POLL_INTERVAL_MS = 5 * 60 * 1000;

/** Límites que el backend valida en updateItem/approveItem (el frontend los usa como `maxLength`). */
export const TRIAGE_TITLE_MAX_LENGTH = 255;
export const TRIAGE_DESCRIPTION_MAX_LENGTH = 32000;
export const TRIAGE_DISCARD_REASON_MAX_LENGTH = 500;

/** Servicio del almacén del sistema operativo (keytar vía FokkusKeyStore) para los secretos de la bandeja. */
export const TRIAGE_KEYSTORE_SERVICE = 'fokkus-ide.triage';
export const TriageCredentialAccounts = {
    slackToken: 'slack.token',
    slackCookieD: 'slack.cookie_d',
    gmailClientSecret: 'gmail.clientSecret',
    gmailRefreshToken: 'gmail.refreshToken',
    jiraApiToken: 'jira.apiToken'
} as const;

// ---------------------------------------------------------------------------------------------
// Categorías
// ---------------------------------------------------------------------------------------------

export type TriageCategory =
    | 'support'
    | 'team-ticket'
    | 'client-query'
    | 'company-query'
    | 'general-client-query';

export interface TriageCategoryInfo {
    id: TriageCategory;
    label: string;
    /** Criterio de negocio: lo usa el clasificador del backend y se muestra como ayuda en la UI. */
    description: string;
}

/** Orden canónico (1–5) de las categorías. */
export const TRIAGE_CATEGORIES: readonly TriageCategoryInfo[] = [
    {
        id: 'support',
        label: 'Soporte',
        description: 'Algo dejó de funcionar o funciona mal: errores, caídas, incidentes, accesos bloqueados.'
    },
    {
        id: 'team-ticket',
        label: 'Creación de tickets del equipo',
        description: 'Un miembro del equipo interno pide registrar trabajo: tareas, bugs detectados, mejoras.'
    },
    {
        id: 'client-query',
        label: 'Consultas del cliente',
        description: 'Un cliente con proyecto activo pregunta o pide algo sobre SU proyecto (alcance, plazos, cambios).'
    },
    {
        id: 'company-query',
        label: 'Consultas desde la empresa',
        description: 'Áreas internas de la empresa (comercial, gerencia, administración) consultan o piden algo.'
    },
    {
        id: 'general-client-query',
        label: 'Consultas generales de clientes',
        description: 'Consultas de clientes o prospectos no ligadas a un proyecto concreto (cotizaciones, información).'
    }
];

// ---------------------------------------------------------------------------------------------
// Ítems de la bandeja
// ---------------------------------------------------------------------------------------------

export type TriageSource = 'slack' | 'gmail';
export type TriageItemStatus = 'pending' | 'approved' | 'discarded';

export interface TriageAuthor {
    /** Nombre visible (Slack real_name / display_name; Gmail nombre del From). */
    name: string;
    /** Email (Gmail siempre; Slack si el token tiene users:read.email). */
    email?: string;
    /** Id del usuario en Slack (`U…`). */
    slackUserId?: string;
}

/** Referencia al ticket creado en el destino al aprobar. */
export interface TriageTicketRef {
    provider: TargetProviderId;
    containerId: string;
    /** Clave legible: `PROJ-123` (Plane/Jira) o `owner/repo#45` (GitHub). */
    key: string;
    /** URL web del ticket para abrirlo en el navegador. */
    url: string;
}

export interface TriageApproval {
    ticket: TriageTicketRef;
    /** ISO 8601. */
    approvedAt: string;
}

export interface TriageItem {
    /** Id estable y único: `slack:<channelId>:<threadTs>` o `gmail:<threadId>`. */
    id: string;
    source: TriageSource;
    /** Canal de Slack (`#nombre`) o etiqueta/bandeja de Gmail. Informativo. */
    channel: string;
    author: TriageAuthor;
    /** ISO 8601 del primer mensaje del hilo. */
    receivedAt: string;
    /** ISO 8601 de la última actividad del hilo (crece si llegan respuestas). */
    lastActivityAt: string;
    /** Mensajes agrupados en este ítem (el hilo completo cuenta como una sola solicitud). */
    messageCount: number;
    /** Enlace al mensaje/hilo original (permalink de Slack o https://mail.google.com/...). */
    permalink?: string;
    /** Asunto del correo o primera línea del mensaje de Slack, tal como llegó. */
    originalSubject: string;
    /** Texto plano original del hilo (sin HTML), truncado a TRIAGE_DESCRIPTION_MAX_LENGTH. Solo lectura. */
    originalText: string;

    /** Editables antes de aprobar (updateItem). */
    title: string;
    description: string;
    category: TriageCategory;

    /** Categoría que propuso el clasificador y su confianza [0, 1]. */
    suggestedCategory: TriageCategory;
    confidence: number;
    /** Motivo breve de la clasificación (p. ej. «palabras clave: error, caído»). */
    classificationReason?: string;
    /** El usuario cambió título, descripción o categoría. */
    edited: boolean;

    status: TriageItemStatus;
    /** ISO 8601 del último cambio de estado o edición. */
    updatedAt: string;
    approval?: TriageApproval;
    discardReason?: string;
    /** true = el descarte lo aplicó el motor de aprendizaje (#28), no el usuario. */
    autoDiscarded?: boolean;
    /** Regla que disparó el auto-descarte (motivo original de la regla aprendida). */
    autoDiscardReason?: string;
    /** true = ya se envió la respuesta al solicitante (#29). */
    replySent?: boolean;
    /** ISO 8601 del envío de la respuesta. */
    replySentAt?: string;
    /** Cómo se entregó: publicada/enviada (`sent`) o dejada como borrador en Gmail (`draft`). */
    replyMode?: TriageReplyDeliveryMode;
    /** ISO 8601 de la última vez que el usuario copió la respuesta para enviarla a mano (no cuenta como enviada). */
    replyCopiedAt?: string;
    /** Último error al aprobar (el ítem sigue `pending`). Se limpia al aprobar con éxito. */
    lastError?: string;
}

export interface TriageItemQuery {
    /** undefined = todos los estados. */
    status?: TriageItemStatus;
    source?: TriageSource;
    category?: TriageCategory;
}

export interface TriageItemPatch {
    title?: string;
    description?: string;
    category?: TriageCategory;
}

// ---------------------------------------------------------------------------------------------
// Aprendizaje por descarte (#28)
// ---------------------------------------------------------------------------------------------

/**
 * Regla aprendida de un descarte con motivo. Al descartar un ítem con `reason`, el backend infiere
 * remitente/dominio y palabras clave del asunto/motivo; en los siguientes sondeos, todo candidato que
 * cumpla la regla se guarda directamente como `discarded` (`autoDiscarded: true`).
 */
export interface TriageFeedbackRule {
    id: string;
    /** ISO 8601. */
    createdAt: string;
    /** Motivo original que escribió el usuario al descartar. */
    reason: string;
    /** Email exacto del remitente, si se conoce (Gmail siempre; Slack si el token tiene users:read.email). */
    senderEmail?: string;
    /** Dominio del remitente (parte tras la `@`), si hay email. */
    senderDomain?: string;
    /** Palabras clave normalizadas (minúsculas, sin tildes) del asunto/motivo, separadas por espacio. */
    subjectPattern?: string;
    /** Veces que la regla auto-descartó un candidato entrante. */
    hits: number;
}

export const TRIAGE_FEEDBACK_RULE_ID_MAX = 80;
export const TRIAGE_FEEDBACK_RULE_SUBJECT_MAX = 300;

// ---------------------------------------------------------------------------------------------
// Destinos agnósticos (Plane | Jira | GitHub Issues)
// ---------------------------------------------------------------------------------------------

export type TargetProviderId = 'plane' | 'jira' | 'github';

export const TARGET_PROVIDER_LABELS: Record<TargetProviderId, string> = {
    plane: 'Plane',
    jira: 'Jira',
    github: 'GitHub Issues'
};

export interface TargetProviderStatus {
    id: TargetProviderId;
    label: string;
    /** Hay credenciales/config para crear tickets. */
    configured: boolean;
    /** Si no está configurado, dónde se configura (texto para la UI). */
    message?: string;
    /** Nombre del nivel 1 en la UI: «Proyecto» (Plane/Jira) o «Repositorio» (GitHub). */
    containerLabel: string;
}

/** Nivel 1 de la jerarquía: proyecto (Plane/Jira) o repositorio `owner/name` (GitHub). */
export interface TargetContainer {
    /** Plane: UUID del proyecto. Jira: id numérico del proyecto. GitHub: `owner/name`. */
    id: string;
    name: string;
    /** Identificador corto: `FOK` (Plane identifier / Jira key). GitHub: undefined. */
    key?: string;
}

/**
 * Tipos de nivel 2 (sub-contenedores / atributos) que un proveedor puede ofrecer:
 * - Plane: `state` (single), `module` (single), `label` (multiple).
 * - Jira: `issue-type` (single, requerido), `component` (multiple), `sprint` (single; sprints activos/futuros
 *   de los tableros del proyecto).
 * - GitHub: `label` (multiple), `milestone` (single).
 */
export type TargetOptionKind = 'state' | 'module' | 'label' | 'issue-type' | 'component' | 'sprint' | 'milestone';

export interface TargetOption {
    id: string;
    name: string;
    /** Color hex sin `#` (labels/estados), si el proveedor lo da. */
    color?: string;
    /** Texto secundario (p. ej. el tablero de un sprint, el grupo de un estado). */
    detail?: string;
}

export interface TargetOptionGroup {
    kind: TargetOptionKind;
    /** Etiqueta en español para la UI (p. ej. «Tipo de issue»). */
    label: string;
    /** true = selección múltiple (checkboxes); false = una sola (select). */
    multiple: boolean;
    /** true = approveItem falla si no se elige al menos una opción. */
    required: boolean;
    options: TargetOption[];
    /** Opción preseleccionada (p. ej. el estado por defecto del proyecto, el tipo «Task»). */
    defaultOptionId?: string;
}

/** Selección del usuario: kind → ids de opciones (un elemento si `multiple` es false). */
export type TargetSelections = Partial<Record<TargetOptionKind, string[]>>;

export interface TriageTarget {
    provider: TargetProviderId;
    containerId: string;
    selections: TargetSelections;
}

export interface TriageApproveInput {
    itemId: string;
    /** Valores finales; se guardan en el ítem igual que con updateItem. */
    title: string;
    description: string;
    category: TriageCategory;
    target: TriageTarget;
    /**
     * Añadir al final del ticket la referencia al origen (fuente, canal, autor, fecha, permalink).
     * Por defecto true. Nunca incluye el email del autor si la fuente es Slack.
     */
    includeSourceReference?: boolean;
}

export interface TriageApproveResult {
    item: TriageItem;
    ticket: TriageTicketRef;
}

// ---------------------------------------------------------------------------------------------
// Respuesta al cliente tras aprobar (#29)
// ---------------------------------------------------------------------------------------------

/** Borrador de respuesta generado por el backend tras crear el ticket. El usuario lo edita antes de enviar. */
export interface TriageReplyDraft {
    itemId: string;
    source: TriageSource;
    /** Gmail: email del solicitante. Slack: canal legible (p. ej. `#soporte`). */
    recipient: string;
    /** Gmail: `Re: <asunto original>`. Slack: informativo (el envío usa el hilo). */
    subject: string;
    /** Cuerpo propuesto en español profesional (saludo, ticket, enlace y curso del requerimiento). */
    body: string;
    /** Clave legible del ticket (`MEL-32` / `owner/repo#45`). */
    ticketKey: string;
    /** URL web del ticket. */
    ticketUrl: string;
}

/**
 * `send`: el backend publica en el hilo de Slack o envía por Gmail (o deja un borrador si falta el scope).
 * `clipboard`: el usuario copió el texto para enviarlo a mano; solo se registra `replyCopiedAt`, sin efecto externo.
 */
export type TriageSendReplyMode = 'send' | 'clipboard';

/** Resultado de la entrega: `clipboard` = no se pudo entregar y el usuario debe copiar y enviar a mano. */
export type TriageReplyDeliveryMode = 'sent' | 'draft' | 'clipboard';

export interface TriageSendReplyInput {
    itemId: string;
    /** Texto final (ya editado/validado por el usuario). */
    body: string;
    /** Asunto editado (solo Gmail). Vacío u omitido = `Re: <asunto original>`. */
    subject?: string;
    /** Por defecto `send`. */
    mode?: TriageSendReplyMode;
}

export interface TriageSendReplyResult {
    ok: boolean;
    /** Cómo terminó la entrega. Con `ok: false` y `clipboard`, la UI copia el texto al portapapeles. */
    mode: TriageReplyDeliveryMode;
    /** Texto legible en español. Nunca incluye un secreto. */
    message?: string;
    /** Si `ok` es false, motivo legible. */
    error?: string;
}

export const TRIAGE_REPLY_BODY_MAX_LENGTH = 10000;
export const TRIAGE_REPLY_SUBJECT_MAX_LENGTH = 300;

// ---------------------------------------------------------------------------------------------
// Configuración de fuentes (Slack, Gmail) y de Jira
// ---------------------------------------------------------------------------------------------

/** Origen efectivo de un secreto: variable de entorno > almacén del sistema > ninguno. */
export type TriageSecretSource = 'env' | 'secret-storage' | 'none';

export interface SlackSourceConfigStatus {
    enabled: boolean;
    /** Hay token efectivo y al menos un canal. */
    configured: boolean;
    tokenSource: TriageSecretSource;
    /** Origen de la cookie `d` de sesión web, si hay una. */
    cookieDSource?: TriageSecretSource;
    /** `session` si el token empieza por `xoxc-` o hay cookie `d`; si no, `bot`. */
    authMode?: 'session' | 'bot';
    /** Ids de canal (`C…`/`G…`) a revisar. */
    channelIds: string[];
    /** Nombre del workspace (auth.test), si el token es válido. */
    teamName?: string;
}

export interface SlackSourceConfigInput {
    enabled: boolean;
    /** Bot/User/Sesión token (`xoxb-`/`xoxp-`/`xoxc-`). Vacío o undefined = conservar el guardado. */
    token?: string;
    /** Cookie `d` de sesión web (`xoxd-`), necesaria con un token `xoxc-`. */
    cookieD?: string;
    channelIds: string[];
}

export interface GmailSourceConfigStatus {
    enabled: boolean;
    /** Hay client id + client secret + refresh token efectivos. */
    configured: boolean;
    clientId: string;
    clientSecretSource: TriageSecretSource;
    refreshTokenSource: TriageSecretSource;
    /** Búsqueda de Gmail que define qué correos entran (sintaxis del buscador de Gmail). */
    query: string;
    /** Email de la cuenta (users/me/profile), si las credenciales son válidas. */
    account?: string;
}

export interface GmailSourceConfigInput {
    enabled: boolean;
    clientId: string;
    /** Vacío o undefined = conservar el guardado. */
    clientSecret?: string;
    /** Vacío o undefined = conservar el guardado. */
    refreshToken?: string;
    /** Vacío = TRIAGE_DEFAULT_GMAIL_QUERY. */
    query?: string;
    /** JSON de credenciales OAuth de Google Workspace (client_secret.json o exportado con refresh_token). */
    credentialsJson?: string;
}

export const TRIAGE_DEFAULT_GMAIL_QUERY = 'in:inbox -category:promotions -category:social newer_than:2d';

export interface JiraConfigStatus {
    configured: boolean;
    /** https://<sitio>.atlassian.net (o Jira Data Center por HTTPS). */
    baseUrl: string;
    email: string;
    apiTokenSource: TriageSecretSource;
    /** displayName de /rest/api/3/myself, si las credenciales son válidas. */
    accountName?: string;
}

export interface JiraConfigInput {
    baseUrl: string;
    email: string;
    /** Vacío o undefined = conservar el guardado. */
    apiToken?: string;
}

export interface TriageConfigStatus {
    /** 'memory' = keytar no disponible: los secretos guardados se pierden al cerrar el IDE. */
    storage: 'os-keychain' | 'memory';
    slack: SlackSourceConfigStatus;
    gmail: GmailSourceConfigStatus;
    jira: JiraConfigStatus;
}

export interface TriageConnectionTestResult {
    target: TriageSource | TargetProviderId;
    ok: boolean;
    status?: number;
    /** Workspace de Slack, email de Gmail, usuario de Jira/GitHub o workspace de Plane. */
    identity?: string;
    /** Mensaje legible en español. Nunca incluye un secreto. */
    message: string;
}

// ---------------------------------------------------------------------------------------------
// Sondeo y estado
// ---------------------------------------------------------------------------------------------

export interface TriageSourcePollResult {
    source: TriageSource;
    ok: boolean;
    /** Mensajes/hilos leídos de la API en esta pasada. */
    fetched: number;
    /** Ítems nuevos creados. */
    created: number;
    /** Ítems existentes actualizados (respuestas nuevas en el hilo). */
    updated: number;
    /** Descartados como ruido (bots, automáticos, demasiado cortos, duplicados). */
    ignored: number;
    error?: string;
}

export interface TriagePollResult {
    startedAt: string;
    finishedAt: string;
    sources: TriageSourcePollResult[];
}

export interface TriagePollingStatus {
    enabled: boolean;
    intervalMs: number;
    running: boolean;
    lastRunAt?: string;
    nextRunAt?: string;
    lastResult?: TriagePollResult;
}

export type TriageCounts = Record<TriageItemStatus, number>;

export interface TriageStatus {
    polling: TriagePollingStatus;
    counts: TriageCounts;
}

// ---------------------------------------------------------------------------------------------
// Eventos backend → frontend
// ---------------------------------------------------------------------------------------------

export type TriageEvent =
    /** Llegaron solicitudes nuevas (solo las creadas en esta pasada, no las actualizadas). */
    | { kind: 'items-detected'; items: TriageItem[]; counts: TriageCounts }
    /** Un ítem cambió (edición, aprobación, descarte, restauración o respuesta nueva en el hilo). */
    | { kind: 'item-updated'; item: TriageItem; counts: TriageCounts }
    /** Empezó o terminó un sondeo, o se activó/desactivó. */
    | { kind: 'polling-changed'; polling: TriagePollingStatus };

/** Lo implementa el frontend. El backend lo llama para TODAS las ventanas conectadas. */
export interface TriageClient {
    onTriageEvent(event: TriageEvent): void;
}

// ---------------------------------------------------------------------------------------------
// Servicio RPC
// ---------------------------------------------------------------------------------------------

export interface TriageServer extends RpcServer<TriageClient> {
    getStatus(): Promise<TriageStatus>;
    /** Ordenados por lastActivityAt desc. */
    listItems(query?: TriageItemQuery): Promise<TriageItem[]>;
    /** Solo ítems `pending`. Valida longitudes y categoría. */
    updateItem(itemId: string, patch: TriageItemPatch): Promise<TriageItem>;
    /** pending → discarded. */
    discardItem(itemId: string, reason?: string): Promise<TriageItem>;
    /** discarded → pending. */
    restoreItem(itemId: string): Promise<TriageItem>;

    /** Sondea ahora las fuentes habilitadas. Si ya hay un sondeo en curso, espera ese y devuelve su resultado. */
    pollNow(): Promise<TriagePollResult>;
    setPollingEnabled(enabled: boolean): Promise<TriageStatus>;

    getConfig(): Promise<TriageConfigStatus>;
    saveSlackConfig(input: SlackSourceConfigInput): Promise<TriageConfigStatus>;
    clearSlackConfig(): Promise<TriageConfigStatus>;
    saveGmailConfig(input: GmailSourceConfigInput): Promise<TriageConfigStatus>;
    clearGmailConfig(): Promise<TriageConfigStatus>;
    saveJiraConfig(input: JiraConfigInput): Promise<TriageConfigStatus>;
    clearJiraConfig(): Promise<TriageConfigStatus>;
    /** Prueba con un único GET la fuente o el destino indicado. */
    testConnection(target: TriageSource | TargetProviderId): Promise<TriageConnectionTestResult>;

    listTargetProviders(): Promise<TargetProviderStatus[]>;
    listTargetContainers(provider: TargetProviderId): Promise<TargetContainer[]>;
    listTargetOptions(provider: TargetProviderId, containerId: string): Promise<TargetOptionGroup[]>;
    /**
     * Crea el ticket en el destino y marca el ítem `approved`. Idempotente por ítem: mientras una aprobación
     * está en curso, otra llamada para el mismo ítem falla con «La solicitud ya se está aprobando».
     * Si el destino falla, el ítem sigue `pending` con `lastError` y se relanza el error.
     */
    approveItem(input: TriageApproveInput): Promise<TriageApproveResult>;

    /** Reglas de auto-descarte aprendidas, más recientes primero (#28). */
    getFeedbackRules(): Promise<TriageFeedbackRule[]>;
    /** Elimina una regla aprendida (los ítems ya auto-descartados no se restauran). */
    deleteFeedbackRule(ruleId: string): Promise<void>;

    /** Borrador de respuesta para un ítem aprobado con ticket (#29). */
    getReplyDraft(itemId: string): Promise<TriageReplyDraft>;
    /**
     * Envía la respuesta final al solicitante y marca el ítem `replySent` (#29). Con `mode: 'clipboard'` solo
     * registra que el usuario la copió. Si Gmail no permite enviar ni dejar borrador, devuelve `ok: false` y el
     * ítem NO queda marcado como respondido.
     */
    sendReply(input: TriageSendReplyInput): Promise<TriageSendReplyResult>;
}
