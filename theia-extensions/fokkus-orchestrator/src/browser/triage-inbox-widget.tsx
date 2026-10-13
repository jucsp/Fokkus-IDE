/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from '@theia/core/shared/react';
import { ConfirmDialog } from '@theia/core/lib/browser';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import {
    TARGET_PROVIDER_LABELS,
    TargetOptionGroup,
    TargetProviderStatus,
    TRIAGE_CATEGORIES,
    TRIAGE_DESCRIPTION_MAX_LENGTH,
    TRIAGE_DISCARD_REASON_MAX_LENGTH,
    TRIAGE_TITLE_MAX_LENGTH,
    TriageCategory,
    TriageCounts,
    TriageItem,
    TriageItemQuery,
    TriageItemStatus,
    TriagePollingStatus,
    TriageServer,
    TriageSource
} from '../common/triage-protocol';
import { TriageConfigPanel } from './triage-config-panel';
import { TriageClientImpl, triageErrorMessage, withTriageTimeout } from './triage-service';
import { EMPTY_TARGET_DRAFT, missingRequiredGroups, TargetCache, TargetDraft, TriageTargetPicker } from './triage-target-picker';

export const TRIAGE_INBOX_WIDGET_ID = 'fokkus-triage-inbox-widget';

const FILTERS_STORAGE_KEY = 'fokkus.triage.filters';
/** Último destino usado por categoría: la próxima solicitud de esa categoría lo trae preseleccionado. */
const LAST_TARGET_STORAGE_KEY = 'fokkus.triage.lastTargetByCategory';
/** Crear un ticket puede tardar (Plane: crear + módulo + labels): más margen que el resto de RPCs. */
const APPROVE_TIMEOUT_MS = 60000;
/** pollNow espera a Slack y Gmail con paginación. */
const POLL_TIMEOUT_MS = 120000;

const CATEGORY_LABELS = Object.fromEntries(TRIAGE_CATEGORIES.map(category => [category.id, category.label])) as Record<TriageCategory, string>;
const STATUS_LABELS: Record<TriageItemStatus, string> = { pending: 'Pendientes', approved: 'Aprobadas', discarded: 'Descartadas' };
const SOURCE_LABELS: Record<TriageSource, string> = { slack: 'Slack', gmail: 'Gmail' };
const SOURCE_ICONS: Record<TriageSource, string> = { slack: 'fa fa-slack', gmail: 'fa fa-envelope' };

interface SavedFilters {
    status: TriageItemStatus | '';
    source: TriageSource | '';
    category: TriageCategory | '';
}

const DEFAULT_FILTERS: SavedFilters = { status: 'pending', source: '', category: '' };

function isCategory(value: unknown): value is TriageCategory {
    return TRIAGE_CATEGORIES.some(category => category.id === value);
}

function loadFilters(): SavedFilters {
    try {
        const parsed = JSON.parse(localStorage.getItem(FILTERS_STORAGE_KEY) ?? '{}') as Partial<SavedFilters>;
        return {
            status: parsed.status === '' || parsed.status === 'approved' || parsed.status === 'discarded' ? parsed.status : 'pending',
            source: parsed.source === 'slack' || parsed.source === 'gmail' ? parsed.source : '',
            category: isCategory(parsed.category) ? parsed.category : ''
        };
    } catch {
        localStorage.removeItem(FILTERS_STORAGE_KEY);
        return DEFAULT_FILTERS;
    }
}

function loadLastTargets(): Partial<Record<TriageCategory, TargetDraft>> {
    try {
        const parsed = JSON.parse(localStorage.getItem(LAST_TARGET_STORAGE_KEY) ?? '{}') as unknown;
        return parsed && typeof parsed === 'object' ? parsed as Partial<Record<TriageCategory, TargetDraft>> : {};
    } catch {
        localStorage.removeItem(LAST_TARGET_STORAGE_KEY);
        return {};
    }
}

