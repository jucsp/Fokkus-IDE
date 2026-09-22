/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { Event } from '@theia/core/lib/common/event';

export const FokkusOrchestratorServerPath = '/services/fokkus-orchestrator';
export const FokkusOrchestratorServer = Symbol('FokkusOrchestratorServer');

export interface DynamicProvider {
    id: string;
    name: string;
    type: 'api' | 'cli';
    config: Record<string, string>;
}

export interface DynamicRole {
    id: string;
    name: string;
    description: string;
    /** System prompt ("Base Rules") injected into this role's agent on every dispatch. */
    systemPrompt?: string;
    isPrimary?: boolean;
}

export type ProvidersState = Record<string, DynamicProvider>;

export type RolesState = Record<string, DynamicRole>;

/** Maps a DynamicRole id to the DynamicProvider id assigned to play that role. */
export type TeamAssignments = Record<string, string>;

/** A directed edge in the Swarm Builder graph (source role id -> target role id). */
export interface SwarmEdge {
    id: string;
    source: string;
    target: string;
}

/** Full team snapshot persisted to `.fokkus/team_config.json` (project-scoped and provider-agnostic). */
export interface TeamConfiguration {
    providers: ProvidersState;
    roles: RolesState;
    team: TeamAssignments;
    edges: SwarmEdge[];
}

export interface SwarmAgentResult {
    roleId: string;
    providerId: string;
    providerName: string;
    status: 'completed' | 'failed' | 'skipped';
    output: string;
    error?: string;
}

export interface SwarmDispatchResult {
    workspacePath: string;
    roleResults: SwarmAgentResult[];
}

export interface ChatAttachment {
    fileName: string;
    mimeType: string;
    base64Data: string;
}

export interface ChatMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    attachments?: ChatAttachment[];
}

export interface DesktopEnvironment {
    platform: string;
    desktop: string;
}

export interface FokkusOrchestratorServer {
    executeTask(task: string): Promise<string>;
    getWorkspaceDiff(workspacePath: string): Promise<string>;
    approveDiff(workspacePath: string): Promise<void>;
    rejectDiff(workspacePath: string): Promise<void>;
    dispatchToSwarm(workspacePath: string, prompt: string, mode: string, team: TeamAssignments, providers: ProvidersState, attachments?: ChatAttachment[], roles?: RolesState, edges?: SwarmEdge[]): Promise<SwarmDispatchResult>;
    addProvider(provider: DynamicProvider): Promise<void>;
    assignRole(roleId: string, providerId: string): Promise<void>;
    saveTeamConfiguration(config: TeamConfiguration): Promise<void>;
    
    // Chat History Management
    saveChatHistory(workspacePath: string, history: ChatMessage[]): Promise<void>;
    loadChatHistory(workspacePath: string): Promise<ChatMessage[]>;
    clearChatHistory(workspacePath: string): Promise<void>;
    compactChatHistory(workspacePath: string, summary?: string): Promise<ChatMessage[]>;
    
    readonly onDidDispatchSwarm: Event<SwarmDispatchResult>;
    readonly onAgentLog: Event<string>;
    getDesktopEnvironment(): Promise<DesktopEnvironment>;
}
