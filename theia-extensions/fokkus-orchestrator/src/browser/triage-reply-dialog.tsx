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
    TRIAGE_REPLY_BODY_MAX_LENGTH,
    TRIAGE_REPLY_SUBJECT_MAX_LENGTH,
    TriageItem,
    TriageReplyDraft,
    TriageServer
} from '../common/triage-protocol';
import { triageErrorMessage, withTriageTimeout } from './triage-service';

/** Enviar por Gmail puede caer a borrador tras un 403: dos llamadas HTTP con OAuth. */
const SEND_TIMEOUT_MS = 60000;

export interface TriageReplyNotifier {
    info(message: string): void;
    warn(message: string): void;
}

/** Copia texto al portapapeles; si la Clipboard API no está disponible (contexto no seguro), usa execCommand. */
export async function copyToClipboard(text: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
        return;
    } catch {
        // Se intenta el método antiguo.
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    // eslint-disable-next-line deprecation/deprecation
    const ok = document.execCommand('copy');
    area.remove();
    if (!ok) {
        throw new Error('El navegador no permitió copiar al portapapeles');
    }
}

export interface TriageReplyDialogProps {
    item: TriageItem;
    server: TriageServer;
    /** true = abierto automáticamente tras aprobar: si no hay borrador, se cierra sin mostrar nada. */
    auto: boolean;
    notify: TriageReplyNotifier;
    onClose(): void;
}

/**
 * Validación humana de la respuesta al cliente (#29). El backend propone el borrador con la clave y el enlace
 * del ticket; el usuario lo edita y decide si lo envía, lo copia o lo omite. Omitir no afecta la aprobación.
 */
