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
import { createRoot, Root } from '@theia/core/shared/react-dom/client';
import {
    blobRadius,
    innerWaveOffset,
    JARVIS_STATE_LABELS,
    JARVIS_THEMES,
    JarvisPoint,
    smoothAudioLevel,
    summarizeTranscript
} from '../common/jarvis-logic';
import { JarvisConfig, JarvisState } from '../common/jarvis-protocol';
import type { JarvisController } from './jarvis-controller';

/** Lado del canvas en px CSS. */
export const JARVIS_BUBBLE_SIZE = 128;
/** Desplazamiento mínimo para que un mousedown cuente como arrastre y no como clic. */
const DRAG_THRESHOLD_PX = 4;
/** Tiempo que queda visible la transcripción tras el último fragmento. */
const TRANSCRIPT_TTL_MS = 7000;
const BLOB_SEGMENTS = 96;
/** Tamaño del menú contextual (debe coincidir con `.fokkus-jarvis-menu` en jarvis.css). */
const MENU_WIDTH = 236;
const MENU_HEIGHT = 196;

type TranscriptKind = 'user' | 'user-interim' | 'assistant' | 'error';

interface TranscriptLine {
    kind: TranscriptKind;
    text: string;
}

interface MenuPosition {
    x: number;
    y: number;
}

/** Monta el árbol React de Jarvis. El árbol vive en el IDE y pinta con un portal en el destino actual. */
export function mountJarvisBubble(host: HTMLElement, controller: JarvisController): Root {
    const root = createRoot(host);
    root.render(<JarvisBubblePortal controller={controller} />);
    return root;
}

function JarvisBubblePortal({ controller }: { controller: JarvisController }): React.ReactElement | undefined {
    const [, forceRender] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
        const disposable = controller.onDidChange(() => forceRender());
        return () => disposable.dispose();
    }, [controller]);
    const target = controller.getPortalTarget();
    if (!controller.isVisible() || !target) {
        return undefined;
    }
    // `key` por destino: al pasar a la ventana overlay se recrea el canvas con el rAF de esa ventana.
    const overlay = controller.isOverlayActive();
    return createPortal(<JarvisBubble key={overlay ? 'overlay' : 'in-app'} controller={controller} overlay={overlay} />, target);
}

interface JarvisBubbleProps {
    controller: JarvisController;
    overlay: boolean;
}

/**
 * Burbuja líquida de Jarvis (Issue #27, HU-2 y HU-3).
 * Clic izquierdo: silenciar/activar. Clic derecho: menú. Arrastrar: mover (in-app o la ventana overlay).
 */
