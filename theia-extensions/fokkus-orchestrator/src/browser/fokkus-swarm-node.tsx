/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { Handle, Position, Node, NodeProps } from '@xyflow/react';

export interface SwarmNodeProviderOption {
    id: string;
    name: string;
}

export interface SwarmNodeData extends Record<string, unknown> {
    label: string;
    role: string;
    providerId?: string;
    providerName: string;
    providerOptions: SwarmNodeProviderOption[];
    isPrimary?: boolean;
    hasRules?: boolean;
    onSettingsClick?: () => void;
    onAssignmentChange?: (roleId: string, providerId: string) => void;
    onNameChange?: (roleId: string, newName: string) => void;
    onSetPrimary?: (roleId: string) => void;
}

export type SwarmNode = Node<SwarmNodeData, 'fokkusSwarmNode'>;

export function FokkusSwarmNode({ data, selected }: NodeProps<SwarmNode>): React.ReactElement {
    const isAssigned = Boolean(data.providerId);
    return (
        <div className={`fokkus-swarm-node ${selected ? 'selected' : ''} ${data.isPrimary ? 'primary' : ''}`}>
            {/* Handle superior para recibir delegaciones (solo si no es el nodo principal/raíz) */}
            {!data.isPrimary && (
                <Handle type="target" position={Position.Top} className="fokkus-node-handle" style={{ top: -15, zIndex: 10 }} />
            )}

            <div className="fokkus-swarm-node-header">
                <i 
                    className={`fa ${data.isPrimary ? 'fa-star' : 'fa-user-circle'}`} 
                    onClick={() => data.onSetPrimary?.(data.role)}
                    style={{ cursor: 'pointer' }}
                />
                <input 
                    className="node-label-input nodrag" 
                    value={data.label} 
                    style={{ backgroundColor: 'transparent', color: 'var(--theia-ui-font-color1)', boxShadow: 'none', border: 'none' }}
                    onChange={(e) => data.onNameChange?.(data.role, e.target.value)} 
                />
                {data.onSettingsClick && (
                    <button
                        className={`node-settings-btn ${data.hasRules ? 'node-settings-btn--configured' : ''}`}
                        onClick={data.onSettingsClick}
                        title="Configurar Reglas Base (System Prompt)"
                    >
                        <i className="fa fa-cog" />
                    </button>
                )}
            </div>

            <div className="fokkus-swarm-node-body">
                <div className="node-role">
                    <span className="badge">Rol: {data.role}</span>
                </div>
                <div className="node-provider">
                    <span className={`node-status-dot ${isAssigned ? 'node-status-dot--on' : ''}`} />
                    <i className="fa fa-microchip" />
                    <select
                        className="fokkus-node-select nodrag"
                        value={data.providerId ?? ''}
                        onChange={event => data.onAssignmentChange?.(data.role, event.target.value)}
                    >
                        <option value='' disabled>Sin asignar</option>
                        {data.providerOptions.map(option => (
                            <option key={option.id} value={option.id}>{option.name}</option>
                        ))}
                    </select>
                </div>
            </div>

            {/* Handle inferior para delegar a otros nodos */}
            <Handle type="source" position={Position.Bottom} className="fokkus-node-handle" style={{ bottom: -15, zIndex: 10 }} />
        </div>
    );
}