export function TriageReplyDialog({ item, server, auto, notify, onClose }: TriageReplyDialogProps): React.ReactElement {
    const [draft, setDraft] = React.useState<TriageReplyDraft>();
    const [loadError, setLoadError] = React.useState<string>();
    const [subject, setSubject] = React.useState('');
    const [body, setBody] = React.useState('');
    const [busy, setBusy] = React.useState<'send' | 'copy'>();
    const [error, setError] = React.useState<string>();
    const bodyRef = React.useRef<HTMLTextAreaElement | undefined>(undefined);

    const load = React.useCallback(async () => {
        setLoadError(undefined);
        try {
            const next = await withTriageTimeout(server.getReplyDraft(item.id));
            setDraft(next);
            setSubject(next.subject);
            setBody(next.body);
        } catch (err) {
            if (auto) {
                // Sin borrador tras aprobar (p. ej. backend antiguo): no se interrumpe al usuario.
                console.warn('[fokkus-triage] Sin borrador de respuesta', err);
                onClose();
                return;
            }
            setLoadError(triageErrorMessage(err));
        }
    }, [server, item.id, auto, onClose]);

    React.useEffect(() => {
        load();
    }, [load]);

    React.useEffect(() => {
        if (draft) {
            bodyRef.current?.focus();
        }
    }, [draft]);

    const disabled = busy !== undefined;
    const close = React.useCallback(() => {
        if (!disabled) {
            onClose();
        }
    }, [disabled, onClose]);

    React.useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                close();
            }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [close]);

    if (auto && !draft) {
        return <></>;
    }

    const isGmail = item.source === 'gmail';
    const trimmedBody = body.trim();
    const sourceLabel = isGmail ? 'Gmail' : 'Slack';

    const send = async (): Promise<void> => {
        setBusy('send');
        setError(undefined);
        try {
            const result = await withTriageTimeout(server.sendReply({
                itemId: item.id,
                body: trimmedBody,
                ...(isGmail ? { subject: subject.trim() } : {}),
                mode: 'send'
            }), SEND_TIMEOUT_MS);
            if (result.ok) {
                notify.info(result.message ?? 'Respuesta enviada');
                onClose();
                return;
            }
            if (result.mode === 'clipboard') {
                // El backend no pudo entregar: se deja el texto listo para pegar y el diálogo sigue abierto para reintentar.
                await copyToClipboard(trimmedBody);
                notify.warn(`${result.error ?? 'No se pudo enviar la respuesta.'} El texto se copió al portapapeles.`);
            }
            setError(result.error ?? 'No se pudo enviar la respuesta');
        } catch (err) {
            setError(triageErrorMessage(err));
        } finally {
            setBusy(undefined);
        }
    };

    const copy = async (): Promise<void> => {
        setBusy('copy');
        setError(undefined);
        try {
            await copyToClipboard(trimmedBody);
        } catch (err) {
            setError(triageErrorMessage(err));
            setBusy(undefined);
            return;
        }
        try {
            await withTriageTimeout(server.sendReply({ itemId: item.id, body: trimmedBody, mode: 'clipboard' }));
        } catch (err) {
            // El texto ya está copiado: no registrarlo no debe impedir el envío manual.
            console.warn('[fokkus-triage] No se pudo registrar la copia de la respuesta', err);
        }
        notify.info(`Respuesta copiada al portapapeles. Pégala en ${sourceLabel} para enviarla.`);
        setBusy(undefined);
        onClose();
    };

    return (
        <div className='fokkus-triage-modal-backdrop' onMouseDown={event => { if (event.target === event.currentTarget) { close(); } }}>
            <div className='fokkus-triage-modal' role='dialog' aria-modal='true' aria-labelledby='fokkus-triage-reply-title'>
                <div className='fokkus-triage-modal-header'>
                    <i className={isGmail ? 'fa fa-envelope' : 'fa fa-slack'} />
                    <span id='fokkus-triage-reply-title'>Respuesta al cliente en {sourceLabel}</span>
                    <button type='button' className='fokkus-backlog-icon-button' onClick={close} disabled={disabled} aria-label='Cerrar' title='Cerrar'>
                        <i className='fa fa-times' />
                    </button>
                </div>

                <div className='fokkus-triage-modal-body'>
                    {!draft && !loadError && <div className='fokkus-backlog-status'>Generando borrador…</div>}
                    {loadError && (
                        <>
                            <div className='fokkus-backlog-error' role='alert'>{loadError}</div>
                            <button type='button' className='fokkus-backlog-icon-button' onClick={load}>Reintentar</button>
                        </>
                    )}
                    {draft && (
                        <>
                            <div className='fokkus-triage-reply-meta'>
                                <span>
                                    <span className='fokkus-backlog-label'>{isGmail ? 'Para' : 'Hilo en'}</span> {draft.recipient || '—'}
                                </span>
                                <span>
                                    <span className='fokkus-backlog-label'>Ticket</span> {draft.ticketKey}
                                </span>
                            </div>
                            {isGmail && (
                                <label className='fokkus-backlog-field'>
                                    <span className='fokkus-backlog-label'>Asunto</span>
                                    <input
                                        className='fokkus-backlog-input'
                                        value={subject}
                                        maxLength={TRIAGE_REPLY_SUBJECT_MAX_LENGTH}
                                        disabled={disabled}
                                        onChange={event => setSubject(event.target.value)}
                                    />
                                </label>
                            )}
                            <label className='fokkus-backlog-field'>
                                <span className='fokkus-backlog-label'>Mensaje</span>
                                <textarea
                                    ref={element => { bodyRef.current = element ?? undefined; }}
                                    className='fokkus-backlog-input fokkus-triage-textarea fokkus-triage-reply-body'
                                    value={body}
                                    maxLength={TRIAGE_REPLY_BODY_MAX_LENGTH}
                                    disabled={disabled}
                                    rows={11}
                                    onChange={event => setBody(event.target.value)}
                                />
                            </label>
                            <div className='fokkus-triage-hint'>
                                Revisa el texto antes de enviarlo. {isGmail
                                    ? 'Se responde en el mismo hilo; si Gmail no autoriza el envío, queda como borrador.'
                                    : 'Se publica como respuesta en el hilo original.'}
                            </div>
                            {error && <div className='fokkus-backlog-error' role='alert'>{error}</div>}
                        </>
                    )}
                </div>

                <div className='fokkus-triage-modal-footer'>
                    <button type='button' className='fokkus-backlog-icon-button' onClick={close} disabled={disabled}>
                        Omitir / Cerrar
                    </button>
                    <button type='button' className='fokkus-backlog-icon-button' onClick={copy} disabled={disabled || !draft || !trimmedBody}>
                        <i className='fa fa-clipboard' /> {busy === 'copy' ? 'Copiando…' : 'Copiar al portapapeles'}
                    </button>
                    <button
                        type='button'
                        className='fokkus-backlog-apply fokkus-triage-reply-send'
                        onClick={send}
                        disabled={disabled || !draft || !trimmedBody}
                    >
                        <i className='fa fa-paper-plane' /> {busy === 'send' ? 'Enviando…' : 'Enviar respuesta'}
                    </button>
                </div>
            </div>
        </div>
    );
}
