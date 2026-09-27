/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import DOMPurify from '@theia/core/shared/dompurify';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { PlaneConfigStatus, PlaneIssue, PlaneServer } from '../common/plane-protocol';

/** La URL original va en este atributo: con `src` el webview pediría la imagen sin credenciales (401 e icono roto). */
export const PLANE_SRC_ATTR = 'data-plane-src';

const SANITIZE_OPTIONS = {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'object', 'embed', 'svg', 'math', 'link', 'meta'],
    // DOMPurify elimina por defecto cualquier atributo on*; se listan los más comunes
    // para reforzar la política ante descripciones provenientes de Plane.
    FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'onfocus', 'onblur', 'onchange', 'onsubmit'],
    ADD_ATTR: [PLANE_SRC_ATTR]
};

/** Transforma `<image-component>` a `<img>` y sanitiza el HTML del detalle. */
export function buildDetailHtml(issue: PlaneIssue, config: PlaneConfigStatus | undefined): string {
    const rawHtml = (issue.descriptionHtml || '').trim();
    if (!rawHtml) {
        return '';
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, 'text/html');

    if (config) {
        doc.querySelectorAll('image-component').forEach(el => {
            const assetId = el.getAttribute('src')?.trim();
            if (!assetId) {
                el.remove();
                return;
            }
            const url = `${config.baseUrl}/api/assets/v2/workspaces/${config.workspace}/projects/${issue.projectId}/${encodeURIComponent(assetId)}/`;
            const img = doc.createElement('img');
            img.setAttribute('src', url);
            const width = el.getAttribute('width');
            if (width) {
                img.setAttribute('width', width);
            }
            el.replaceWith(img);
        });
    }

    doc.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src')?.trim() ?? '';
        img.removeAttribute('src');
        if (!src) {
            return;
        }
        try {
            img.setAttribute(PLANE_SRC_ATTR, config ? new URL(src, config.baseUrl + '/').href : new URL(src).href);
        } catch {
            // URL no resoluble: la imagen se muestra como no disponible.
        }
    });

    const dirty = doc.body ? doc.body.innerHTML : rawHtml;
    return DOMPurify.sanitize(dirty, SANITIZE_OPTIONS);
}

interface PlaneIssueDetailProps {
    issue: PlaneIssue;
    config?: PlaneConfigStatus;
    planeServer: PlaneServer;
    windowService: WindowService;
}

/**
 * Detalle de un issue de Plane reutilizable (Backlog y Kanban).
 * Renderiza el mismo markup que antes mostraba el Backlog dentro de la tarjeta expandida.
 */
export function PlaneIssueDetail({ issue, config, planeServer, windowService }: PlaneIssueDetailProps): React.ReactElement {
    const detailRef = React.useRef<HTMLDivElement | undefined>(undefined);
    const detailHtml = React.useMemo(
        () => buildDetailHtml(issue, config),
        [issue, config]
    );

    // Resuelve las imágenes del detalle (a data URI) y, si fallan, muestra placeholder.
    React.useEffect(() => {
        const container = detailRef.current;
        if (!container) {
            return;
        }

        let cancelled = false;
        const replaceWithMissing = (img: HTMLImageElement, src: string): void => {
            const wrapper = document.createElement('span');
            wrapper.className = 'fokkus-backlog-img-missing';

            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'fokkus-backlog-img-missing-button';
            button.textContent = 'Abrir imagen en Plane';
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                windowService.openNewWindow(src, { external: true });
            });

            wrapper.appendChild(button);
            img.replaceWith(wrapper);
        };

        const images = Array.from(container.querySelectorAll<HTMLImageElement>('img'));
        images.forEach(img => {
            const src = img.getAttribute(PLANE_SRC_ATTR) || '';
            if (!/^https?:/i.test(src)) {
                img.remove();
                return;
            }
            planeServer.fetchImage(src)
                .then(dataUri => {
                    if (cancelled) {
                        return;
                    }
                    if (dataUri) {
                        img.setAttribute('src', dataUri);
                    } else {
                        replaceWithMissing(img, src);
                    }
                })
                .catch(() => {
                    if (!cancelled) {
                        replaceWithMissing(img, src);
                    }
                });
        });

        return () => {
            cancelled = true;
        };
    }, [detailHtml, planeServer, windowService]);

    const handleDetailClick = (event: React.MouseEvent<HTMLDivElement>): void => {
        const target = event.target as HTMLElement | undefined;
        const anchor = target?.closest('a');
        if (!anchor) {
            return;
        }
        event.preventDefault();
        const href = anchor.getAttribute('href');
        if (href && /^(https?:|mailto:)/i.test(href)) {
            windowService.openNewWindow(href, { external: true });
        }
    };

    if (!issue.descriptionHtml?.trim()) {
        return (
            <div className='fokkus-backlog-detail fokkus-backlog-empty-description'>
                Sin descripción
            </div>
        );
    }

    return (
        <div
            ref={element => { detailRef.current = element ?? undefined; }}
            className='fokkus-backlog-detail'
            onClick={handleDetailClick}
            // HTML de Plane ya sanitizado con DOMPurify en buildDetailHtml.
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: detailHtml }}
        />
    );
}

/** Convierte el HTML de la descripción a texto plano legible para incluir en un prompt. */
export function issueDescriptionToText(html: string): string {
    if (!html) {
        return '';
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    // Las imágenes y los componentes de imagen no aportan texto: se ignoran.
    doc.querySelectorAll('image-component, img').forEach(el => el.remove());

    // <br> equivale a un salto de línea.
    doc.querySelectorAll('br').forEach(br => br.replaceWith('\n'));

    // Agregar un salto después de los elementos de bloque para conservar los párrafos.
    doc.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, pre, blockquote, tr').forEach(el => {
        el.appendChild(document.createTextNode('\n'));
    });

    // Prefijar cada elemento de lista como viñeta.
    doc.querySelectorAll('li').forEach(li => {
        li.insertBefore(document.createTextNode('- '), li.firstChild);
    });

    const text = doc.body ? doc.body.textContent ?? '' : '';
    // Colapsar 3+ saltos de línea en 2, recortar espacios de cada línea y el final.
    const collapsed = text.replace(/\n{3,}/g, '\n\n');
    return collapsed.split('\n').map(line => line.trim()).join('\n').trim();
}
