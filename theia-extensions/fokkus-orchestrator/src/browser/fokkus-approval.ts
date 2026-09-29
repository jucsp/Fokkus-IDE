/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// La lógica pura de aprobaciones vive en `common/` para poder compartirla entre
// el frontend (tarjetas Aprobar/Rechazar) y el backend (resolución del estado a
// partir del historial). Este módulo solo reexporta esa API pública para no
// romper los imports existentes del navegador.

export type {
    ApprovalDecision,
    ApprovalRequest,
    ApprovalRisk,
    ApprovalState,
    ResolvedApprovalState
} from '../common/fokkus-approval';

export {
    buildApprovalResponse,
    extractLastApprovalRequest,
    parseApprovalRequest,
    parseApprovalResponses,
    resolveApprovalDecision,
    resolveApprovalState,
    stripApprovalResponseMarkers
} from '../common/fokkus-approval';
