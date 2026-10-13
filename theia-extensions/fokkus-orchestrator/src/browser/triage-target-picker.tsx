/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from '@theia/core/shared/react';
import {
    TargetContainer,
    TargetOptionGroup,
    TargetProviderId,
    TargetProviderStatus,
    TargetSelections,
    TriageServer
} from '../common/triage-protocol';
import { triageErrorMessage, withTriageTimeout } from './triage-service';

/** Destino en edición: el proveedor puede no estar elegido todavía. */
export interface TargetDraft {
    provider?: TargetProviderId;
    containerId: string;
    selections: TargetSelections;
}

export const EMPTY_TARGET_DRAFT: TargetDraft = { containerId: '', selections: {} };

/**
 * Caché compartida por todas las tarjetas de la bandeja: los proyectos/repos y sus opciones se piden
 * una sola vez por sesión (o hasta pulsar «Recargar»). Guarda promesas para no duplicar
 * peticiones simultáneas; si una falla, se olvida para poder reintentar.
 */
export class TargetCache {
    protected readonly containers = new Map<TargetProviderId, Promise<TargetContainer[]>>();
    protected readonly options = new Map<string, Promise<TargetOptionGroup[]>>();

    constructor(protected readonly server: TriageServer) { }

    listContainers(provider: TargetProviderId): Promise<TargetContainer[]> {
        let pending = this.containers.get(provider);
        if (!pending) {
            pending = withTriageTimeout(this.server.listTargetContainers(provider));
            this.containers.set(provider, pending);
            pending.catch(() => this.containers.delete(provider));
        }
        return pending;
    }

    listOptions(provider: TargetProviderId, containerId: string): Promise<TargetOptionGroup[]> {
        const key = `${provider}:${containerId}`;
        let pending = this.options.get(key);
        if (!pending) {
            pending = withTriageTimeout(this.server.listTargetOptions(provider, containerId));
            this.options.set(key, pending);
            pending.catch(() => this.options.delete(key));
        }
        return pending;
    }

    clear(): void {
        this.containers.clear();
        this.options.clear();
    }
}

/** Grupos obligatorios sin selección, para deshabilitar «Aprobar» y explicar por qué. */
export function missingRequiredGroups(groups: TargetOptionGroup[], selections: TargetSelections): string[] {
    return groups
        .filter(group => group.required && !(selections[group.kind]?.length))
        .map(group => group.label);
}

/** Aplica las opciones por defecto del proveedor a los grupos que el usuario aún no tocó. */
function withDefaults(groups: TargetOptionGroup[], selections: TargetSelections): TargetSelections {
    const next: TargetSelections = { ...selections };
    for (const group of groups) {
        const current = next[group.kind];
        if (current) {
            // Descarta ids que ya no existen (p. ej. un label borrado o un destino recordado de otro proyecto).
            const valid = current.filter(id => group.options.some(option => option.id === id));
            next[group.kind] = valid;
        } else if (group.defaultOptionId && group.options.some(option => option.id === group.defaultOptionId)) {
            next[group.kind] = [group.defaultOptionId];
        }
    }
    return next;
}

export interface TriageTargetPickerProps {
    idPrefix: string;
    cache: TargetCache;
    providers: TargetProviderStatus[];
    draft: TargetDraft;
    disabled?: boolean;
    onChange(draft: TargetDraft, groups: TargetOptionGroup[]): void;
}