export function JarvisBubble({ controller, overlay }: JarvisBubbleProps): React.ReactElement {
    const audio = controller.audio;
    const canvasRef = React.useRef<HTMLCanvasElement | undefined>(undefined);
    const containerRef = React.useRef<HTMLDivElement | undefined>(undefined);
    const [state, setState] = React.useState<JarvisState>(() => audio.getState());
    const [config, setConfig] = React.useState<JarvisConfig>(() => audio.getConfig());
    const [transcript, setTranscript] = React.useState<TranscriptLine | undefined>(undefined);
    const [menu, setMenu] = React.useState<MenuPosition | undefined>(undefined);
    const [position, setPosition] = React.useState<JarvisPoint>(() => controller.getInAppPosition());
    const [dragging, setDragging] = React.useState(false);

    // Refs que lee el bucle de animación sin re-crearlo en cada render.
    const stateRef = React.useRef(state);
    stateRef.current = state;
    const targetLevelRef = React.useRef(0);

    React.useEffect(() => {
        const hideTimer = { id: undefined as number | undefined };
        const showLine = (line: TranscriptLine): void => {
            setTranscript(line);
            if (hideTimer.id !== undefined) {
                window.clearTimeout(hideTimer.id);
            }
            hideTimer.id = window.setTimeout(() => setTranscript(undefined), TRANSCRIPT_TTL_MS);
        };
        const disposables = [
            audio.onStateChanged(next => setState(next)),
            audio.onConfigChanged(next => setConfig(next)),
            audio.onAudioLevel(level => {
                targetLevelRef.current = level;
            }),
            audio.onTranscript(fragment => showLine({ kind: fragment.isFinal ? 'user' : 'user-interim', text: fragment.text })),
            audio.onAssistantSpeech(text => showLine({ kind: 'assistant', text })),
            audio.onError(message => showLine({ kind: 'error', text: message }))
        ];
        return () => {
            disposables.forEach(disposable => disposable.dispose());
            if (hideTimer.id !== undefined) {
                window.clearTimeout(hideTimer.id);
            }
        };
    }, [audio]);

    // Bucle de animación con el requestAnimationFrame de la ventana que contiene el canvas.
    React.useEffect(() => {
        const canvas = canvasRef.current;
        const view = canvas?.ownerDocument.defaultView;
        const context = canvas?.getContext('2d');
        if (!canvas || !view || !context) {
            return undefined;
        }
        const ratio = view.devicePixelRatio || 1;
        canvas.width = JARVIS_BUBBLE_SIZE * ratio;
        canvas.height = JARVIS_BUBBLE_SIZE * ratio;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        let level = 0;
        let frameId = 0;
        const draw = (now: number): void => {
            level = smoothAudioLevel(level, targetLevelRef.current);
            drawBubble(context, now / 1000, stateRef.current, level);
            frameId = view.requestAnimationFrame(draw);
        };
        frameId = view.requestAnimationFrame(draw);
        return () => view.cancelAnimationFrame(frameId);
    }, []);

    // Cerrar el menú con Escape o clic fuera.
    React.useEffect(() => {
        if (!menu) {
            return undefined;
        }
        const doc = containerRef.current?.ownerDocument ?? document;
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                setMenu(undefined);
            }
        };
        const onPointer = (event: MouseEvent): void => {
            const menuElement = containerRef.current?.querySelector('.fokkus-jarvis-menu');
            if (menuElement && !menuElement.contains(event.target as Node)) {
                setMenu(undefined);
            }
        };
        doc.addEventListener('keydown', onKey);
        doc.addEventListener('mousedown', onPointer, true);
        return () => {
            doc.removeEventListener('keydown', onKey);
            doc.removeEventListener('mousedown', onPointer, true);
        };
    }, [menu]);

    // Mantener la burbuja dentro del viewport si cambia el tamaño de la ventana del IDE.
    React.useEffect(() => {
        if (overlay) {
            return undefined;
        }
        const onResize = (): void => setPosition(current => controller.clampInApp(current));
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [overlay, controller]);

    const onMouseDown = React.useCallback((event: React.MouseEvent) => {
        if (event.button !== 0) {
            return;
        }
        event.preventDefault();
        const doc = event.currentTarget.ownerDocument;
        const startX = event.screenX;
        const startY = event.screenY;
        let lastX = startX;
        let lastY = startY;
        const origin = controller.getInAppPosition();
        let moved = false;
        const onMove = (moveEvent: MouseEvent): void => {
            if (!moved && Math.hypot(moveEvent.screenX - startX, moveEvent.screenY - startY) < DRAG_THRESHOLD_PX) {
                return;
            }
            if (!moved) {
                moved = true;
                setDragging(true);
            }
            if (overlay) {
                controller.moveOverlayBy(moveEvent.screenX - lastX, moveEvent.screenY - lastY);
            } else {
                setPosition(controller.clampInApp({ x: origin.x + moveEvent.screenX - startX, y: origin.y + moveEvent.screenY - startY }));
            }
            lastX = moveEvent.screenX;
            lastY = moveEvent.screenY;
        };
        const onUp = (upEvent: MouseEvent): void => {
            doc.removeEventListener('mousemove', onMove);
            doc.removeEventListener('mouseup', onUp);
            if (!moved) {
                audio.toggleMute();
                return;
            }
            setDragging(false);
            if (overlay) {
                controller.saveOverlayPosition();
            } else {
                controller.saveInAppPosition({ x: origin.x + upEvent.screenX - startX, y: origin.y + upEvent.screenY - startY });
            }
        };
        doc.addEventListener('mousemove', onMove);
        doc.addEventListener('mouseup', onUp);
    }, [audio, controller, overlay]);

    const onContextMenu = React.useCallback((event: React.MouseEvent) => {
        event.preventDefault();
        const container = containerRef.current;
        if (!container) {
            return;
        }
        // Coordenadas relativas al contenedor, ajustadas para que el menú no salga del viewport
        // (en la ventana overlay el viewport es la propia ventana de 280×320).
        const bounds = container.getBoundingClientRect();
        const viewport = container.ownerDocument.defaultView ?? window;
        const maxX = Math.min(bounds.width, viewport.innerWidth - bounds.left) - MENU_WIDTH - 4;
        const maxY = viewport.innerHeight - bounds.top - MENU_HEIGHT - 4;
        setMenu({
            x: Math.max(4 - bounds.left, Math.min(event.clientX - bounds.left, maxX)),
            y: Math.max(4 - bounds.top, Math.min(event.clientY - bounds.top, maxY))
        });
    }, []);

    const runMenuAction = (action: () => void): void => {
        setMenu(undefined);
        action();
    };

    const muted = state === 'muted';
    const label = JARVIS_STATE_LABELS[state];
    const style: React.CSSProperties | undefined = overlay ? undefined : { left: position.x, top: position.y };
    const classes = ['fokkus-jarvis', `fokkus-jarvis--${state}`];
    if (overlay) {
        classes.push('fokkus-jarvis--overlay');
    }
    if (dragging) {
        classes.push('fokkus-jarvis--dragging');
    }

    return (
        <div ref={element => { containerRef.current = element ?? undefined; }} className={classes.join(' ')} style={style}>
            <div
                className='fokkus-jarvis-bubble'
                role='button'
                aria-label={`Jarvis: ${label}. Clic para ${muted ? 'activar' : 'silenciar'} el micrófono; clic derecho para el menú`}
                title={`Jarvis — ${label}\nClic: ${muted ? 'activar' : 'silenciar'} micrófono · Clic derecho: menú · Arrastrar: mover`}
                onMouseDown={onMouseDown}
                onContextMenu={onContextMenu}
                onMouseEnter={() => controller.setBubbleHover(true)}
                onMouseLeave={() => controller.setBubbleHover(false)}
            >
                <canvas
                    ref={element => { canvasRef.current = element ?? undefined; }}
                    className='fokkus-jarvis-canvas'
                    style={{ width: JARVIS_BUBBLE_SIZE, height: JARVIS_BUBBLE_SIZE }}
                />
                <span className={`fokkus-jarvis-badge fokkus-jarvis-badge--${state}`}>
                    {label}
                    {config.gamingMode && <span className='fokkus-jarvis-badge-gaming' title='Modo Gaming: sigue oyendo en segundo plano'>· Gaming</span>}
                </span>
            </div>
            {transcript && (
                <div className={`fokkus-jarvis-transcript fokkus-jarvis-transcript--${transcript.kind}`} aria-live='polite'>
                    <span className='fokkus-jarvis-transcript-who'>{transcript.kind === 'assistant' ? 'Jarvis' : transcript.kind === 'error' ? 'Aviso' : 'Tú'}</span>
                    {summarizeTranscript(transcript.text)}
                </div>
            )}
            {menu && (
                <div className='fokkus-jarvis-menu' role='menu' style={{ left: menu.x, top: menu.y }} onContextMenu={event => event.preventDefault()}>
                    <button type='button' role='menuitem' className='fokkus-jarvis-menu-item' onClick={() => runMenuAction(() => audio.toggleMute())}>
                        {muted ? 'Activar micrófono' : 'Silenciar micrófono'}
                    </button>
                    <button type='button' role='menuitemcheckbox' aria-checked={config.gamingMode} className='fokkus-jarvis-menu-item'
                        onClick={() => runMenuAction(() => audio.toggleGamingMode())}>
                        <span className='fokkus-jarvis-menu-check'>{config.gamingMode ? '✓' : ''}</span>
                        Seguir oyendo en segundo plano (Modo Gaming)
                    </button>
                    {controller.isElectron() && (
                        <button type='button' role='menuitemcheckbox' aria-checked={controller.isOverlayRequested()} className='fokkus-jarvis-menu-item'
                            onClick={() => runMenuAction(() => controller.toggleOverlay())}>
                            <span className='fokkus-jarvis-menu-check'>{controller.isOverlayRequested() ? '✓' : ''}</span>
                            Flotar sobre otras ventanas
                        </button>
                    )}
                    <button type='button' role='menuitem' className='fokkus-jarvis-menu-item'
                        onClick={() => runMenuAction(() => { controller.openChat().catch(error => console.warn('[fokkus-jarvis] No se pudo abrir el chat', error)); })}>
                        Abrir chat de Fokkus Team
                    </button>
                    <div className='fokkus-jarvis-menu-separator' />
                    <button type='button' role='menuitem' className='fokkus-jarvis-menu-item' onClick={() => runMenuAction(() => controller.hide())}>
                        Ocultar Jarvis
                    </button>
                </div>
            )}
        </div>
    );
}

