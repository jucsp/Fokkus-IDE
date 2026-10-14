/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from '@theia/core/shared/react';
import { TriageFeedbackRule, TriageServer } from '../common/triage-protocol';
import { triageErrorMessage, withTriageTimeout } from './triage-service';

export interface TriageFeedbackRulesProps {
    server: TriageServer;
    /** Cambia cuando se descarta algo con motivo: el backend puede haber aprendido una regla nueva. */
    refreshKey: number;
    confirm(title: string, message: string): Promise<boolean>;
    /** Tras aplicar las reglas a los pendientes: el padre recarga la lista de solicitudes. */
    onRulesApplied?: () => void;
}

function formatDate(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Reglas de auto-descarte aprendidas de los descartes con motivo (#28). */
export function TriageFeedbackRules({ server, refreshKey, confirm, onRulesApplied }: TriageFeedbackRulesProps): React.ReactElement {
    const [rules, setRules] = React.useState<TriageFeedbackRule[]>();
    const [loading, setLoading] = React.useState(false);
    const [applying, setApplying] = React.useState(false);
    const [applied, setApplied] = React.useState<number>();
    const [error, setError] = React.useState<string>();
    const [deleting, setDeleting] = React.useState<string>();

    const load = React.useCallback(async () => {
        setLoading(true);
        setError(undefined);
        try {
            setRules(await withTriageTimeout(server.getFeedbackRules()));
        } catch (err) {
            setError(triageErrorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [server]);

    React.useEffect(() => {
        load();
    }, [load, refreshKey]);

    /** Aplica las reglas a los pendientes existentes y recarga reglas (hits) y bandeja. */
    const applyAndReload = async (): Promise<void> => {
        setApplying(true);
        setApplied(undefined);
        setError(undefined);
        try {
            const { discardedCount } = await withTriageTimeout(server.applyFeedbackRules());
            setApplied(discardedCount);
        } catch (err) {
            setError(triageErrorMessage(err));
            return;
        } finally {
            setApplying(false);
        }
        await load();
        onRulesApplied?.();
    };

    const remove = async (rule: TriageFeedbackRule): Promise<void> => {
        const ok = await confirm(
            'Eliminar regla de auto-descarte',
            `Las solicitudes nuevas que coincidan con «${rule.reason}» volverán a llegar como pendientes. Las ya descartadas no se restauran.`
        );
        if (!ok) {
            return;
        }
        setDeleting(rule.id);
        setError(undefined);
        try {
            await withTriageTimeout(server.deleteFeedbackRule(rule.id));
            setRules(current => current?.filter(r => r.id !== rule.id));
        } catch (err) {
            setError(triageErrorMessage(err));
        } finally {
            setDeleting(undefined);
        }
    };

    return (
        <div className='fokkus-triage-rules'>
            <div className='fokkus-triage-rules-toolbar'>
                <span className='fokkus-triage-hint'>
                    Se aprenden al descartar con motivo. Las solicitudes nuevas que coincidan llegan como descartadas.
                </span>
                <button
                    type='button'
                    className='fokkus-backlog-icon-button'
                    onClick={applyAndReload}
                    disabled={loading || applying}
                    title='Aplicar las reglas a las pendientes y recargar'
                >
                    <i className={`fa fa-refresh${loading || applying ? ' fa-spin' : ''}`} />
                </button>
            </div>
            {applied !== undefined && (
                <div className='fokkus-backlog-status' role='status'>
                    {applied === 0 ? 'Ninguna solicitud pendiente coincide con las reglas.'
                        : `${applied} solicitud${applied === 1 ? '' : 'es'} pendiente${applied === 1 ? '' : 's'} auto-descartada${applied === 1 ? '' : 's'}.`}
                </div>
            )}
            {error && <div className='fokkus-backlog-error' role='alert'>{error}</div>}
            {!rules && loading && <div className='fokkus-backlog-status'>Cargando reglas…</div>}
            {rules && rules.length === 0 && <div className='fokkus-backlog-status'>Aún no hay reglas aprendidas.</div>}
            {rules?.map(rule => {
                const keywords = (rule.subjectPattern ?? '').split(' ').filter(Boolean);
                return (
                    <div key={rule.id} className='fokkus-triage-rule' data-rule-id={rule.id}>
                        <div className='fokkus-triage-rule-header'>
                            <span className='fokkus-triage-rule-reason' title='Motivo original del descarte'>«{rule.reason}»</span>
                            <button
                                type='button'
                                className='fokkus-backlog-icon-button fokkus-triage-rule-delete'
                                onClick={() => remove(rule)}
                                disabled={deleting !== undefined}
                                title='Eliminar regla'
                                aria-label={`Eliminar regla «${rule.reason}»`}
                            >
                                <i className={deleting === rule.id ? 'fa fa-spinner fa-spin' : 'fa fa-trash'} />
                            </button>
                        </div>
                        {(rule.senderEmail || rule.senderDomain) && (
                            <div className='fokkus-triage-rule-row'>
                                <i className='fa fa-user' title='Remitente' />
                                {rule.senderEmail ?? `@${rule.senderDomain}`}
                                {rule.senderEmail && rule.senderDomain && <span className='fokkus-triage-hint'>(dominio {rule.senderDomain})</span>}
                            </div>
                        )}
                        {keywords.length > 0 && (
                            <div className='fokkus-triage-rule-keywords' title='Todas deben aparecer en el asunto'>
                                {keywords.map(keyword => <span key={keyword} className='fokkus-triage-keyword'>{keyword}</span>)}
                            </div>
                        )}
                        <div className='fokkus-triage-rule-row fokkus-triage-hint'>
                            <span><i className='fa fa-calendar' /> {formatDate(rule.createdAt)}</span>
                            <span>· {rule.hits} auto-descarte{rule.hits === 1 ? '' : 's'}</span>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