export function TriageTargetPicker({ idPrefix, cache, providers, draft, disabled, onChange }: TriageTargetPickerProps): React.ReactElement {
    const [containers, setContainers] = React.useState<TargetContainer[]>([]);
    const [containersLoading, setContainersLoading] = React.useState(false);
    const [containersError, setContainersError] = React.useState<string>();
    const [groups, setGroups] = React.useState<TargetOptionGroup[]>([]);
    const [groupsLoading, setGroupsLoading] = React.useState(false);
    const [groupsError, setGroupsError] = React.useState<string>();
    const [reloadToken, setReloadToken] = React.useState(0);

    // onChange cambia en cada render del padre: se lee desde una ref para no relanzar los efectos.
    const latest = React.useRef({ draft, onChange });
    latest.current = { draft, onChange };

    const provider = providers.find(item => item.id === draft.provider);

    React.useEffect(() => {
        setContainers([]);
        setContainersError(undefined);
        if (!provider?.configured) {
            return;
        }
        let cancelled = false;
        setContainersLoading(true);
        cache.listContainers(provider.id)
            .then(list => {
                if (cancelled) {
                    return;
                }
                setContainers(list);
                const current = latest.current.draft;
                if (current.containerId && !list.some(item => item.id === current.containerId)) {
                    latest.current.onChange({ ...current, containerId: '', selections: {} }, []);
                }
            })
            .catch(error => !cancelled && setContainersError(triageErrorMessage(error)))
            .finally(() => !cancelled && setContainersLoading(false));
        return () => {
            cancelled = true;
        };
    }, [cache, provider?.id, provider?.configured, reloadToken]);

    React.useEffect(() => {
        setGroups([]);
        setGroupsError(undefined);
        if (!draft.provider || !draft.containerId) {
            return;
        }
        let cancelled = false;
        setGroupsLoading(true);
        cache.listOptions(draft.provider, draft.containerId)
            .then(list => {
                if (cancelled) {
                    return;
                }
                setGroups(list);
                const current = latest.current.draft;
                latest.current.onChange({ ...current, selections: withDefaults(list, current.selections) }, list);
            })
            .catch(error => !cancelled && setGroupsError(triageErrorMessage(error)))
            .finally(() => !cancelled && setGroupsLoading(false));
        return () => {
            cancelled = true;
        };
    }, [cache, draft.provider, draft.containerId, reloadToken]);

    const setProvider = (value: string): void => {
        const next = providers.find(item => item.id === value)?.id;
        onChange({ provider: next, containerId: '', selections: {} }, []);
    };

    const setContainer = (value: string): void => {
        onChange({ ...draft, containerId: value, selections: {} }, []);
    };

    const setSingle = (group: TargetOptionGroup, value: string): void => {
        onChange({ ...draft, selections: { ...draft.selections, [group.kind]: value ? [value] : [] } }, groups);
    };

    const toggleMultiple = (group: TargetOptionGroup, optionId: string, checked: boolean): void => {
        const current = draft.selections[group.kind] ?? [];
        const next = checked ? [...current.filter(id => id !== optionId), optionId] : current.filter(id => id !== optionId);
        onChange({ ...draft, selections: { ...draft.selections, [group.kind]: next } }, groups);
    };

    const reload = (): void => {
        cache.clear();
        setReloadToken(token => token + 1);
    };

    return (
        <div className='fokkus-triage-target'>
            <div className='fokkus-triage-target-header'>
                <span className='fokkus-backlog-label'>Destino</span>
                <button
                    type='button'
                    className='fokkus-backlog-icon-button'
                    onClick={reload}
                    disabled={disabled || !draft.provider}
                    title='Volver a pedir proyectos, repositorios y opciones al proveedor'
                >
                    <i className='fa fa-refresh' /> Recargar
                </button>
            </div>

            <div className='fokkus-triage-provider-row' role='radiogroup' aria-label='Proveedor destino'>
                {providers.map(item => (
                    <button
                        key={item.id}
                        type='button'
                        role='radio'
                        aria-checked={draft.provider === item.id}
                        className={`fokkus-triage-provider${draft.provider === item.id ? ' fokkus-triage-provider-active' : ''}`}
                        disabled={disabled || !item.configured}
                        title={item.configured ? item.label : (item.message ?? `${item.label} no está configurado`)}
                        onClick={() => setProvider(item.id)}
                    >
                        {item.label}
                    </button>
                ))}
            </div>
            {provider && !provider.configured && provider.message && (
                <div className='fokkus-backlog-status'>{provider.message}</div>
            )}
            {providers.length > 0 && providers.every(item => !item.configured) && (
                <div className='fokkus-backlog-status'>
                    Ningún destino está configurado. Plane se configura en el panel Plane Backlog, GitHub en
                    Preferencias › Git Providers y Jira en «Fuentes y conexiones».
                </div>
            )}

            {provider?.configured && (
                <label className='fokkus-backlog-field'>
                    <span className='fokkus-backlog-label'>{provider.containerLabel}</span>
                    <select
                        id={`${idPrefix}-container`}
                        className='fokkus-backlog-input'
                        value={draft.containerId}
                        disabled={disabled || containersLoading}
                        onChange={event => setContainer(event.target.value)}
                    >
                        <option value='' disabled>
                            {containersLoading ? 'Cargando…' : `Selecciona ${provider.containerLabel.toLowerCase()}`}
                        </option>
                        {containers.map(item => (
                            <option key={item.id} value={item.id}>{item.key ? `${item.key} · ${item.name}` : item.name}</option>
                        ))}
                    </select>
                </label>
            )}
            {containersError && <div className='fokkus-backlog-error'>{containersError}</div>}

            {groupsLoading && <div className='fokkus-backlog-status'>Cargando opciones…</div>}
            {groupsError && <div className='fokkus-backlog-error'>{groupsError}</div>}
            {!groupsLoading && groups.map(group => (
                group.multiple ? (
                    <fieldset key={group.kind} className='fokkus-triage-multi' disabled={disabled}>
                        <legend className='fokkus-backlog-label'>{group.label}{group.required ? ' *' : ''}</legend>
                        {group.options.length === 0 && <span className='fokkus-backlog-status'>Sin opciones</span>}
                        <div className='fokkus-triage-multi-options'>
                            {group.options.map(option => {
                                const checked = (draft.selections[group.kind] ?? []).includes(option.id);
                                return (
                                    <label
                                        key={option.id}
                                        className={`fokkus-triage-chip-option${checked ? ' fokkus-triage-chip-option-checked' : ''}`}
                                        title={option.detail}
                                    >
                                        <input
                                            type='checkbox'
                                            checked={checked}
                                            onChange={event => toggleMultiple(group, option.id, event.target.checked)}
                                        />
                                        {option.color && <span className='fokkus-triage-swatch' style={{ backgroundColor: `#${option.color}` }} />}
                                        {option.name}
                                    </label>
                                );
                            })}
                        </div>
                    </fieldset>
                ) : (
                    <label key={group.kind} className='fokkus-backlog-field'>
                        <span className='fokkus-backlog-label'>{group.label}{group.required ? ' *' : ''}</span>
                        <select
                            className='fokkus-backlog-input'
                            value={draft.selections[group.kind]?.[0] ?? ''}
                            disabled={disabled}
                            onChange={event => setSingle(group, event.target.value)}
                        >
                            <option value='' disabled={group.required}>{group.required ? 'Selecciona…' : 'Ninguno'}</option>
                            {group.options.map(option => (
                                <option key={option.id} value={option.id}>
                                    {option.detail ? `${option.name} (${option.detail})` : option.name}
                                </option>
                            ))}
                        </select>
                    </label>
                )
            ))}
        </div>
    );
}