// -------------------------------------------------------------------------------------------------
// Dibujo
// -------------------------------------------------------------------------------------------------

function traceBlob(context: CanvasRenderingContext2D, center: number, baseRadius: number, time: number, level: number, state: JarvisState): void {
    const theme = JARVIS_THEMES[state];
    context.beginPath();
    for (let i = 0; i <= BLOB_SEGMENTS; i++) {
        const angle = (i / BLOB_SEGMENTS) * Math.PI * 2;
        const radius = blobRadius(angle, time, baseRadius, level, theme);
        const x = center + Math.cos(angle) * radius;
        const y = center + Math.sin(angle) * radius;
        if (i === 0) {
            context.moveTo(x, y);
        } else {
            context.lineTo(x, y);
        }
    }
    context.closePath();
}

function drawBubble(context: CanvasRenderingContext2D, time: number, state: JarvisState, level: number): void {
    const size = JARVIS_BUBBLE_SIZE;
    const center = size / 2;
    const baseRadius = size * 0.3;
    const theme = JARVIS_THEMES[state];
    context.clearRect(0, 0, size, size);

    // Gota con halo: el gradiente radial gira alrededor del centro (muy rápido en 'thinking').
    const rotation = time * theme.rotation;
    const highlightX = center + Math.cos(rotation) * baseRadius * 0.35;
    const highlightY = center + Math.sin(rotation) * baseRadius * 0.35;
    const gradient = context.createRadialGradient(highlightX, highlightY, baseRadius * 0.08, center, center, baseRadius * 1.35);
    gradient.addColorStop(0, theme.core);
    gradient.addColorStop(0.55, theme.mid);
    gradient.addColorStop(1, theme.edge);

    context.save();
    context.shadowColor = theme.glow;
    context.shadowBlur = 14 + level * 26;
    traceBlob(context, center, baseRadius, time, level, state);
    context.fillStyle = gradient;
    context.fill();
    context.restore();

    // Onda sinusoidal interna, recortada a la gota y proporcional al nivel de audio.
    context.save();
    traceBlob(context, center, baseRadius, time, level, state);
    context.clip();
    const width = baseRadius * 2.2;
    const left = center - width / 2;
    for (const layer of [{ alpha: 0.6, phase: 0, line: 2 }, { alpha: 0.28, phase: 1.7, line: 1.5 }]) {
        context.beginPath();
        for (let i = 0; i <= 64; i++) {
            const u = i / 64;
            const y = center + innerWaveOffset(u, time + layer.phase, baseRadius * 0.55, level);
            if (i === 0) {
                context.moveTo(left + u * width, y);
            } else {
                context.lineTo(left + u * width, y);
            }
        }
        context.strokeStyle = `rgba(255, 255, 255, ${layer.alpha})`;
        context.lineWidth = layer.line;
        context.stroke();
    }
    context.restore();

    if (state === 'muted') {
        drawMutedIcon(context, center);
    }
}