function rememberTarget(category: TriageCategory, draft: TargetDraft): void {
    const all = loadLastTargets();
    all[category] = draft;
    localStorage.setItem(LAST_TARGET_STORAGE_KEY, JSON.stringify(all));
}

function matchesQuery(item: TriageItem, query: TriageItemQuery): boolean {
    return (!query.status || item.status === query.status)
        && (!query.source || item.source === query.source)
        && (!query.category || item.category === query.category);
}

/** Normaliza para búsqueda local: minúsculas y sin tildes. */
function normalizeForSearch(value: string): string {
    return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function formatDateTime(iso?: string): string {
    if (!iso) {
        return '—';
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return '—';
    }
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay
        ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleString(undefined, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function sortByActivity(items: TriageItem[]): TriageItem[] {
    return [...items].sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

// ---------------------------------------------------------------------------------------------
// Tarjeta
// ---------------------------------------------------------------------------------------------

interface TriageCardProps {
    item: TriageItem;
    expanded: boolean;
    server: TriageServer;
    cache: TargetCache;
    providers: TargetProviderStatus[];
    windowService: WindowService;
    onToggle(): void;
    onItemChanged(item: TriageItem): void;
}

function TriageCard({ item, expanded, server, cache, providers, windowService, onToggle, onItemChanged }: TriageCardProps): React.ReactElement {
    const [title, setTitle] = React.useState(item.title);
    const [description, setDescription] = React.useState(item.description);
    const [category, setCategory] = React.useState<TriageCategory>(item.category);
    const [target, setTarget] = React.useState<TargetDraft>(() => loadLastTargets()[item.category] ?? EMPTY_TARGET_DRAFT);
    const [groups, setGroups] = React.useState<TargetOptionGroup[]>([]);
    const [includeSource, setIncludeSource] = React.useState(true);
    const [showOriginal, setShowOriginal] = React.useState(false);
    const [discarding, setDiscarding] = React.useState(false);
    const [discardReason, setDiscardReason] = React.useState('');
    const [busy, setBusy] = React.useState<'save' | 'approve' | 'discard' | 'restore'>();
    const [error, setError] = React.useState<string>();

    // Si el ítem cambia en el backend (otra ventana, respuesta nueva en el hilo) y aquí no hay edición en curso, se sincroniza.
    const dirty = title !== item.title || description !== item.description || category !== item.category;
    const dirtyRef = React.useRef(dirty);
    dirtyRef.current = dirty;
    React.useEffect(() => {
        if (!dirtyRef.current) {
            setTitle(item.title);
            setDescription(item.description);
            setCategory(item.category);
        }
    }, [item.title, item.description, item.category]);

    const changeCategory = (value: TriageCategory): void => {
        setCategory(value);
        // Si el usuario aún no eligió destino, se propone el último usado para la nueva categoría.
        if (!target.provider) {
            const remembered = loadLastTargets()[value];
            if (remembered) {
                setTarget(remembered);
            }
        }
    };

    const runAction = async (kind: 'save' | 'approve' | 'discard' | 'restore', action: () => Promise<TriageItem>): Promise<void> => {
        setBusy(kind);
        setError(undefined);
        try {
            onItemChanged(await action());
            setDiscarding(false);
            setDiscardReason('');
        } catch (err) {
            setError(triageErrorMessage(err));
        } finally {
            setBusy(undefined);
        }
    };

    const trimmedTitle = title.trim();
    const missing = missingRequiredGroups(groups, target.selections);
    const targetProvider = providers.find(provider => provider.id === target.provider);
    const approveBlocker = !trimmedTitle ? 'Falta el título'
        : !targetProvider?.configured ? 'Elige un proveedor destino configurado'
            : !target.containerId ? `Elige ${targetProvider.containerLabel.toLowerCase()}`
                : missing.length > 0 ? `Falta: ${missing.join(', ')}`
                    : undefined;

    const approve = (): Promise<void> => runAction('approve', async () => {
        const provider = target.provider!;
        const result = await withTriageTimeout(server.approveItem({
            itemId: item.id,
            title: trimmedTitle,
            description,
            category,
            target: { provider, containerId: target.containerId, selections: target.selections },
            includeSourceReference: includeSource
        }), APPROVE_TIMEOUT_MS);
        rememberTarget(category, target);
        return result.item;
    });

    const pending = item.status === 'pending';
    const disabled = busy !== undefined;

    return (
        <article className={`fokkus-backlog-card fokkus-triage-card fokkus-triage-card-${item.status}`} data-item-id={item.id}>
            <button type='button' className='fokkus-backlog-card-header' onClick={onToggle} aria-expanded={expanded}>
                <i className={`${SOURCE_ICONS[item.source]} fokkus-triage-source-icon`} title={SOURCE_LABELS[item.source]} />
                <span className='fokkus-backlog-title'>{item.title}</span>
                <span className='fokkus-backlog-estimate' title={`Última actividad: ${new Date(item.lastActivityAt).toLocaleString()}`}>
                    {formatDateTime(item.lastActivityAt)}
                </span>
            </button>
            <div className='fokkus-triage-meta'>
                <span className={`fokkus-triage-category fokkus-triage-category-${item.category}`}>{CATEGORY_LABELS[item.category]}</span>
                <span>{item.author.name}</span>
                <span>{item.channel}</span>
                {item.messageCount > 1 && <span title='Mensajes agrupados en este hilo'>{item.messageCount} mensajes</span>}
                {item.status === 'approved' && item.approval && (
                    <a
                        href={item.approval.ticket.url}
                        onClick={event => { event.preventDefault(); windowService.openNewWindow(item.approval!.ticket.url, { external: true }); }}
                    >
                        <i className='fa fa-ticket' /> {TARGET_PROVIDER_LABELS[item.approval.ticket.provider]} {item.approval.ticket.key}
                    </a>
                )}
                {item.status === 'discarded' && <span className='fokkus-triage-discarded-tag'>Descartada</span>}
                {item.lastError && pending && <span className='fokkus-triage-error-tag' title={item.lastError}><i className='fa fa-exclamation-triangle' /> Falló</span>}
            </div>

            {expanded && (
                <div className='fokkus-triage-editor'>
                    {pending ? (
                        <>
                            <label className='fokkus-backlog-field'>
                                <span className='fokkus-backlog-label'>Título</span>
                                <input
                                    className='fokkus-backlog-input'
                                    value={title}
                                    maxLength={TRIAGE_TITLE_MAX_LENGTH}
                                    disabled={disabled}
                                    onChange={event => setTitle(event.target.value)}
                                />
                            </label>
                            <label className='fokkus-backlog-field'>
                                <span className='fokkus-backlog-label'>
                                    Categoría
                                    {item.suggestedCategory === category && (
                                        <span className='fokkus-triage-confidence' title={item.classificationReason}>
                                            {' '}· sugerida ({Math.round(item.confidence * 100)} %)
                                        </span>
                                    )}
                                </span>
                                <select
                                    className='fokkus-backlog-input'
                                    value={category}
                                    disabled={disabled}
                                    onChange={event => changeCategory(event.target.value as TriageCategory)}
                                    title={TRIAGE_CATEGORIES.find(c => c.id === category)?.description}
                                >
                                    {TRIAGE_CATEGORIES.map((option, index) => (
                                        <option key={option.id} value={option.id} title={option.description}>{index + 1}. {option.label}</option>
                                    ))}
                                </select>
                            </label>
                            <label className='fokkus-backlog-field'>
                                <span className='fokkus-backlog-label'>Descripción</span>
                                <textarea
                                    className='fokkus-backlog-input fokkus-triage-textarea'
                                    value={description}
                                    maxLength={TRIAGE_DESCRIPTION_MAX_LENGTH}
                                    disabled={disabled}
                                    rows={6}
                                    onChange={event => setDescription(event.target.value)}
                                />
                            </label>
                        </>
                    ) : (
                        <div className='fokkus-triage-readonly'>
                            <div className='fokkus-backlog-label'>Descripción</div>
                            <pre className='fokkus-triage-original'>{item.description}</pre>
                            {item.discardReason && <div className='fokkus-backlog-status'>Motivo del descarte: {item.discardReason}</div>}
                        </div>
                    )}

                    <div className='fokkus-triage-original-toggle'>
                        <button type='button' className='fokkus-backlog-icon-button' onClick={() => setShowOriginal(show => !show)} aria-expanded={showOriginal}>
                            {showOriginal ? '▾' : '▸'} Mensaje original
                        </button>
                        {item.permalink && (
                            <button
                                type='button'
                                className='fokkus-backlog-icon-button'
                                onClick={() => windowService.openNewWindow(item.permalink!, { external: true })}
                            >
                                <i className='fa fa-external-link' /> Abrir en {SOURCE_LABELS[item.source]}
                            </button>
                        )}
                    </div>
                    {showOriginal && (
                        <div className='fokkus-triage-original-box'>
                            <div className='fokkus-backlog-status'>
                                {item.originalSubject} — {item.author.name}{item.author.email ? ` <${item.author.email}>` : ''} · {formatDateTime(item.receivedAt)}
                            </div>
                            <pre className='fokkus-triage-original'>{item.originalText}</pre>
                        </div>
                    )}

                    {pending && (
                        <>
                            <TriageTargetPicker
                                idPrefix={`fokkus-triage-${item.id}`}
                                cache={cache}
                                providers={providers}
                                draft={target}
                                disabled={disabled}
                                onChange={(next, nextGroups) => { setTarget(next); setGroups(nextGroups); }}
                            />
                            <label className='fokkus-triage-checkbox'>
                                <input type='checkbox' checked={includeSource} disabled={disabled} onChange={event => setIncludeSource(event.target.checked)} />
                                Incluir referencia al mensaje original en el ticket
                            </label>
                        </>
                    )}

                    {item.lastError && pending && <div className='fokkus-backlog-error'>Último intento: {item.lastError}</div>}
                    {error && <div className='fokkus-backlog-error' role='alert'>{error}</div>}

                    {pending && discarding && (
                        <label className='fokkus-backlog-field'>
                            <span className='fokkus-backlog-label'>Motivo del descarte (opcional)</span>
                            <input
                                className='fokkus-backlog-input'
                                value={discardReason}
                                maxLength={TRIAGE_DISCARD_REASON_MAX_LENGTH}
                                disabled={disabled}
                                placeholder='Duplicado, spam, conversación sin requerimiento…'
                                onChange={event => setDiscardReason(event.target.value)}
                            />
                        </label>
                    )}

                    <div className='fokkus-triage-actions'>
                        {pending && !discarding && (
                            <>
                                <button
                                    type='button'
                                    className='fokkus-backlog-apply fokkus-triage-approve'
                                    disabled={disabled || approveBlocker !== undefined}
                                    title={approveBlocker ?? 'Crear el ticket en el destino y marcar la solicitud como aprobada'}
                                    onClick={approve}
                                >
                                    <i className='fa fa-check' /> {busy === 'approve' ? 'Creando ticket…' : 'Aprobar'}
                                </button>
                                <button
                                    type='button'
                                    className='fokkus-backlog-icon-button'
                                    disabled={disabled || !dirty || !trimmedTitle}
                                    onClick={() => runAction('save', () => withTriageTimeout(server.updateItem(item.id, { title: trimmedTitle, description, category })))}
                                >
                                    {busy === 'save' ? 'Guardando…' : 'Guardar cambios'}
                                </button>
                                <button type='button' className='fokkus-backlog-icon-button' disabled={disabled} onClick={() => setDiscarding(true)}>
                                    <i className='fa fa-trash' /> Descartar
                                </button>
                            </>
                        )}
                        {pending && discarding && (
                            <>
                                <button
                                    type='button'
                                    className='fokkus-backlog-apply fokkus-triage-discard'
                                    disabled={disabled}
                                    onClick={() => runAction('discard', () => withTriageTimeout(server.discardItem(item.id, discardReason.trim() || undefined)))}
                                >
                                    <i className='fa fa-trash' /> {busy === 'discard' ? 'Descartando…' : 'Confirmar descarte'}
                                </button>
                                <button type='button' className='fokkus-backlog-icon-button' disabled={disabled} onClick={() => setDiscarding(false)}>
                                    Cancelar
                                </button>
                            </>
                        )}
                        {item.status === 'discarded' && (
                            <button
                                type='button'
                                className='fokkus-backlog-icon-button'
                                disabled={disabled}
                                onClick={() => runAction('restore', () => withTriageTimeout(server.restoreItem(item.id)))}
                            >
                                <i className='fa fa-undo' /> {busy === 'restore' ? 'Restaurando…' : 'Restaurar a pendiente'}
                            </button>
                        )}
                        {item.status === 'approved' && item.approval && (
                            <button
                                type='button'
                                className='fokkus-backlog-icon-button'
                                onClick={() => windowService.openNewWindow(item.approval!.ticket.url, { external: true })}
                            >
                                <i className='fa fa-external-link' /> Abrir ticket {item.approval.ticket.key}
                            </button>
                        )}
                    </div>
                </div>
            )}
        </article>
    );
}

// ---------------------------------------------------------------------------------------------
// Bandeja
// ---------------------------------------------------------------------------------------------

interface TriageInboxAppProps {
    server: TriageServer;
    client: TriageClientImpl;
    windowService: WindowService;
    confirm(title: string, message: string): Promise<boolean>;
    onCountsChanged(counts: TriageCounts): void;
}

function TriageInboxApp({ server, client, windowService, confirm, onCountsChanged }: TriageInboxAppProps): React.ReactElement {
    const cache = React.useMemo(() => new TargetCache(server), [server]);
    const [bootError, setBootError] = React.useState<string>();
    const [polling, setPolling] = React.useState<TriagePollingStatus>();
    const [counts, setCounts] = React.useState<TriageCounts>();
    const [providers, setProviders] = React.useState<TargetProviderStatus[]>([]);
    const [configOpen, setConfigOpen] = React.useState(false);

    const [filters, setFilters] = React.useState<SavedFilters>(loadFilters);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [items, setItems] = React.useState<TriageItem[]>([]);
    const [itemsLoading, setItemsLoading] = React.useState(false);
    const [itemsError, setItemsError] = React.useState<string>();
    const [expandedId, setExpandedId] = React.useState<string>();
    const [pollBusy, setPollBusy] = React.useState(false);
    const [pollError, setPollError] = React.useState<string>();

    const query: TriageItemQuery = React.useMemo(() => ({
        status: filters.status || undefined,
        source: filters.source || undefined,
        category: filters.category || undefined
    }), [filters]);
    const queryRef = React.useRef(query);
    queryRef.current = query;

    const applyCounts = React.useCallback((next: TriageCounts) => {
        setCounts(next);
        onCountsChanged(next);
    }, [onCountsChanged]);

    const loadStatus = React.useCallback(async () => {
        try {
            const [status, providerList] = await Promise.all([
                withTriageTimeout(server.getStatus()),
                withTriageTimeout(server.listTargetProviders())
            ]);
            setPolling(status.polling);
            applyCounts(status.counts);
            setProviders(providerList);
            setBootError(undefined);
        } catch (error) {
            setBootError(triageErrorMessage(error));
        }
    }, [server, applyCounts]);

    const loadItems = React.useCallback(async (current: TriageItemQuery) => {
        setItemsLoading(true);
        setItemsError(undefined);
        try {
            const list = await withTriageTimeout(server.listItems(current));
            if (queryRef.current === current) {
                setItems(sortByActivity(list));
            }
        } catch (error) {
            setItemsError(triageErrorMessage(error));
        } finally {
            setItemsLoading(false);
        }
    }, [server]);

    React.useEffect(() => {
        loadStatus();
    }, [loadStatus]);

    React.useEffect(() => {
        localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(filters));
        loadItems(query);
    }, [filters, query, loadItems]);

    // Eventos en vivo del backend.
    React.useEffect(() => {
        const disposable = client.onDidReceiveEvent(event => {
            if (event.kind === 'polling-changed') {
                setPolling(event.polling);
                return;
            }
            applyCounts(event.counts);
            if (event.kind === 'items-detected') {
                const fresh = event.items.filter(item => matchesQuery(item, queryRef.current));
                if (fresh.length > 0) {
                    setItems(current => sortByActivity([...fresh, ...current.filter(item => !fresh.some(f => f.id === item.id))]));
                }
                return;
            }
            const updated = event.item;
            setItems(current => {
                const others = current.filter(item => item.id !== updated.id);
                return matchesQuery(updated, queryRef.current) ? sortByActivity([...others, updated]) : others;
            });
        });
        return () => disposable.dispose();
    }, [client, applyCounts]);

    const handleItemChanged = (updated: TriageItem): void => {
        setItems(current => {
            const others = current.filter(item => item.id !== updated.id);
            return matchesQuery(updated, queryRef.current) ? sortByActivity([...others, updated]) : others;
        });
        // Los contadores llegan por el evento item-updated; si el evento no llega (backend sin cliente), se piden.
        withTriageTimeout(server.getStatus()).then(status => applyCounts(status.counts)).catch(() => undefined);
    };

    const pollNow = async (): Promise<void> => {
        setPollBusy(true);
        setPollError(undefined);
        try {
            const result = await withTriageTimeout(server.pollNow(), POLL_TIMEOUT_MS);
            const failed = result.sources.filter(source => !source.ok);
            if (failed.length > 0) {
                setPollError(failed.map(source => `${SOURCE_LABELS[source.source]}: ${source.error ?? 'error'}`).join(' · '));
            }
            await Promise.all([loadStatus(), loadItems(queryRef.current)]);
        } catch (error) {
            setPollError(triageErrorMessage(error));
        } finally {
            setPollBusy(false);
        }
    };

    const togglePolling = async (): Promise<void> => {
        if (!polling) {
            return;
        }
        try {
            const status = await withTriageTimeout(server.setPollingEnabled(!polling.enabled));
            setPolling(status.polling);
            applyCounts(status.counts);
        } catch (error) {
            setPollError(triageErrorMessage(error));
        }
    };

    const filteredItems = React.useMemo(() => {
        const text = normalizeForSearch(searchQuery.trim());
        if (!text) {
            return items;
        }
        return items.filter(item =>
            normalizeForSearch(item.title).includes(text)
            || normalizeForSearch(item.author.name).includes(text)
            || normalizeForSearch(item.channel).includes(text)
            || normalizeForSearch(item.originalText).includes(text));
    }, [items, searchQuery]);

    if (bootError && !polling) {
        return (
            <div className='fokkus-backlog fokkus-triage'>
                <div className='fokkus-backlog-error' role='alert'>{bootError}</div>
                <button type='button' className='fokkus-backlog-apply' onClick={loadStatus}>Reintentar</button>
            </div>
        );
    }

    const lastErrors = polling?.lastResult?.sources.filter(source => !source.ok) ?? [];

    return (
        <div className='fokkus-backlog fokkus-triage'>
            {/* Estado del sondeo */}
            <section className='fokkus-backlog-section'>
                <div className='fokkus-backlog-section-header fokkus-backlog-section-header-static'>
                    <span title='Slack y Gmail se revisan cada 5 minutos'>Sondeo</span>
                    <span className='fokkus-backlog-header-actions'>
                        <button
                            type='button'
                            className='fokkus-backlog-icon-button'
                            onClick={togglePolling}
                            disabled={!polling}
                            title={polling?.enabled ? 'Pausar la revisión automática' : 'Reanudar la revisión automática cada 5 minutos'}
                        >
                            <i className={polling?.enabled ? 'fa fa-pause' : 'fa fa-play'} /> {polling?.enabled ? 'Pausar' : 'Reanudar'}
                        </button>
                        <button
                            type='button'
                            className='fokkus-backlog-icon-button'
                            onClick={pollNow}
                            disabled={pollBusy || polling?.running}
                        >
                            <i className={`fa fa-refresh${pollBusy || polling?.running ? ' fa-spin' : ''}`} /> Revisar ahora
                        </button>
                    </span>
                </div>
                <div className='fokkus-backlog-section-body'>
                    <div className='fokkus-triage-poll-status'>
                        {!polling && <span>Cargando estado…</span>}
                        {polling && (
                            <>
                                <span><i className='fa fa-clock-o' /> Última: {formatDateTime(polling.lastRunAt)}</span>
                                <span>
                                    {polling.running ? 'Revisando…' : polling.enabled ? `Próxima: ${formatDateTime(polling.nextRunAt)}` : 'Revisión automática en pausa'}
                                </span>
                            </>
                        )}
                    </div>
                    {counts && (
                        <div className='fokkus-triage-counts'>
                            {(Object.keys(STATUS_LABELS) as TriageItemStatus[]).map(status => (
                                <span key={status} className={`fokkus-triage-count fokkus-triage-count-${status}`}>
                                    {STATUS_LABELS[status]}: <strong>{counts[status]}</strong>
                                </span>
                            ))}
                        </div>
                    )}
                    {lastErrors.map(source => (
                        <div key={source.source} className='fokkus-backlog-error'>{SOURCE_LABELS[source.source]}: {source.error ?? 'error'}</div>
                    ))}
                    {pollError && <div className='fokkus-backlog-error'>{pollError}</div>}
                </div>
            </section>

            {/* Configuración */}
            <section className='fokkus-backlog-section'>
                <button
                    type='button'
                    className='fokkus-backlog-section-header'
                    onClick={() => setConfigOpen(open => !open)}
                    aria-expanded={configOpen}
                >
                    <span><i className='fa fa-cog' /> Fuentes y conexiones</span>
                    <span className='fokkus-backlog-section-chevron'>{configOpen ? '▾' : '▸'}</span>
                </button>
                {configOpen && (
                    <div className='fokkus-backlog-section-body'>
                        <TriageConfigPanel
                            server={server}
                            providers={providers}
                            confirm={confirm}
                            onChanged={() => { cache.clear(); loadStatus(); }}
                        />
                    </div>
                )}
            </section>

            {/* Filtros + lista */}
            <section className='fokkus-backlog-section'>
                <div className='fokkus-backlog-section-header fokkus-backlog-section-header-static'>
                    <span><i className='fa fa-inbox' /> Solicitudes</span>
                    <span className='fokkus-backlog-header-actions'>
                        <span className='fokkus-backlog-count'>
                            {searchQuery.trim() ? `${filteredItems.length} / ${items.length}` : items.length}
                        </span>
                    </span>
                </div>
                <div className='fokkus-backlog-section-body fokkus-backlog-list'>
                    <div className='fokkus-triage-filters'>
                        <select
                            className='fokkus-backlog-input'
                            aria-label='Estado'
                            value={filters.status}
                            onChange={event => setFilters(current => ({ ...current, status: event.target.value as SavedFilters['status'] }))}
                        >
                            {(Object.keys(STATUS_LABELS) as TriageItemStatus[]).map(status => (
                                <option key={status} value={status}>{STATUS_LABELS[status]}</option>
                            ))}
                            <option value=''>Todos los estados</option>
                        </select>
                        <select
                            className='fokkus-backlog-input'
                            aria-label='Origen'
                            value={filters.source}
                            onChange={event => setFilters(current => ({ ...current, source: event.target.value as SavedFilters['source'] }))}
                        >
                            <option value=''>Slack y Gmail</option>
                            <option value='slack'>Solo Slack</option>
                            <option value='gmail'>Solo Gmail</option>
                        </select>
                        <select
                            className='fokkus-backlog-input fokkus-triage-filter-wide'
                            aria-label='Categoría'
                            value={filters.category}
                            onChange={event => setFilters(current => ({ ...current, category: event.target.value as SavedFilters['category'] }))}
                        >
                            <option value=''>Todas las categorías</option>
                            {TRIAGE_CATEGORIES.map((category, index) => (
                                <option key={category.id} value={category.id}>{index + 1}. {category.label}</option>
                            ))}
                        </select>
                    </div>
                    <input
                        className='fokkus-backlog-input'
                        type='search'
                        value={searchQuery}
                        onChange={event => setSearchQuery(event.target.value)}
                        placeholder='Buscar por título, autor, canal o texto…'
                        aria-label='Buscar solicitudes'
                    />
                    {itemsLoading && items.length === 0 && <div className='fokkus-backlog-status'>Cargando solicitudes…</div>}
                    {itemsError && <div className='fokkus-backlog-error'>{itemsError}</div>}
                    {!itemsLoading && !itemsError && items.length === 0 && (
                        <div className='fokkus-backlog-status'>
                            {filters.status === 'pending' ? 'Bandeja al día: no hay solicitudes pendientes.' : 'Sin solicitudes para estos filtros.'}
                        </div>
                    )}
                    {items.length > 0 && filteredItems.length === 0 && <div className='fokkus-backlog-status'>Sin resultados para la búsqueda</div>}
                    {filteredItems.map(item => (
                        <TriageCard
                            key={item.id}
                            item={item}
                            expanded={expandedId === item.id}
                            server={server}
                            cache={cache}
                            providers={providers}
                            windowService={windowService}
                            onToggle={() => setExpandedId(current => current === item.id ? undefined : item.id)}
                            onItemChanged={handleItemChanged}
                        />
                    ))}
                </div>
            </section>
        </div>
    );
}

@injectable()
export class TriageInboxWidget extends ReactWidget {

    static readonly ID = TRIAGE_INBOX_WIDGET_ID;
    static readonly LABEL = 'Bandeja de solicitudes';

    @inject(TriageServer)
    protected readonly triageServer: TriageServer;

    @inject(TriageClientImpl)
    protected readonly triageClient: TriageClientImpl;

    @inject(WindowService)
    protected readonly windowService: WindowService;

    @postConstruct()
    protected init(): void {
        this.id = TriageInboxWidget.ID;
        this.title.label = TriageInboxWidget.LABEL;
        this.title.caption = TriageInboxWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'fa fa-inbox';
        this.addClass('fokkus-triage-widget');
        this.update();
    }

    protected readonly confirm = async (title: string, msg: string): Promise<boolean> => {
        const dialog = new ConfirmDialog({ title, msg, ok: 'Eliminar', cancel: 'Cancelar' });
        return !!(await dialog.open());
    };

    /** El icono lateral no admite badge fuera de un ViewContainer: el número de pendientes va en el tooltip. */
    protected readonly onCountsChanged = (counts: TriageCounts): void => {
        this.title.caption = counts.pending > 0
            ? `${TriageInboxWidget.LABEL} — ${counts.pending} pendiente${counts.pending === 1 ? '' : 's'}`
            : TriageInboxWidget.LABEL;
    };

    protected render(): React.ReactNode {
        return <TriageInboxApp
            server={this.triageServer}
            client={this.triageClient}
            windowService={this.windowService}
            confirm={this.confirm}
            onCountsChanged={this.onCountsChanged}
        />;
    }
}
