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
import { issueDescriptionToText } from './plane-issue-detail';

const SANITIZE_OPTIONS = {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'object', 'embed', 'svg', 'math', 'link', 'meta'],
    // DOMPurify elimina por defecto cualquier atributo on*; se listan los más comunes
    // para reforzar la política ante descripciones provenientes de GitHub.
    FORBID_ATTR: ['onerror', 'onclick', 'onload', 'onmouseover', 'onfocus', 'onblur', 'onchange', 'onsubmit']
};

/** Sanitiza el HTML de GitHub y conserva solo las imágenes con `src` https. */
export function sanitizeGitHubHtml(html: string): string {
    const rawHtml = (html || '').trim();
    if (!rawHtml) {
        return '';
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, 'text/html');
    doc.querySelectorAll('img').forEach(img => {
        const src = img.getAttribute('src')?.trim() ?? '';
        if (!/^https:\/\//i.test(src)) {
            img.remove();
        }
    });

    const dirty = doc.body ? doc.body.innerHTML : rawHtml;
    return DOMPurify.sanitize(dirty, SANITIZE_OPTIONS);
}

interface GitHubHtmlProps {
    html: string;
    windowService: WindowService;
}

/** Renderiza la descripción de un PR ya sanitizada y abre los enlaces en el navegador externo. */
export function GitHubHtml({ html, windowService }: GitHubHtmlProps): React.ReactElement {
    const detailHtml = React.useMemo(() => sanitizeGitHubHtml(html), [html]);

    const handleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
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

    if (!detailHtml) {
        return (
            <div className='fokkus-backlog-detail fokkus-backlog-empty-description'>
                Sin descripción
            </div>
        );
    }

    return (
        <div
            className='fokkus-backlog-detail'
            onClick={handleClick}
            // HTML de GitHub sanitizado con DOMPurify en sanitizeGitHubHtml.
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: detailHtml }}
        />
    );
}

/** Convierte el HTML de la descripción a texto plano legible para incluir en un prompt. */
export function htmlToPlainText(html: string): string {
    return issueDescriptionToText(html);
}
