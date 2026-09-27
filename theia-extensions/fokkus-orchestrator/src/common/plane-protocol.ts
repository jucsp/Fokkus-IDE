/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export const PlaneServerPath = '/services/fokkus-plane';
export const PlaneServer = Symbol('PlaneServer');

export interface PlaneConfigStatus {
    baseUrl: string;
    workspace: string;
    hasApiKey: boolean;
}

export interface PlaneConfigInput {
    baseUrl: string;
    workspace: string;
    /** Vacío o undefined = conservar la API Key actual. */
    apiKey?: string;
}

export interface PlaneMember {
    id: string;
    displayName: string;
    fullName: string;
    email: string;
}

export interface PlaneProject {
    id: string;
    name: string;
    identifier: string;
}

export interface PlaneModule {
    id: string;
    name: string;
    status?: string;
}

export interface PlaneState {
    id: string;
    name: string;
    group?: string;
    color?: string;
}

export interface PlaneIssue {
    id: string;
    projectId: string;
    code: string;
    title: string;
    estimate?: string;
    descriptionHtml: string;
    sequenceId?: number;
    stateId?: string;
}

export interface PlaneIssueQuery {
    projectId: string;
    assigneeId: string;
    moduleId?: string;
    stateId?: string;
}

export interface PlaneServer {
    getConfig(): Promise<PlaneConfigStatus>;
    saveConfig(input: PlaneConfigInput): Promise<PlaneConfigStatus>;
    listMembers(): Promise<PlaneMember[]>;
    listProjects(): Promise<PlaneProject[]>;
    listModules(projectId: string): Promise<PlaneModule[]>;
    listStates(projectId: string): Promise<PlaneState[]>;
    listIssues(query: PlaneIssueQuery): Promise<PlaneIssue[]>;
    /** Devuelve data URI (`data:<mime>;base64,...`) o undefined si no se pudo. Nunca escribe a disco. */
    fetchImage(url: string): Promise<string | undefined>;
}