/** Micrófono tachado dibujado en el canvas (la ventana overlay no tiene Font Awesome). */
function drawMutedIcon(context: CanvasRenderingContext2D, center: number): void {
    context.save();
    context.strokeStyle = 'rgba(69, 26, 3, 0.9)';
    context.fillStyle = 'rgba(69, 26, 3, 0.9)';
    context.lineWidth = 2.5;
    context.lineCap = 'round';
    const capsuleWidth = 10;
    const capsuleHeight = 18;
    const top = center - 14;
    context.beginPath();
    context.moveTo(center - capsuleWidth / 2, top + capsuleWidth / 2);
    context.arc(center, top + capsuleWidth / 2, capsuleWidth / 2, Math.PI, 0);
    context.lineTo(center + capsuleWidth / 2, top + capsuleHeight - capsuleWidth / 2);
    context.arc(center, top + capsuleHeight - capsuleWidth / 2, capsuleWidth / 2, 0, Math.PI);
    context.closePath();
    context.fill();
    context.beginPath();
    context.arc(center, top + capsuleHeight - 6, 9, 0.15 * Math.PI, 0.85 * Math.PI);
    context.moveTo(center, top + capsuleHeight + 3);
    context.lineTo(center, top + capsuleHeight + 8);
    context.stroke();
    context.beginPath();
    context.moveTo(center - 13, top - 2);
    context.lineTo(center + 13, top + capsuleHeight + 8);
    context.stroke();
    context.restore();
}
