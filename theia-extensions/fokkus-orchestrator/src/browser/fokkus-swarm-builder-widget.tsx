/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import {
    ReactFlow,
    Background,
    Controls,
    Panel,
    Edge,
    addEdge,
    applyNodeChanges,
    applyEdgeChanges,
    NodeChange,
    EdgeChange,
    Connection,
    BackgroundVariant,
    NodeTypes,
    MarkerType,
    OnBeforeDelete
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { DynamicRole, ProvidersState, RolesState, SwarmEdge, TeamAssignments } from '../common/fokkus-orchestrator-protocol';
import { FokkusSwarmNode, SwarmNode, SwarmNodeProviderOption } from './fokkus-swarm-node';

const nodeTypes: NodeTypes = {
    fokkusSwarmNode: FokkusSwarmNode
};

const EDGE_COLOR = '#3b82f6';

function isPrimaryRole(role: DynamicRole): boolean {
    if (role.isPrimary !== undefined) {
        return role.isPrimary;
    }
    return role.id === 'po' || role.id === 'product-owner';
}

/** Grid fallback used the first time a role appears on the canvas. */
function defaultPosition(index: number): { x: number; y: number } {
    return { x: 250 + (index % 3) * 280, y: 150 + Math.floor(index / 3) * 200 };
}

/** PO -> every other role, so the hierarchy is visible without any manual wiring. */
function buildHierarchyEdges(roles: DynamicRole[]): Edge[] {
    const primary = roles.find(isPrimaryRole);
    if (!primary) {
        return [];
    }
    return roles
        .filter(role => role.id !== primary.id)
        .map(role => ({
            id: `${primary.id}->${role.id}`,
            source: primary.id,
            target: role.id,
            animated: true,
            zIndex: 1000,
            style: { stroke: EDGE_COLOR, strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, width: 20, height: 20, color: '#3b82f6' }
        }));
}

/** Preferences only persist {id, source, target}; re-apply the standard visuals on restore. */
function styleRestoredEdges(edges: SwarmEdge[]): Edge[] {
    return edges.map(edge => ({
        ...edge,
        animated: true,
        zIndex: 1000,
        style: { stroke: EDGE_COLOR, strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, width: 20, height: 20, color: EDGE_COLOR }
    }));
}

export type SwarmNodePositions = Record<string, { x: number; y: number }>;

export interface SwarmBuilderProps {
    providersState: ProvidersState;
    rolesState: RolesState;
    assignments: TeamAssignments;
    /** Edges restored from preferences; when non-empty they take priority over the auto-generated hierarchy. */
    edges: SwarmEdge[];
    /** Node positions restored from preferences, keyed by role id. */
    positions: SwarmNodePositions;
    providerOptions: SwarmNodeProviderOption[];
    onOpenRoleSettings: (roleId: string) => void;
    onAssignmentChange: (roleId: string, providerId: string) => void;
    onNameChange?: (roleId: string, newName: string) => void;
    onSetPrimary?: (roleId: string) => void;
    /** Called when the user asks to delete a role from the graph; the parent confirms and removes it. */
    onDeleteRole?: (roleId: string) => void;
    /** Triggered by the "✚ Añadir Agente" panel button; creates a role and opens its rules modal. */
    onAddRole: () => void;
    /** Reports the current graph edges upward so the backend can persist the team hierarchy. */
    onEdgesChange?: (edges: SwarmEdge[]) => void;
    /** Reports the current node positions upward so the backend can persist the layout. */
    onPositionsChange?: (positions: SwarmNodePositions) => void;
    onImportTeam?: (roles: any[], edges: any[]) => void;
}

export function SwarmBuilder({
    providersState,
    rolesState,
    assignments,
    edges: persistedEdges,
    positions,
    providerOptions,
    onOpenRoleSettings,
    onAssignmentChange,
    onNameChange,
    onSetPrimary,
    onDeleteRole,
    onAddRole,
    onEdgesChange,
    onPositionsChange,
    onImportTeam
}: SwarmBuilderProps): React.ReactElement {
    const [nodes, setNodes] = React.useState<SwarmNode[]>([]);
    const [edges, setEdges] = React.useState<Edge[]>(
        () => persistedEdges.length > 0 ? styleRestoredEdges(persistedEdges) : buildHierarchyEdges(Object.values(rolesState))
    );
    // Skip auto-seeding once we already have edges — either restored from
    // preferences on mount, or seeded here the first time roles became available.
    const edgesSeededRef = React.useRef(persistedEdges.length > 0);

    // Re-derive nodes whenever roles/providers/assignments change, but keep the
    // position of every node the user already dragged instead of resetting the
    // whole layout (the previous implementation only computed nodes once via
    // useState's lazy initializer, so the graph never reflected new roles).
    React.useEffect(() => {
        const roles = Object.values(rolesState);
        setNodes(roles.map((role, index) => {
            const providerId = assignments[role.id];
            const provider = providerId ? providersState[providerId] : undefined;
            return {
                id: role.id,
                type: 'fokkusSwarmNode',
                position: positions[role.id] ?? defaultPosition(index),
                data: {
                    label: role.name,
                    role: role.id,
                    providerId,
                    providerName: provider ? provider.name : '',
                    providerOptions,
                    isPrimary: isPrimaryRole(role),
                    hasRules: Boolean(role.systemPrompt && role.systemPrompt.trim().length > 0),
                    onSettingsClick: () => onOpenRoleSettings(role.id),
                    onAssignmentChange,
                    onNameChange,
                    onSetPrimary,
                    onDeleteClick: onDeleteRole ? () => onDeleteRole(role.id) : undefined
                }
            };
        }));

        // Drop edges left dangling by a deleted role. Skipped while roles are still
        // empty (preferences not hydrated yet) so restored edges are not wiped.
        if (roles.length > 0) {
            setEdges(eds => {
                const pruned = eds.filter(edge => rolesState[edge.source] && rolesState[edge.target]);
                return pruned.length === eds.length ? eds : pruned;
            });
        }

        if (!edgesSeededRef.current && roles.length > 0) {
            edgesSeededRef.current = true;
            setEdges(buildHierarchyEdges(roles));
        }
    }, [rolesState, providersState, assignments, providerOptions, onOpenRoleSettings, onAssignmentChange, onNameChange, onSetPrimary, onDeleteRole]);

    const onNodesChange = React.useCallback(
        (changes: NodeChange<SwarmNode>[]) => {
            const next = applyNodeChanges(changes, nodes);
            setNodes(next);
            const newPositions: SwarmNodePositions = {};
            next.forEach(node => { newPositions[node.id] = node.position; });
            onPositionsChange?.(newPositions);
        },
        [nodes, onPositionsChange]
    );
    const handleEdgesChange = React.useCallback(
        (changes: EdgeChange[]) => setEdges(eds => applyEdgeChanges(changes, eds)),
        []
    );
    const onConnect = React.useCallback(
        (params: Connection) => setEdges(eds => addEdge({
            ...params,
            animated: true,
            zIndex: 1000,
            style: { stroke: EDGE_COLOR, strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, width: 20, height: 20, color: '#3b82f6' }
        }, eds)),
        []
    );
    const onEdgeDoubleClick = React.useCallback(
        (_event: React.MouseEvent, edge: Edge) => setEdges(eds => eds.filter(x => x.id !== edge.id)),
        []
    );
    const handleBeforeDelete = React.useCallback<OnBeforeDelete<SwarmNode, Edge>>(
        async ({ nodes: toDelete }) => {
            if (toDelete.length > 0) {
                if (toDelete.length === 1) {
                    onDeleteRole?.(toDelete[0].id);
                }
                return false;
            }
            return true;
        },
        [onDeleteRole]
    );

    // Inform the parent whenever the graph hierarchy changes so the backend can
    // persist it into `.fokkus/team_config.json`.
    React.useEffect(() => {
        onEdgesChange?.(edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target })));
    }, [edges, onEdgesChange]);

    const handleExport = React.useCallback(() => {
        const exportData = {
            roles: Object.values(rolesState),
            edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target }))
        };
        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'fokkus-swarm-architecture.json';
        a.click();
        URL.revokeObjectURL(url);
    }, [rolesState, edges]);

    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const handleImportClick = React.useCallback(() => {
        if (fileInputRef.current) {
            fileInputRef.current.click();
        }
    }, []);

    const handleImportFile = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target?.result as string);
                if (data && Array.isArray(data.roles) && Array.isArray(data.edges)) {
                    setEdges(styleRestoredEdges(data.edges));
                    onImportTeam?.(data.roles, data.edges);
                }
            } catch (err) {
                console.error("Error parsing import file", err);
            }
        };
        reader.readAsText(file);
        event.target.value = '';
    }, [onImportTeam]);

    return (
        <div
            className="fokkus-swarm-builder-container"
            tabIndex={0}
            onKeyDown={e => e.stopPropagation()}
        >
            <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={handleEdgesChange}
                onConnect={onConnect}
                onEdgeDoubleClick={onEdgeDoubleClick}
                onBeforeDelete={handleBeforeDelete}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.3 }}
                proOptions={{ hideAttribution: true }}
            >
                <Background color="rgba(255,255,255,0.05)" gap={20} size={2} variant={BackgroundVariant.Dots} />
                <Controls style={{ backgroundColor: 'rgba(30, 30, 42, 0.8)', fill: '#fff', border: 'none' }} />
                <Panel position="top-right">
                    <button type="button" className="fokkus-swarm-add-agent-btn" onClick={handleExport} style={{ marginRight: '8px' }}>
                        <i className="fa fa-download" /> Exportar
                    </button>
                    <button type="button" className="fokkus-swarm-add-agent-btn" onClick={handleImportClick} style={{ marginRight: '8px' }}>
                        <i className="fa fa-upload" /> Importar
                    </button>
                    <input type="file" ref={fileInputRef} style={{ display: 'none' }} accept=".json" onChange={handleImportFile} />
                    <button type="button" className="fokkus-swarm-add-agent-btn" onClick={onAddRole}>
                        ✚ Añadir Agente
                    </button>
                </Panel>
            </ReactFlow>
        </div>
    );
}
