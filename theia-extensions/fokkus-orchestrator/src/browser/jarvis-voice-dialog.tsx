/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from '@theia/core/shared/react';
import { createPortal } from '@theia/core/shared/react-dom';
import { filterJarvisVoices, JARVIS_VOICE_FILTERS, JarvisVoiceFilter, resolveJarvisVoice } from '../common/jarvis-logic';
import { JarvisAudioService, JarvisVoiceInfo } from '../common/jarvis-protocol';

export interface JarvisVoiceDialogProps {
    audio: JarvisAudioService;
    onClose(): void;
}

/**
 * Selector de voz de Jarvis (Issue #27): pestañas por región, preescucha por voz y Guardar.
 * Se monta en el `document.body` de la ventana principal, centrado sobre el IDE.
 */
export function JarvisVoiceDialog({ audio, onClose }: JarvisVoiceDialogProps): React.ReactElement {
    const initialVoice = React.useMemo(() => resolveJarvisVoice(audio.getConfig()), [audio]);
    const [selectedId, setSelectedId] = React.useState(initialVoice.id);
    const [filter, setFilter] = React.useState<JarvisVoiceFilter>(initialVoice.region);
    const [previewId, setPreviewId] = React.useState<string | undefined>(() => audio.getPreviewVoiceId());
    const [error, setError] = React.useState<string | undefined>(undefined);
    const dialogRef = React.useRef<HTMLDivElement | undefined>(undefined);

    const close = React.useCallback(() => {
        audio.stopPreview();
        onClose();
    }, [audio, onClose]);

    React.useEffect(() => {
        const disposables = [
            audio.onPreviewChanged(id => setPreviewId(id)),
            audio.onError(message => setError(message))
        ];
        dialogRef.current?.focus();
        // Al desmontarse (p. ej. se oculta Jarvis con el diálogo abierto) no debe quedar audio sonando.
        return () => {
            disposables.forEach(disposable => disposable.dispose());
            audio.stopPreview();
        };
    }, [audio]);

    React.useEffect(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close();
            }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [close]);

    const togglePreview = (voice: JarvisVoiceInfo): void => {
        setError(undefined);
        if (previewId === voice.id) {
            audio.stopPreview();
            return;
        }
        audio.previewVoice(voice.id, voice.previewText).catch(cause => setError(`No se pudo reproducir la voz: ${String(cause)}`));
    };

    const save = (): void => {
        const voice = filterJarvisVoices('all').find(candidate => candidate.id === selectedId);
        if (voice) {
            audio.updateConfig({ voiceId: voice.id, voiceLang: voice.lang });
        }
        close();
    };

    const voices = filterJarvisVoices(filter);
    const selected = filterJarvisVoices('all').find(voice => voice.id === selectedId);

    return createPortal(
        <div className='fokkus-jarvis-modal-backdrop' onMouseDown={event => {
            if (event.target === event.currentTarget) {
                close();
            }
        }}>
            <div ref={element => { dialogRef.current = element ?? undefined; }} className='fokkus-jarvis-voice-dialog'
                role='dialog' aria-modal='true' aria-labelledby='fokkus-jarvis-voice-title' tabIndex={-1}>
                <header className='fokkus-jarvis-voice-header'>
                    <h2 id='fokkus-jarvis-voice-title'>Voz de Jarvis</h2>
                    <button type='button' className='fokkus-jarvis-voice-close' aria-label='Cerrar' title='Cerrar (Esc)' onClick={close}>×</button>
                </header>
                <div className='fokkus-jarvis-voice-tabs' role='tablist'>
                    {JARVIS_VOICE_FILTERS.map(tab => (
                        <button key={tab.id} type='button' role='tab' aria-selected={filter === tab.id}
                            className={`fokkus-jarvis-voice-tab${filter === tab.id ? ' fokkus-jarvis-voice-tab--active' : ''}`}
                            onClick={() => setFilter(tab.id)}>
                            {tab.label}
                        </button>
                    ))}
                </div>
                <div className='fokkus-jarvis-voice-list' role='radiogroup' aria-label='Voces disponibles'>
                    {voices.map(voice => {
                        const isSelected = voice.id === selectedId;
                        const isPlaying = voice.id === previewId;
                        return (
                            <div key={voice.id} role='radio' aria-checked={isSelected} tabIndex={0}
                                className={`fokkus-jarvis-voice-row${isSelected ? ' fokkus-jarvis-voice-row--selected' : ''}`}
                                onClick={() => setSelectedId(voice.id)}
                                onKeyDown={event => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault();
                                        setSelectedId(voice.id);
                                    }
                                }}>
                                <span className='fokkus-jarvis-voice-radio' aria-hidden='true' />
                                <span className='fokkus-jarvis-voice-info'>
                                    <span className='fokkus-jarvis-voice-name'>{voice.name}</span>
                                    <span className='fokkus-jarvis-voice-badges'>
                                        <span className='fokkus-jarvis-voice-badge'>{voice.regionLabel}</span>
                                        <span className={`fokkus-jarvis-voice-badge fokkus-jarvis-voice-badge--${voice.gender}`}>
                                            {voice.gender === 'male' ? 'Masculina' : 'Femenina'}
                                        </span>
                                        <span className='fokkus-jarvis-voice-badge fokkus-jarvis-voice-badge--lang'>{voice.lang}</span>
                                    </span>
                                </span>
                                <button type='button'
                                    className={`fokkus-jarvis-voice-play${isPlaying ? ' fokkus-jarvis-voice-play--playing' : ''}`}
                                    aria-label={isPlaying ? `Detener la preescucha de ${voice.name}` : `Preescuchar a ${voice.name}`}
                                    title={isPlaying ? 'Detener' : 'Preescuchar'}
                                    onClick={event => {
                                        event.stopPropagation();
                                        togglePreview(voice);
                                    }}>
                                    <i className={`fa ${isPlaying ? 'fa-stop' : 'fa-play'}`} aria-hidden='true' />
                                </button>
                            </div>
                        );
                    })}
                </div>
                {error && <div className='fokkus-jarvis-voice-error' role='alert'>{error}</div>}
                <footer className='fokkus-jarvis-voice-footer'>
                    <span className='fokkus-jarvis-voice-current'>{selected ? `Seleccionada: ${selected.name} (${selected.regionLabel})` : ''}</span>
                    <button type='button' className='fokkus-jarvis-voice-button' onClick={close}>Cancelar</button>
                    <button type='button' className='fokkus-jarvis-voice-button fokkus-jarvis-voice-button--primary' onClick={save}>Guardar</button>
                </footer>
            </div>
        </div>,
        document.body
    );
}
