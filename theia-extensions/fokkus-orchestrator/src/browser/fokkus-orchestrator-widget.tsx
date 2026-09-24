/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown, { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import mermaid from 'mermaid';
import { PreferenceScope, PreferenceService } from '@theia/core/lib/common';
import { CommandService } from '@theia/core/lib/common/command';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { ConfirmDialog } from '@theia/core/lib/browser';
import { WorkspaceService } from '@theia/workspace/lib/browser';

import {
    ChatAttachment,
    DynamicProvider,
    DynamicRole,
    FokkusOrchestratorServer,
    ProvidersState,
    RolesState,
    SwarmEdge,
    TeamAssignments,
    TeamConfiguration
} from '../common/fokkus-orchestrator-protocol';

import { SwarmBuilder, SwarmNodePositions } from './fokkus-swarm-builder-widget';
import { SwarmNodeProviderOption } from './fokkus-swarm-node';

export const FOKKUS_CHAT_WIDGET_ID = 'fokkus-chat-widget';
export const FOKKUS_SETTINGS_WIDGET_ID = 'fokkus-settings-widget';
export const FOKKUS_OPEN_SETTINGS_COMMAND_ID = 'fokkus:open-settings';
export const FOKKUS_ORCHESTRATOR_TOGGLE_COMMAND_ID = 'fokkus-orchestrator:toggle';

const PROVIDERS_PREFERENCE_KEY = 'fokkus-orchestrator.providers';
const ROLES_PREFERENCE_KEY = 'fokkus-orchestrator.roles';
const TEAM_PREFERENCE_KEY = 'fokkus-orchestrator.team';
const EDGES_PREFERENCE_KEY = 'fokkus-orchestrator.edges';
const POSITIONS_PREFERENCE_KEY = 'fokkus-orchestrator.positions';

/* ------------------------------------------------------------------------ */
/* Shared helpers: dynamic ids, seed data and preference (de)serialization  */
/* ------------------------------------------------------------------------ */

export function getWorkspacePath(workspaceService: WorkspaceService): string {
    const roots = workspaceService.tryGetRoots();
    if (roots.length > 0) {
        return roots[0].resource.toString();
    }
    return workspaceService.workspace ? workspaceService.workspace.resource.toString() : '';
}

function slugify(value: string): string {
    const slug = value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    return slug.length > 0 ? slug : 'item';
}

function generateId(existingIds: string[], base: string): string {
    const baseSlug = slugify(base);
    if (!existingIds.includes(baseSlug)) {
        return baseSlug;
    }
    let counter = 2;
    while (existingIds.includes(`${baseSlug}-${counter}`)) {
        counter++;
    }
    return `${baseSlug}-${counter}`;
}

interface ProviderFieldTemplate {
    key: string;
    label: string;
    placeholder: string;
    type: 'text' | 'password';
}

const PROVIDER_FIELDS_BY_TYPE: Record<DynamicProvider['type'], ProviderFieldTemplate[]> = {
    api: [
        { key: 'apiKey', label: 'API Key', placeholder: 'sk-••••••••••••••••', type: 'password' },
        { key: 'apiEndpoint', label: 'Base URL', placeholder: 'https://api.ejemplo.com', type: 'text' },
        { key: 'model', label: 'Modelo', placeholder: 'ej. deepseek-reasoner, gpt-4o', type: 'text' }
    ],
    cli: [
        { key: 'cliCommand', label: 'Comando CLI', placeholder: 'claude', type: 'text' }
    ]
};

const DEFAULT_PROVIDERS: DynamicProvider[] = [
    { id: 'deepseek-api', name: 'DeepSeek API', type: 'api', config: { apiKey: '', apiEndpoint: 'https://api.deepseek.com', model: 'deepseek-reasoner' } },
    { id: 'claude-cli', name: 'Claude CLI', type: 'cli', config: { cliCommand: 'claude' } },
    { id: 'openai-api', name: 'OpenAI API', type: 'api', config: { apiKey: '', apiEndpoint: 'https://api.openai.com/v1', model: 'gpt-4o' } },
    { id: 'ollama-local', name: 'Ollama Local', type: 'cli', config: { cliCommand: 'http://localhost:11434' } }
];

const DEFAULT_ROLES: DynamicRole[] = [
    { id: 'product-owner', name: 'Product Owner', description: 'Define la visión, prioriza el backlog y valida los entregables.' },
    { id: 'pm-qa', name: 'PM / QA', description: 'Coordina la calidad, ejecuta pruebas y asegura buenas prácticas.' },
    { id: 'senior-dev', name: 'Senior Dev', description: 'Diseña la lógica, los algoritmos y la arquitectura de backend.' }
];

function isDynamicProvider(value: unknown): value is DynamicProvider {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value as Partial<DynamicProvider>;
    return typeof candidate.id === 'string'
        && typeof candidate.name === 'string'
        && (candidate.type === 'api' || candidate.type === 'cli')
        && typeof candidate.config === 'object' && candidate.config !== undefined;
}

function isDynamicRole(value: unknown): value is DynamicRole {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value as Partial<DynamicRole>;
    return typeof candidate.id === 'string'
        && typeof candidate.name === 'string'
        && typeof candidate.description === 'string'
        && (candidate.systemPrompt === undefined || typeof candidate.systemPrompt === 'string');
}

function normalizeProvidersState(persisted: unknown): ProvidersState {
    if (!persisted || typeof persisted !== 'object') {
        const seeded: ProvidersState = {};
        DEFAULT_PROVIDERS.forEach(provider => { seeded[provider.id] = provider; });
        return seeded;
    }
    const state: ProvidersState = {};
    for (const [id, value] of Object.entries(persisted as Record<string, unknown>)) {
        if (isDynamicProvider(value)) {
            state[id] = value;
        }
    }
    return state;
}

function normalizeRolesState(persisted: unknown): RolesState {
    if (!persisted || typeof persisted !== 'object') {
        const seeded: RolesState = {};
        DEFAULT_ROLES.forEach(role => { seeded[role.id] = role; });
        return seeded;
    }
    const state: RolesState = {};
    for (const [id, value] of Object.entries(persisted as Record<string, unknown>)) {
        if (isDynamicRole(value)) {
            state[id] = value;
        }
    }
    return state;
}

function normalizeTeamAssignments(persisted: unknown): TeamAssignments {
    if (!persisted || typeof persisted !== 'object') {
        return {};
    }
    const assignments: TeamAssignments = {};
    for (const [roleId, value] of Object.entries(persisted as Record<string, unknown>)) {
        if (typeof value === 'string') {
            assignments[roleId] = value;
        }
    }
    return assignments;
}

/* ------------------------------------------------------------------------ */
/* Providers panel — CRUD over DynamicProvider                              */
/* ------------------------------------------------------------------------ */

const PROVIDER_TYPE_ICON: Record<DynamicProvider['type'], string> = {
    api: 'fa fa-cloud',
    cli: 'fa fa-terminal'
};

const PROVIDER_ACCENT = '#3b82f6';

interface ProvidersPanelProps {
    providersState: ProvidersState;
    onProvidersChange: (state: ProvidersState) => void;
}

function ProvidersPanel({ providersState, onProvidersChange }: ProvidersPanelProps): React.ReactElement {
    const providers = React.useMemo(() => Object.values(providersState), [providersState]);
    const [editingId, setEditingId] = React.useState<string | undefined>(undefined);
    const [formName, setFormName] = React.useState('');
    const [formType, setFormType] = React.useState<DynamicProvider['type']>('cli');
    const [formConfig, setFormConfig] = React.useState<Record<string, string>>({});

    const resetForm = React.useCallback(() => {
        setEditingId(undefined);
        setFormName('');
        setFormType('cli');
        setFormConfig({});
    }, []);

    const startEdit = React.useCallback((provider: DynamicProvider) => {
        setEditingId(provider.id);
        setFormName(provider.name);
        setFormType(provider.type);
        setFormConfig({ ...provider.config });
    }, []);

    const startCreate = React.useCallback(() => {
        setEditingId('__new__');
        setFormName('');
        setFormType('cli');
        setFormConfig({});
    }, []);

    const removeProvider = React.useCallback((id: string) => {
        const next = { ...providersState };
        delete next[id];
        onProvidersChange(next);
        if (editingId === id) {
            resetForm();
        }
    }, [providersState, onProvidersChange, editingId, resetForm]);

    const submitForm = React.useCallback(() => {
        const trimmedName = formName.trim();
        if (trimmedName.length === 0) {
            return;
        }
        const id = editingId && editingId !== '__new__'
            ? editingId
            : generateId(Object.keys(providersState), trimmedName);
        const provider: DynamicProvider = { id, name: trimmedName, type: formType, config: formConfig };
        onProvidersChange({ ...providersState, [id]: provider });
        resetForm();
    }, [formName, formType, formConfig, editingId, providersState, onProvidersChange, resetForm]);

    const updateConfigField = React.useCallback((key: string, value: string) => {
        setFormConfig(prev => ({ ...prev, [key]: value }));
    }, []);

    const isFormOpen = editingId !== undefined;
    const fieldTemplates = PROVIDER_FIELDS_BY_TYPE[formType];

    return (
        <>
            <header className='fokkus-orchestrator-header'>
                <h2 className='fokkus-orchestrator-title'>Proveedores de IA</h2>
                <p className='fokkus-orchestrator-subtitle'>
                    Registra los agentes que tu Swarm puede reclutar: claves de API, endpoints o comandos CLI locales.
                </p>
            </header>

            <div className='fokkus-provider-grid'>
                {providers.map(provider => (
                    <div key={provider.id} className='fokkus-provider-card' style={{ '--fokkus-accent': PROVIDER_ACCENT } as React.CSSProperties}>
                        <div className='fokkus-provider-card-glow' />
                        <div className='fokkus-provider-card-header'>
                            <div className='fokkus-provider-icon'>
                                <i className={PROVIDER_TYPE_ICON[provider.type]} />
                            </div>
                            <div className='fokkus-provider-heading'>
                                <span className='fokkus-provider-name'>{provider.name}</span>
                                <span className='fokkus-provider-tagline'>{provider.type === 'api' ? 'Proveedor vía API' : 'Agente vía CLI local'}</span>
                            </div>
                            <div className='fokkus-crud-actions'>
                                <button type='button' className='fokkus-icon-button' title='Editar' onClick={() => startEdit(provider)}>
                                    <i className='fa fa-pencil' />
                                </button>
                                <button type='button' className='fokkus-icon-button fokkus-icon-button--danger' title='Eliminar' onClick={() => removeProvider(provider.id)}>
                                    <i className='fa fa-trash' />
                                </button>
                            </div>
                        </div>
                    </div>
                ))}

                {!isFormOpen && (
                    <button type='button' className='fokkus-add-card' onClick={startCreate}>
                        <i className='fa fa-plus' />
                        <span>Agregar proveedor</span>
                    </button>
                )}
            </div>

            {isFormOpen && (
                <div className='fokkus-crud-form'>
                    <div className='fokkus-field'>
                        <label className='fokkus-field-label'>Nombre</label>
                        <input
                            className='fokkus-field-input'
                            type='text'
                            value={formName}
                            placeholder='Ej. Mistral API'
                            onChange={event => setFormName(event.target.value)}
                            autoFocus
                        />
                    </div>
                    <div className='fokkus-field'>
                        <label className='fokkus-field-label'>Tipo</label>
                        <select
                            className='fokkus-field-input'
                            value={formType}
                            onChange={event => {
                                const nextType = event.target.value as DynamicProvider['type'];
                                setFormType(nextType);
                                setFormConfig({});
                            }}
                        >
                            <option value='cli'>CLI local</option>
                            <option value='api'>API remota</option>
                        </select>
                    </div>
                    {fieldTemplates.map(field => (
                        <div className='fokkus-field' key={field.key}>
                            <label className='fokkus-field-label'>{field.label}</label>
                            <input
                                className='fokkus-field-input'
                                type={field.type}
                                placeholder={field.placeholder}
                                value={formConfig[field.key] ?? ''}
                                onChange={event => updateConfigField(field.key, event.target.value)}
                                autoComplete='off'
                                spellCheck={false}
                            />
                        </div>
                    ))}
                    <div className='fokkus-crud-form-actions'>
                        <button type='button' className='fokkus-form-button fokkus-form-button--primary' onClick={submitForm} disabled={formName.trim().length === 0}>
                            <i className='fa fa-check' />
                            <span>Guardar</span>
                        </button>
                        <button type='button' className='fokkus-form-button' onClick={resetForm}>
                            <i className='fa fa-times' />
                            <span>Cancelar</span>
                        </button>
                    </div>
                </div>
            )}
        </>
    );
}

/* ------------------------------------------------------------------------ */
/* Roles panel — CRUD over DynamicRole                                      */
/* ------------------------------------------------------------------------ */

const ROLE_ACCENT = '#f59e0b';

interface RolesPanelProps {
    rolesState: RolesState;
    onRolesChange: (state: RolesState) => void;
}

function RolesPanel({ rolesState, onRolesChange }: RolesPanelProps): React.ReactElement {
    const roles = React.useMemo(() => Object.values(rolesState), [rolesState]);
    const [editingId, setEditingId] = React.useState<string | undefined>(undefined);
    const [formName, setFormName] = React.useState('');
    const [formDescription, setFormDescription] = React.useState('');

    const resetForm = React.useCallback(() => {
        setEditingId(undefined);
        setFormName('');
        setFormDescription('');
    }, []);

    const startEdit = React.useCallback((role: DynamicRole) => {
        setEditingId(role.id);
        setFormName(role.name);
        setFormDescription(role.description);
    }, []);

    const startCreate = React.useCallback(() => {
        setEditingId('__new__');
        setFormName('');
        setFormDescription('');
    }, []);

    const removeRole = React.useCallback((id: string) => {
        const next = { ...rolesState };
        delete next[id];
        onRolesChange(next);
        if (editingId === id) {
            resetForm();
        }
    }, [rolesState, onRolesChange, editingId, resetForm]);

    const submitForm = React.useCallback(() => {
        const trimmedName = formName.trim();
        if (trimmedName.length === 0) {
            return;
        }
        const id = editingId && editingId !== '__new__'
            ? editingId
            : generateId(Object.keys(rolesState), trimmedName);
        const role: DynamicRole = { id, name: trimmedName, description: formDescription.trim() };
        onRolesChange({ ...rolesState, [id]: role });
        resetForm();
    }, [formName, formDescription, editingId, rolesState, onRolesChange, resetForm]);

    const isFormOpen = editingId !== undefined;

    return (
        <>
            <header className='fokkus-orchestrator-header'>
                <h2 className='fokkus-orchestrator-title'>Roles del Equipo</h2>
                <p className='fokkus-orchestrator-subtitle'>
                    Define los roles que tu Swarm necesita cubrir antes de asignarles un agente.
                </p>
            </header>

            <div className='fokkus-role-grid'>
                {roles.map(role => (
                    <div key={role.id} className='fokkus-role-card' style={{ '--fokkus-accent': ROLE_ACCENT } as React.CSSProperties}>
                        <div className='fokkus-role-card-glow' />
                        <div className='fokkus-role-card-header'>
                            <div className='fokkus-role-icon'>
                                <i className='fa fa-user-gear' />
                            </div>
                            <div className='fokkus-role-heading'>
                                <span className='fokkus-role-name'>{role.name}</span>
                                <span className='fokkus-role-description'>{role.description}</span>
                            </div>
                            <div className='fokkus-crud-actions'>
                                <button type='button' className='fokkus-icon-button' title='Editar' onClick={() => startEdit(role)}>
                                    <i className='fa fa-pencil' />
                                </button>
                                <button type='button' className='fokkus-icon-button fokkus-icon-button--danger' title='Eliminar' onClick={() => removeRole(role.id)}>
                                    <i className='fa fa-trash' />
                                </button>
                            </div>
                        </div>
                    </div>
                ))}

                {!isFormOpen && (
                    <button type='button' className='fokkus-add-card' onClick={startCreate}>
                        <i className='fa fa-plus' />
                        <span>Agregar rol</span>
                    </button>
                )}
            </div>

            {isFormOpen && (
                <div className='fokkus-crud-form'>
                    <div className='fokkus-field'>
                        <label className='fokkus-field-label'>Nombre</label>
                        <input
                            className='fokkus-field-input'
                            type='text'
                            value={formName}
                            placeholder='Ej. UX Researcher'
                            onChange={event => setFormName(event.target.value)}
                            autoFocus
                        />
                    </div>
                    <div className='fokkus-field'>
                        <label className='fokkus-field-label'>Descripción</label>
                        <input
                            className='fokkus-field-input'
                            type='text'
                            value={formDescription}
                            placeholder='¿Qué responsabilidad cubre este rol?'
                            onChange={event => setFormDescription(event.target.value)}
                        />
                    </div>
                    <div className='fokkus-crud-form-actions'>
                        <button type='button' className='fokkus-form-button fokkus-form-button--primary' onClick={submitForm} disabled={formName.trim().length === 0}>
                            <i className='fa fa-check' />
                            <span>Guardar</span>
                        </button>
                        <button type='button' className='fokkus-form-button' onClick={resetForm}>
                            <i className='fa fa-times' />
                            <span>Cancelar</span>
                        </button>
                    </div>
                </div>
            )}
        </>
    );
}

/* ------------------------------------------------------------------------ */
/* Role rules modal — HU-04: edit a role's Base Rules (System Prompt)       */
/* ------------------------------------------------------------------------ */

interface RoleRulesModalProps {
    role: DynamicRole;
    accent: string;
    onSave: (systemPrompt: string) => void;
    onClose: () => void;
}

function RoleRulesModal({ role, accent, onSave, onClose }: RoleRulesModalProps): React.ReactElement {
    const [draft, setDraft] = React.useState(role.systemPrompt ?? '');
    const textareaRef = React.useRef<HTMLTextAreaElement | undefined>(undefined);

    React.useEffect(() => {
        textareaRef.current?.focus();
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onClose();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    const style = { '--fokkus-accent': accent } as React.CSSProperties;

    return createPortal(
        <div className='fokkus-modal-overlay' style={style} onMouseDown={onClose}>
            <div className='fokkus-modal-panel' onMouseDown={event => event.stopPropagation()}>
                <div className='fokkus-modal-glow' />
                <header className='fokkus-modal-header'>
                    <div className='fokkus-role-icon'>
                        <i className='fa fa-scroll' />
                    </div>
                    <div className='fokkus-role-heading'>
                        <span className='fokkus-role-name'>Reglas Base — {role.name}</span>
                        <span className='fokkus-role-description'>
                            System Prompt que el Orquestador inyecta a este rol en cada despacho, junto con el contexto del equipo.
                        </span>
                    </div>
                    <button type='button' className='fokkus-modal-close' onClick={onClose} title='Cerrar'>
                        <i className='fa fa-times' />
                    </button>
                </header>

                <textarea
                    ref={element => { textareaRef.current = element ?? undefined; }}
                    className='fokkus-modal-textarea'
                    value={draft}
                    onChange={event => setDraft(event.target.value)}
                    placeholder={`Ej: Eres ${role.name}. ${role.description} Actúa siempre dentro de ese alcance…`}
                    rows={10}
                />

                <footer className='fokkus-modal-footer'>
                    <button type='button' className='fokkus-modal-button fokkus-modal-button--ghost' onClick={onClose}>
                        Cancelar
                    </button>
                    <button
                        type='button'
                        className='fokkus-modal-button fokkus-modal-button--primary'
                        onClick={() => onSave(draft.trim())}
                    >
                        <i className='fa fa-check' />
                        <span>Guardar reglas</span>
                    </button>
                </footer>
            </div>
        </div>,
        document.body
    );
}

/* ------------------------------------------------------------------------ */
/* Team builder — assigns a DynamicProvider id to each DynamicRole          */
/* ------------------------------------------------------------------------ */

interface TeamBuilderPanelProps {
    providersState: ProvidersState;
    rolesState: RolesState;
    assignments: TeamAssignments;
    edges: SwarmEdge[];
    positions: SwarmNodePositions;
    onAssignmentsChange: (assignments: TeamAssignments) => void;
    onRolesChange: (roles: RolesState) => void;
    onEdgesChange: (edges: SwarmEdge[]) => void;
    onPositionsChange: (positions: SwarmNodePositions) => void;
}

function TeamBuilderPanel({ providersState, rolesState, assignments, edges, positions, onAssignmentsChange, onRolesChange, onEdgesChange, onPositionsChange }: TeamBuilderPanelProps): React.ReactElement {
    const providerOptions = React.useMemo<SwarmNodeProviderOption[]>(
        () => Object.values(providersState).map(provider => ({ id: provider.id, name: provider.name })),
        [providersState]
    );
    const [editingRoleId, setEditingRoleId] = React.useState<string | undefined>(undefined);

    const assign = React.useCallback((roleId: string, providerId: string) => {
        onAssignmentsChange({ ...assignments, [roleId]: providerId });
    }, [assignments, onAssignmentsChange]);

    const saveRules = React.useCallback((roleId: string, systemPrompt: string) => {
        const target = rolesState[roleId];
        if (!target) {
            return;
        }
        onRolesChange({ ...rolesState, [roleId]: { ...target, systemPrompt } });
        setEditingRoleId(undefined);
    }, [rolesState, onRolesChange]);

    const handleNameChange = React.useCallback((roleId: string, newName: string) => {
        const target = rolesState[roleId];
        if (target) {
            onRolesChange({ ...rolesState, [roleId]: { ...target, name: newName } });
        }
    }, [rolesState, onRolesChange]);

    const handleSetPrimary = React.useCallback((roleId: string) => {
        const nextRoles = { ...rolesState };
        Object.keys(nextRoles).forEach(key => {
            nextRoles[key] = { ...nextRoles[key], isPrimary: key === roleId };
        });
        onRolesChange(nextRoles);
    }, [rolesState, onRolesChange]);

    const deleteRole = React.useCallback(async (roleId: string) => {
        const target = rolesState[roleId];
        if (!target) {
            return;
        }
        const confirmed = await new ConfirmDialog({
            title: 'Eliminar agente',
            msg: `¿Eliminar el agente «${target.name}»? Se quitarán sus conexiones y su asignación de proveedor.`,
            ok: 'Eliminar',
            cancel: 'Cancelar'
        }).open();
        if (!confirmed) {
            return;
        }
        const next = { ...rolesState };
        delete next[roleId];
        onRolesChange(next);
        setEditingRoleId(current => (current === roleId ? undefined : current));
    }, [rolesState, onRolesChange]);

    // Creates a new role straight from the graph's "✚ Añadir Agente" button and
    // immediately opens its rules modal, since the canvas is now the only place
    // to build the team (no more grid form to fall back on).
    const addRole = React.useCallback(() => {
        const id = generateId(Object.keys(rolesState), 'Nuevo Rol');
        const role: DynamicRole = { id, name: 'Nuevo Rol', description: '' };
        onRolesChange({ ...rolesState, [id]: role });
        setEditingRoleId(id);
    }, [rolesState, onRolesChange]);

    const handleImportTeam = React.useCallback((importedRoles: any[], importedEdges: any[]) => {
        const nextRoles: RolesState = {};
        importedRoles.forEach(r => {
            if (r && r.id) {
                nextRoles[r.id] = r;
            }
        });
        onRolesChange(nextRoles);
    }, [onRolesChange]);

    const editingRole = editingRoleId ? rolesState[editingRoleId] : undefined;

    return (
        <>
            <header className='fokkus-orchestrator-header'>
                <h2 className='fokkus-orchestrator-title'>Team Builder</h2>
                <p className='fokkus-orchestrator-subtitle'>
                    Construye tu equipo directamente en el mapa: asigna agentes desde cada nodo, conecta la jerarquía y define
                    las Reglas Base con el ícono <i className='fa fa-cog' />.
                </p>
            </header>

            <SwarmBuilder
                providersState={providersState}
                rolesState={rolesState}
                assignments={assignments}
                edges={edges}
                positions={positions}
                providerOptions={providerOptions}
                onOpenRoleSettings={setEditingRoleId}
                onAssignmentChange={assign}
                onNameChange={handleNameChange}
                onSetPrimary={handleSetPrimary}
                onDeleteRole={deleteRole}
                onAddRole={addRole}
                onEdgesChange={onEdgesChange}
                onPositionsChange={onPositionsChange}
                onImportTeam={handleImportTeam}
            />

            {editingRole && (
                <RoleRulesModal
                    role={editingRole}
                    accent={ROLE_ACCENT}
                    onSave={systemPrompt => saveRules(editingRole.id, systemPrompt)}
                    onClose={() => setEditingRoleId(undefined)}
                />
            )}
        </>
    );
}

/* ------------------------------------------------------------------------ */
/* Workspace panel — execution mode, diff review and approve/reject         */
/* ------------------------------------------------------------------------ */

interface ExecutionModeDefinition {
    id: string;
    name: string;
    description: string;
    icon: string;
    accent: string;
}

const EXECUTION_MODES: ExecutionModeDefinition[] = [
    {
        id: 'manual',
        name: 'Aprobación Manual',
        description: 'Cada cambio propuesto espera tu revisión y aprobación explícita antes de aplicarse.',
        icon: 'fa fa-hand-paper',
        accent: '#f59e0b'
    },
    {
        id: 'auto',
        name: 'Decisión Automática',
        description: 'El agente aplica los cambios de bajo riesgo sin intervención y te notifica al finalizar.',
        icon: 'fa fa-bolt',
        accent: '#10c48c'
    },
    {
        id: 'plan',
        name: 'Modo Planificación',
        description: 'El agente solo diseña un plan de acción; ningún cambio se escribe en disco.',
        icon: 'fa fa-map',
        accent: '#38bdf8'
    }
];

interface DiffLine {
    type: 'add' | 'remove' | 'context';
    content: string;
}

function parseDiff(diff: string): DiffLine[] {
    if (!diff) {
        return [];
    }
    return diff.split('\n').map(line => {
        if (line.startsWith('+++') || line.startsWith('---')) {
            return { type: 'context', content: line };
        }
        if (line.startsWith('+')) {
            return { type: 'add', content: line };
        }
        if (line.startsWith('-')) {
            return { type: 'remove', content: line };
        }
        return { type: 'context', content: line };
    });
}

function extractDiffFilenames(diff: string): string {
    const files: string[] = [];
    for (const line of diff.split('\n')) {
        if (line.startsWith('+++ b/')) {
            files.push(line.slice(6).trim());
        }
    }
    return files.length > 0 ? files.join(', ') : 'Working tree changes';
}

interface WorkspacePanelProps {
    server: FokkusOrchestratorServer;
    workspacePath: string;
}

function WorkspacePanel({ server, workspacePath }: WorkspacePanelProps): React.ReactElement {
    const [activeMode, setActiveMode] = React.useState<string>('manual');
    const [decision, setDecision] = React.useState<'approved' | 'rejected' | undefined>(undefined);
    const [diff, setDiff] = React.useState<string | undefined>(undefined);
    const [loadingDiff, setLoadingDiff] = React.useState(true);
    const [diffError, setDiffError] = React.useState<string | undefined>(undefined);
    const [busyAction, setBusyAction] = React.useState<'approve' | 'reject' | undefined>(undefined);
    const [probeResult, setProbeResult] = React.useState<string | undefined>(undefined);
    const [probeRunning, setProbeRunning] = React.useState(false);

    const refreshDiff = React.useCallback(async () => {
        setLoadingDiff(true);
        setDiffError(undefined);
        try {
            const result = await server.getWorkspaceDiff(workspacePath);
            setDiff(result);
        } catch (error) {
            setDiffError('No se pudo obtener el diff del workspace');
            console.error('[fokkus-orchestrator] No se pudo obtener el diff del workspace', error);
        } finally {
            setLoadingDiff(false);
        }
    }, [server, workspacePath]);

    React.useEffect(() => {
        refreshDiff();
    }, [refreshDiff]);

    const approve = React.useCallback(async () => {
        setBusyAction('approve');
        setDecision(undefined);
        try {
            await server.approveDiff(workspacePath);
            setDecision('approved');
            await refreshDiff();
        } catch (error) {
            setDiffError('No se pudo aprobar los cambios');
            console.error('[fokkus-orchestrator] No se pudo aprobar los cambios', error);
        } finally {
            setBusyAction(undefined);
        }
    }, [server, refreshDiff, workspacePath]);

    const reject = React.useCallback(async () => {
        setBusyAction('reject');
        setDecision(undefined);
        try {
            await server.rejectDiff(workspacePath);
            setDecision('rejected');
            await refreshDiff();
        } catch (error) {
            setDiffError('No se pudo rechazar los cambios');
            console.error('[fokkus-orchestrator] No se pudo rechazar los cambios', error);
        } finally {
            setBusyAction(undefined);
        }
    }, [server, refreshDiff, workspacePath]);

    const runProbe = React.useCallback(async () => {
        setProbeRunning(true);
        setProbeResult(undefined);
        try {
            const pong = await server.executeTask('ping');
            setProbeResult(pong);
        } catch (error) {
            setProbeResult('No se pudo contactar con el motor de ejecución');
            console.error('[fokkus-orchestrator] La ejecución de prueba falló', error);
        } finally {
            setProbeRunning(false);
        }
    }, [server]);

    const diffLines = React.useMemo(() => parseDiff(diff ?? ''), [diff]);
    const addCount = diffLines.filter(line => line.type === 'add').length;
    const removeCount = diffLines.filter(line => line.type === 'remove').length;
    const diffFile = React.useMemo(() => extractDiffFilenames(diff ?? ''), [diff]);
    const hasDiff = diff !== undefined && diff.length > 0;

    return (
        <>
            <header className='fokkus-orchestrator-header'>
                <h2 className='fokkus-orchestrator-title'>Workspace de Ejecución</h2>
                <p className='fokkus-orchestrator-subtitle'>
                    Elige el nivel de autonomía del agente y revisa los cambios propuestos desde el Chat antes de aplicarlos.
                </p>
            </header>

            <div className='fokkus-mode-grid'>
                {EXECUTION_MODES.map(mode => {
                    const cardStyle = { '--fokkus-accent': mode.accent } as React.CSSProperties;
                    const isActive = activeMode === mode.id;
                    return (
                        <button
                            key={mode.id}
                            type='button'
                            className={isActive ? 'fokkus-mode-card fokkus-mode-card--active' : 'fokkus-mode-card'}
                            style={cardStyle}
                            onClick={() => setActiveMode(mode.id)}
                        >
                            <div className='fokkus-mode-card-glow' />
                            {isActive && <i className='fa fa-check-circle fokkus-mode-check' />}
                            <div className='fokkus-mode-icon'>
                                <i className={mode.icon} />
                            </div>
                            <span className='fokkus-mode-name'>{mode.name}</span>
                            <span className='fokkus-mode-description'>{mode.description}</span>
                        </button>
                    );
                })}
            </div>

            <div className='fokkus-diff-viewer'>
                <div className='fokkus-diff-header'>
                    <i className='fa fa-file-code' />
                    <span className='fokkus-diff-filename'>{diffFile}</span>
                    <span className='fokkus-diff-stats'>
                        <span className='fokkus-diff-stat fokkus-diff-stat--add'>+{addCount}</span>
                        <span className='fokkus-diff-stat fokkus-diff-stat--remove'>-{removeCount}</span>
                    </span>
                </div>
                <div className='fokkus-diff-body'>
                    {loadingDiff && (
                        <div className='fokkus-diff-empty'>
                            <i className='fa fa-spinner fa-spin' />
                            <span>Cargando diff del workspace…</span>
                        </div>
                    )}
                    {!loadingDiff && diffError !== undefined && (
                        <div className='fokkus-diff-empty fokkus-diff-empty--error'>{diffError}</div>
                    )}
                    {!loadingDiff && diffError === undefined && !hasDiff && (
                        <div className='fokkus-diff-empty'>No hay cambios pendientes en el workspace.</div>
                    )}
                    {!loadingDiff && diffError === undefined && hasDiff && diffLines.map((line, index) => (
                        <div key={index} className={`fokkus-diff-line fokkus-diff-line--${line.type}`}>
                            <span className='fokkus-diff-gutter'>
                                {line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ''}
                            </span>
                            <span className='fokkus-diff-content'>{line.content}</span>
                        </div>
                    ))}
                </div>
            </div>

            <div className='fokkus-decision-bar'>
                <button
                    type='button'
                    className='fokkus-decision-button fokkus-decision-button--approve'
                    onClick={approve}
                    disabled={busyAction !== undefined || loadingDiff}
                >
                    <i className='fa fa-check' />
                    <span>{busyAction === 'approve' ? 'Aprobando…' : 'Approve (Commit)'}</span>
                </button>
                <button
                    type='button'
                    className='fokkus-decision-button fokkus-decision-button--reject'
                    onClick={reject}
                    disabled={busyAction !== undefined || loadingDiff}
                >
                    <i className='fa fa-times' />
                    <span>{busyAction === 'reject' ? 'Descartando…' : 'Reject (Discard)'}</span>
                </button>
                {decision !== undefined && (
                    <span
                        className={
                            decision === 'approved'
                                ? 'fokkus-decision-result fokkus-decision-result--approved'
                                : 'fokkus-decision-result fokkus-decision-result--rejected'
                        }
                    >
                        {decision === 'approved'
                            ? 'Cambios aprobados (commit aplicado)'
                            : 'Cambios descartados (reset aplicado)'}
                    </span>
                )}
            </div>

            <div className='fokkus-execution-probe'>
                <button type='button' className='fokkus-probe-button' onClick={runProbe} disabled={probeRunning}>
                    <i className='fa fa-play' />
                    <span>{probeRunning ? 'Ejecutando…' : 'Ejecutar Prueba'}</span>
                </button>
                {probeResult !== undefined && (
                    <span className='fokkus-probe-result'>{probeResult}</span>
                )}
            </div>
        </>
    );
}

/* ------------------------------------------------------------------------ */
/* Settings widget — Providers / Roles / Team / Workspace tabs              */
/* ------------------------------------------------------------------------ */

type FokkusSettingsTabId = 'providers' | 'roles' | 'team' | 'workspace';

interface FokkusSettingsTabDefinition {
    id: FokkusSettingsTabId;
    label: string;
    icon: string;
}

const FOKKUS_SETTINGS_TABS: FokkusSettingsTabDefinition[] = [
    { id: 'providers', label: 'Providers', icon: 'fa fa-plug' },
    { id: 'roles', label: 'Roles', icon: 'fa fa-id-badge' },
    { id: 'team', label: 'Team', icon: 'fa fa-users' },
    { id: 'workspace', label: 'Workspace', icon: 'fa fa-code-branch' }
];

interface FokkusSettingsAppProps {
    preferenceService: PreferenceService;
    orchestratorServer: FokkusOrchestratorServer;
    workspaceService: WorkspaceService;
}

function FokkusSettingsApp({ preferenceService, orchestratorServer, workspaceService }: FokkusSettingsAppProps): React.ReactElement {
    const [activeTab, setActiveTab] = React.useState<FokkusSettingsTabId>('providers');
    const [providersState, setProvidersState] = React.useState<ProvidersState>(() => normalizeProvidersState(preferenceService.get(PROVIDERS_PREFERENCE_KEY)));
    const [rolesState, setRolesState] = React.useState<RolesState>(() => normalizeRolesState(preferenceService.get(ROLES_PREFERENCE_KEY)));
    const [assignments, setAssignments] = React.useState<TeamAssignments>(() => normalizeTeamAssignments(preferenceService.get(TEAM_PREFERENCE_KEY)));
    const [edges, setEdges] = React.useState<SwarmEdge[]>(() => (preferenceService.get(EDGES_PREFERENCE_KEY) as SwarmEdge[]) || []);
    const [positions, setPositions] = React.useState<SwarmNodePositions>(() => (preferenceService.get(POSITIONS_PREFERENCE_KEY) as SwarmNodePositions) || {});
    const hydratedRef = React.useRef(false);

    React.useEffect(() => {
        let disposed = false;
        preferenceService.ready.then(() => {
            if (disposed) {
                return;
            }
            hydratedRef.current = true;
            setProvidersState(normalizeProvidersState(preferenceService.get(PROVIDERS_PREFERENCE_KEY)));
            setRolesState(normalizeRolesState(preferenceService.get(ROLES_PREFERENCE_KEY)));
            setAssignments(normalizeTeamAssignments(preferenceService.get(TEAM_PREFERENCE_KEY)));
            setEdges((preferenceService.get(EDGES_PREFERENCE_KEY) as SwarmEdge[]) || []);
            setPositions((preferenceService.get(POSITIONS_PREFERENCE_KEY) as SwarmNodePositions) || {});
        });
        return () => {
            disposed = true;
        };
    }, [preferenceService]);

    React.useEffect(() => {
        if (!hydratedRef.current) {
            return;
        }
        preferenceService.set(PROVIDERS_PREFERENCE_KEY, providersState, PreferenceScope.User)
            .catch(error => console.error('[fokkus-orchestrator] No se pudo guardar la configuración de proveedores', error));
    }, [preferenceService, providersState]);

    React.useEffect(() => {
        if (!hydratedRef.current) {
            return;
        }
        preferenceService.set(ROLES_PREFERENCE_KEY, rolesState, PreferenceScope.User)
            .catch(error => console.error('[fokkus-orchestrator] No se pudo guardar la configuración de roles', error));
    }, [preferenceService, rolesState]);

    React.useEffect(() => {
        if (!hydratedRef.current) {
            return;
        }
        preferenceService.set(TEAM_PREFERENCE_KEY, assignments, PreferenceScope.User)
            .catch(error => console.error('[fokkus-orchestrator] No se pudo guardar la configuración del equipo', error));
    }, [preferenceService, assignments]);

    React.useEffect(() => {
        if (!hydratedRef.current) {
            return;
        }
        preferenceService.set(EDGES_PREFERENCE_KEY, edges, PreferenceScope.User)
            .catch(error => console.error('[fokkus-orchestrator] No se pudo guardar las conexiones del equipo', error));
    }, [preferenceService, edges]);

    React.useEffect(() => {
        if (!hydratedRef.current) {
            return;
        }
        preferenceService.set(POSITIONS_PREFERENCE_KEY, positions, PreferenceScope.User)
            .catch(error => console.error('[fokkus-orchestrator] No se pudo guardar las posiciones del equipo', error));
    }, [preferenceService, positions]);

    // Persistir el snapshot completo del equipo (proveedores, roles con sus Reglas
    // Base, asignaciones y jerarquía) en `.fokkus/team_config.json`, dentro del
    // proyecto activo. Es el archivo agnóstico que cualquier agente externo puede leer.
    React.useEffect(() => {
        if (!hydratedRef.current) {
            return;
        }
        const config: TeamConfiguration = {
            providers: providersState,
            roles: rolesState,
            team: assignments,
            edges
        };
        orchestratorServer.saveTeamConfiguration(config)
            .catch(error => console.error('[fokkus-orchestrator] No se pudo guardar la configuración del equipo en el workspace', error));
    }, [orchestratorServer, providersState, rolesState, assignments, edges]);

    // Cascade cleanup: dropping a provider clears any role assignment pointing at it.
    const handleProvidersChange = React.useCallback((next: ProvidersState) => {
        setProvidersState(next);
        setAssignments(prev => {
            const cleaned: TeamAssignments = {};
            for (const [roleId, providerId] of Object.entries(prev)) {
                if (next[providerId]) {
                    cleaned[roleId] = providerId;
                }
            }
            return cleaned;
        });
    }, []);

    // Cascade cleanup: dropping a role clears its own assignment entry and its persisted position.
    const handleRolesChange = React.useCallback((next: RolesState) => {
        setRolesState(next);
        setPositions(prev => {
            const orphaned = Object.keys(prev).some(roleId => !next[roleId]);
            if (!orphaned) {
                return prev;
            }
            const cleaned: SwarmNodePositions = {};
            for (const [roleId, position] of Object.entries(prev)) {
                if (next[roleId]) {
                    cleaned[roleId] = position;
                }
            }
            return cleaned;
        });
        setAssignments(prev => {
            const cleaned: TeamAssignments = {};
            for (const [roleId, providerId] of Object.entries(prev)) {
                if (next[roleId]) {
                    cleaned[roleId] = providerId;
                }
            }
            return cleaned;
        });
    }, []);

    const handleEdgesChange = React.useCallback((next: SwarmEdge[]) => {
        setEdges(next);
    }, []);

    const handlePositionsChange = React.useCallback((next: SwarmNodePositions) => {
        setPositions(next);
    }, []);

    const activeIndex = FOKKUS_SETTINGS_TABS.findIndex(tab => tab.id === activeTab);
    const tabbarStyle = {
        '--fokkus-tab-count': FOKKUS_SETTINGS_TABS.length,
        '--fokkus-tab-active-index': activeIndex
    } as React.CSSProperties;

    return (
        <div className='fokkus-orchestrator fokkus-settings'>
            <nav className='fokkus-tabbar' role='tablist' style={tabbarStyle}>
                {FOKKUS_SETTINGS_TABS.map(tab => (
                    <button
                        key={tab.id}
                        type='button'
                        role='tab'
                        aria-selected={activeTab === tab.id}
                        className={activeTab === tab.id ? 'fokkus-tab fokkus-tab--active' : 'fokkus-tab'}
                        onClick={() => setActiveTab(tab.id)}
                    >
                        <i className={tab.icon} />
                        <span>{tab.label}</span>
                    </button>
                ))}
                <span className='fokkus-tab-indicator' />
            </nav>

            {activeTab === 'providers' && <ProvidersPanel providersState={providersState} onProvidersChange={handleProvidersChange} />}
            {activeTab === 'roles' && <RolesPanel rolesState={rolesState} onRolesChange={handleRolesChange} />}
            {activeTab === 'team' && (
                <TeamBuilderPanel
                    providersState={providersState}
                    rolesState={rolesState}
                    assignments={assignments}
                    edges={edges}
                    positions={positions}
                    onAssignmentsChange={setAssignments}
                    onRolesChange={handleRolesChange}
                    onEdgesChange={handleEdgesChange}
                    onPositionsChange={handlePositionsChange}
                />
            )}
            {activeTab === 'workspace' && <WorkspacePanel server={orchestratorServer} workspacePath={getWorkspacePath(workspaceService)} />}
        </div>
    );
}

@injectable()
export class FokkusSettingsWidget extends ReactWidget {

    static readonly ID = FOKKUS_SETTINGS_WIDGET_ID;
    static readonly LABEL = 'Fokkus Settings';

    @inject(PreferenceService)
    protected readonly preferenceService: PreferenceService;

    @inject(FokkusOrchestratorServer)
    protected readonly orchestratorServer: FokkusOrchestratorServer;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @postConstruct()
    protected init(): void {
        this.id = FokkusSettingsWidget.ID;
        this.title.label = FokkusSettingsWidget.LABEL;
        this.title.caption = FokkusSettingsWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'fa fa-gear';
        this.update();
    }

    protected render(): React.ReactNode {
        return (
            <FokkusSettingsApp
                preferenceService={this.preferenceService}
                orchestratorServer={this.orchestratorServer}
                workspaceService={this.workspaceService}
            />
        );
    }
}

/* ------------------------------------------------------------------------ */
/* Chat widget — markdown conversation with the Swarm + gear to settings    */
/* ------------------------------------------------------------------------ */

interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'error';
    content: string;
}

let chatMessageCounter = 0;
function nextChatMessageId(): string {
    chatMessageCounter += 1;
    return `chat-msg-${chatMessageCounter}`;
}

function cleanAgentOutput(output: string | undefined): string {
    if (!output) return '';
    let text = output.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
    text = text.replace(/\x00/g, '');
    text = text.replace(/<think>/gi, '> 🧠 **Pensamiento:**\n> ');
    text = text.replace(/<\/think>/gi, '\n\n---\n\n');
    return text.trim();
}

interface FokkusChatAppProps {
    preferenceService: PreferenceService;
    orchestratorServer: FokkusOrchestratorServer;
    commandService: CommandService;
    workspaceService: WorkspaceService;
}

const CustomCodeComponent: Components['code'] = ({ inline, className, children, ...props }: any) => {
    const match = /language-(\w+)/.exec(className || '');
    const id = React.useMemo(() => `mermaid-${Math.random().toString(36).substr(2, 9)}`, []);

    React.useEffect(() => {
        if (match && match[1] === 'mermaid') {
            mermaid.initialize({ startOnLoad: false, theme: 'dark' });
            setTimeout(() => {
                const el = document.getElementById(id);
                if (el) {
                    mermaid.run({ nodes: [el] }).catch(() => {});
                }
            }, 100);
        }
    });

    if (!inline && match && match[1] === 'mermaid') {
        return (
            <div id={id} className="mermaid">
                {String(children).replace(/\n$/, '')}
            </div>
        );
    }
    return (
        <code className={className} {...props}>
            {children}
        </code>
    );
};

function FokkusChatApp({ preferenceService, orchestratorServer, commandService, workspaceService }: FokkusChatAppProps): React.ReactElement {
    const [messages, setMessages] = React.useState<ChatMessage[]>([{
        id: nextChatMessageId(),
        role: 'assistant',
        content: '**Fokkus Swarm** listo. Escribe una instrucción y el agente asignado al rol *Senior Dev* la ejecutará sobre el workspace actual.'
    }]);
    const [promptText, setPromptText] = React.useState('');
    const [dispatching, setDispatching] = React.useState(false);
    const [stopping, setStopping] = React.useState(false);
    const [attachments, setAttachments] = React.useState<ChatAttachment[]>([]);
    const [loadingText, setLoadingText] = React.useState('Procesando...');



    const loadingTexts = React.useMemo(() => ['Procesando...', 'Analizando...', 'Consultando Agente...', 'Generando respuesta...'], []);

    const MAX_CHARS = 50000;
    const currentChars = messages.reduce((acc, m) => acc + m.content.length, 0);
    const progressPercent = Math.min(100, (currentChars / MAX_CHARS) * 100);

    const compactChatHistory = React.useCallback(async () => {
        setDispatching(true);
        try {
            const workspacePath = getWorkspacePath(workspaceService);
            
            await preferenceService.ready;
            const providersState = normalizeProvidersState(preferenceService.get(PROVIDERS_PREFERENCE_KEY));
            const rolesState = normalizeRolesState(preferenceService.get(ROLES_PREFERENCE_KEY));
            const assignments = normalizeTeamAssignments(preferenceService.get(TEAM_PREFERENCE_KEY));
            
            const prompt = "Por favor genera un resumen en un párrafo de los requerimientos y logros técnicos que hemos alcanzado hasta ahora basándote en la conversación.";
            const result = await orchestratorServer.dispatchToSwarm(workspacePath, prompt, 'manual', assignments, providersState, [], rolesState);
            if (result.roleResults.some(r => r.status === 'cancelled')) {
                return;
            }
            let summary: string | undefined = undefined;
            if (result.roleResults && result.roleResults.length > 0) {
                const completed = result.roleResults.find(r => r.status === 'completed');
                if (completed) {
                    summary = completed.output;
                }
            }
            
            await orchestratorServer.compactChatHistory(workspacePath, summary);
            if (summary) {
                setMessages([
                    { id: nextChatMessageId(), role: 'system', content: 'Historial compactado.', timestamp: Date.now() } as any,
                    { id: nextChatMessageId(), role: 'assistant', content: `**Historial Compactado:**\n\n${summary}`, timestamp: Date.now() } as any
                ]);
            } else {
                setMessages(prev => [prev[0]]);
            }
        } catch(e) {
            console.error(e);
        } finally {
            setDispatching(false);
            setStopping(false);
        }
    }, [orchestratorServer, workspaceService, preferenceService]);

    const promptInputRef = React.useRef<HTMLTextAreaElement | undefined>(undefined);
    const fileInputRef = React.useRef<HTMLInputElement | undefined>(undefined);
    const messagesContainerRef = React.useRef<HTMLDivElement | undefined>(undefined);

    React.useEffect(() => {
        let disposed = false;
        workspaceService.ready.then(() => {
            if (disposed) return;
            const workspacePath = getWorkspacePath(workspaceService);
            orchestratorServer.loadChatHistory(workspacePath).then(history => {
                if (history && history.length > 0) {
                    setMessages(history.map(msg => ({
                        id: nextChatMessageId(),
                        role: (msg.role === 'user' || msg.role === 'assistant') ? msg.role : 'assistant',
                        content: msg.content
                    })));
                }
            }).catch(e => console.error("[fokkus-orchestrator] Error loading chat history:", e));
        });
        return () => { disposed = true; };
    }, [orchestratorServer, workspaceService]);

    React.useEffect(() => {
        let interval: any;
        if (dispatching) {
            let i = 0;
            interval = setInterval(() => {
                i = (i + 1) % loadingTexts.length;
                setLoadingText(loadingTexts[i]);
            }, 2000);
        } else {
            setLoadingText('Procesando...');
        }
        return () => clearInterval(interval);
    }, [dispatching, loadingTexts]);

    React.useEffect(() => {
        const disposable = orchestratorServer.onAgentLog(log => {

        });
        return () => disposable.dispose();
    }, [orchestratorServer]);

    const resizePromptInput = React.useCallback(() => {
        const el = promptInputRef.current;
        if (!el) {
            return;
        }
        // Si el widget aún no está adjunto/visible, scrollHeight es 0 y fijar
        // `height: 0px` corta el placeholder. Se ignora la medición y se reintenta
        // cuando el panel se muestra o cambia de tamaño.
        if (el.scrollHeight === 0 || !el.offsetParent) {
            return;
        }
        el.style.height = 'auto';
        // Con `box-sizing: border-box` (clase theia-input) la altura inline debe
        // incluir los bordes: scrollHeight mide el contenido (incluye padding) y
        // `offsetHeight - clientHeight` aporta el alto de los bordes.
        const borderBoxDelta = el.offsetHeight - el.clientHeight;
        el.style.height = `${Math.min(el.scrollHeight + borderBoxDelta, 160)}px`;
    }, []);

    React.useEffect(() => {
        resizePromptInput();
    }, [promptText, resizePromptInput]);

    // Re-mide el textarea cuando el panel pasa de oculto a visible o cambia de ancho:
    // un `update()` del widget no re-ejecuta el efecto anterior (depende de promptText).
    React.useEffect(() => {
        const container = promptInputRef.current?.parentElement;
        if (!container || typeof ResizeObserver === 'undefined') {
            return;
        }
        const observer = new ResizeObserver(() => resizePromptInput());
        observer.observe(container);
        return () => observer.disconnect();
    }, [resizePromptInput]);

    React.useEffect(() => {
        const container = messagesContainerRef.current;
        if (container) {
            container.scrollTop = container.scrollHeight;
        }
    }, [messages]);

    const processPasteEvent = React.useCallback((event: ClipboardEvent | React.ClipboardEvent) => {
        const items = event.clipboardData?.items;
        if (!items) return;

        let hasImage = false;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === 'file' && item.type.startsWith('image/')) {
                hasImage = true;
                const file = item.getAsFile();
                if (file) {
                    const reader = new FileReader();
                    reader.onload = (ev) => {
                        const result = ev.target?.result as string;
                        if (result) {
                            const base64Data = result.split(',')[1];
                            setAttachments(prev => [...prev, {
                                fileName: file.name || `Pasted_Image_${Date.now()}.png`,
                                mimeType: file.type,
                                base64Data: base64Data
                            }]);
                        }
                    };
                    reader.readAsDataURL(file);
                }
            }
        }

        if (hasImage) {
            event.preventDefault();
        }
    }, []);

    const openSettings = React.useCallback(() => {
        commandService.executeCommand(FOKKUS_OPEN_SETTINGS_COMMAND_ID);
    }, [commandService]);

    const handleFileChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files) return;
        Array.from(e.target.files).forEach(file => {
            const reader = new FileReader();
            reader.onload = (ev) => {
                const result = ev.target?.result as string;
                if (result) {
                    const base64Data = result.split(',')[1];
                    setAttachments(prev => [...prev, {
                        fileName: file.name,
                        mimeType: file.type,
                        base64Data: base64Data
                    }]);
                }
            };
            reader.readAsDataURL(file);
        });
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
    }, []);

    const removeAttachment = React.useCallback((index: number) => {
        setAttachments(prev => prev.filter((_, i) => i !== index));
    }, []);

    const stopDispatch = React.useCallback(async () => {
        if (!dispatching || stopping) {
            return;
        }
        setStopping(true);
        try {
            await orchestratorServer.cancelDispatch();
        } catch (error) {
            console.error('[fokkus-orchestrator] No se pudo detener la ejecución', error);
        }
    }, [dispatching, stopping, orchestratorServer]);

    const dispatchPrompt = React.useCallback(async () => {
        const trimmed = promptText.trim();
        if ((trimmed.length === 0 && attachments.length === 0) || dispatching) {
            return;
        }
        
        let msgContent = trimmed || 'Analiza la imagen adjunta.';
        if (attachments.length > 0) {
            msgContent += `\n*[${attachments.length} archivos adjuntos]*`;
        }

        const userMsg: ChatMessage = { id: nextChatMessageId(), role: 'user', content: msgContent };
        const messagesWithUser = [...messages, userMsg];
        setMessages(messagesWithUser);
        setPromptText('');
        const currentAttachments = [...attachments];
        setAttachments([]);
        setDispatching(true);

        const workspacePath = getWorkspacePath(workspaceService);

        try {
            const historyToSaveBefore = messagesWithUser.map(m => ({
                role: m.role === 'error' ? 'system' : m.role,
                content: m.content,
                timestamp: Date.now()
            }));
            await orchestratorServer.saveChatHistory(workspacePath, historyToSaveBefore as any);

            await preferenceService.ready;
            const providersState = normalizeProvidersState(preferenceService.get(PROVIDERS_PREFERENCE_KEY));
            const rolesState = normalizeRolesState(preferenceService.get(ROLES_PREFERENCE_KEY));
            const assignments = normalizeTeamAssignments(preferenceService.get(TEAM_PREFERENCE_KEY));
            const result = await orchestratorServer.dispatchToSwarm(workspacePath, trimmed, 'manual', assignments, providersState, currentAttachments, rolesState);
            

            const resultMessages = result.roleResults.map(r => {

                if (r.status === 'completed') {
                    const timeString = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    return {
                        id: nextChatMessageId(),
                        role: 'assistant',
                        content: `**${timeString} - ${r.providerName} dice:**\n\n${cleanAgentOutput(r.output)}`
                    };
                } else if (r.status === 'skipped') {
                    return {
                        id: nextChatMessageId(),
                        role: 'assistant',
                        content: `⚠️ **[${r.providerName}]** omitido: ${cleanAgentOutput(r.error)}`
                    };
                } else if (r.status === 'cancelled') {
                    return {
                        id: nextChatMessageId(),
                        role: 'assistant',
                        content: `⏹️ **[${r.providerName}]** detenido por el usuario.`
                    };
                } else {
                    return {
                        id: nextChatMessageId(),
                        role: 'error',
                        content: `❌ Error en **[${r.providerName}]** (*${r.roleId}*):\n\n\`\`\`text\n${cleanAgentOutput(r.error)}\n\`\`\``
                    };
                }
            });
            
            // Si no hay resultados de roles, significa que no hay equipo asignado
            if (resultMessages.length === 0) {
                resultMessages.push({
                    id: nextChatMessageId(),
                    role: 'error',
                    content: '⚠️ No hay agentes asignados en el equipo. Ve al engranaje ⚙️ y asigna un proveedor al rol de Senior Dev.'
                });
            }
            
            const messagesWithAgents: ChatMessage[] = [...messagesWithUser, ...(resultMessages as ChatMessage[])];
            setMessages(messagesWithAgents);
            
            const historyToSave = messagesWithAgents.map(m => ({
                role: m.role === 'error' ? 'system' : m.role,
                content: m.content,
                timestamp: Date.now()
            }));
            await orchestratorServer.saveChatHistory(workspacePath, historyToSave as any);
        } catch (error) {
            const description = error instanceof Error ? error.message : String(error);
            console.error('[fokkus-orchestrator] No se pudo despachar la instrucción al Swarm', error);
            
            const errorMsg: ChatMessage = {
                id: nextChatMessageId(),
                role: 'error',
                content: `⚠️ No se pudo despachar la instrucción: ${description}`
            };
            const messagesWithError: ChatMessage[] = [...messagesWithUser, errorMsg];
            setMessages(messagesWithError);
            
            const historyToSave = messagesWithError.map(m => ({
                role: m.role === 'error' ? 'system' : m.role,
                content: m.content,
                timestamp: Date.now()
            }));
            await orchestratorServer.saveChatHistory(workspacePath, historyToSave as any);
        } finally {
            setDispatching(false);
            setStopping(false);
        }
    }, [promptText, dispatching, preferenceService, orchestratorServer]);

    const handlePromptKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        event.stopPropagation();
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            dispatchPrompt();
        }
    }, [dispatchPrompt]);

    return (
        <div className='fokkus-chat'>
            <div className='fokkus-chat-messages' ref={element => { messagesContainerRef.current = element ?? undefined; }}>
                {messages.map(message => (
                    <div key={message.id} className={`fokkus-chat-message fokkus-chat-message--${message.role}`}>
                        <div className='fokkus-chat-bubble'>
                            <div className='fokkus-chat-markdown'>
                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: CustomCodeComponent }}>
                                    {message.content}
                                </ReactMarkdown>
                            </div>
                        </div>
                    </div>
                ))}
                {dispatching && (
                    <div style={{ display: 'flex', alignItems: 'center', alignSelf: 'center', margin: '8px 0', padding: '8px 12px', background: 'var(--theia-dropdown-background)', border: '1px solid var(--theia-dropdown-border)', borderRadius: '16px', color: 'var(--theia-descriptionForeground)', fontSize: '0.9em', maxWidth: '80%', gap: '8px' }}>
                        <i className="fa fa-spinner fa-spin" />
                        <span>{stopping ? 'Deteniendo...' : loadingText}</span>
                    </div>
                )}
            </div>

            <div style={{ padding: '8px', borderTop: '1px solid var(--theia-panel-border)', display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ flexGrow: 1, background: 'var(--theia-scrollbarSlider-background)', height: '6px', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{ width: `${progressPercent}%`, height: '100%', background: progressPercent > 90 ? '#f87171' : 'var(--theia-button-background)' }} />
                </div>
                <span style={{ fontSize: '0.8em', color: 'var(--theia-descriptionForeground)' }}>{Math.round(currentChars/1000)}k / {MAX_CHARS/1000}k</span>
                <button onClick={compactChatHistory} title="Compactar historial" style={{ background: 'var(--theia-button-background)', border: 'none', color: 'var(--theia-button-foreground)', cursor: 'pointer', padding: '4px 8px', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <i className="fa fa-broom" />
                    <span style={{ fontSize: '0.9em' }}>Compactar</span>
                </button>
            </div>
            <div className='fokkus-chat-inputbar'>
                <button
                    type='button'
                    className='fokkus-chat-gear'
                    onClick={openSettings}
                    title='Abrir configuración de proveedores, roles y equipo'
                    aria-label='Abrir configuración'
                >
                    <i className='fa fa-gear' />
                </button>
                <input 
                    type='file' 
                    accept='image/*' 
                    style={{ display: 'none' }} 
                    ref={element => { fileInputRef.current = element ?? undefined; }} 
                    multiple 
                    onChange={handleFileChange} 
                />
                <button
                    type='button'
                    className='fokkus-chat-gear'
                    onClick={() => fileInputRef.current?.click()}
                    title='Adjuntar imagen'
                    aria-label='Adjuntar imagen'
                >
                    <i className='fa fa-paperclip' />
                </button>
                <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1 }}>
                    {attachments.length > 0 && (
                        <div style={{ display: 'flex', gap: '4px', paddingBottom: '4px', overflowX: 'auto' }}>
                            {attachments.map((att, idx) => (
                                <div key={idx} style={{ position: 'relative', display: 'inline-block' }}>
                                    <img src={`data:${att.mimeType};base64,${att.base64Data}`} style={{ height: '40px', borderRadius: '4px' }} title={att.fileName} />
                                    <button 
                                        onClick={() => removeAttachment(idx)} 
                                        style={{ position: 'absolute', top: -5, right: -5, background: 'red', color: 'white', border: 'none', borderRadius: '50%', cursor: 'pointer', width: '16px', height: '16px', fontSize: '10px' }}>
                                        x
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                    <textarea
                        ref={element => { promptInputRef.current = element ?? undefined; }}
                        className='fokkus-prompt-input theia-input'
                        placeholder='¿Qué deseas construir hoy?'
                        rows={1}
                        value={promptText}
                        onChange={event => setPromptText(event.target.value)}
                        onKeyDown={handlePromptKeyDown}
                        onPaste={processPasteEvent}
                        disabled={dispatching}
                    />
                </div>
                {dispatching ? (
                    <button
                        type='button'
                        className='fokkus-prompt-send fokkus-prompt-stop'
                        onClick={stopDispatch}
                        disabled={stopping}
                        title='Detener ejecución'
                        aria-label='Detener ejecución'
                    >
                        {stopping ? <i className='fa fa-spinner fa-spin' /> : <i className='fa fa-stop' />}
                    </button>
                ) : (
                    <button
                        type='button'
                        className='fokkus-prompt-send'
                        onClick={dispatchPrompt}
                        disabled={promptText.trim().length === 0 && attachments.length === 0}
                        title='Enviar al Swarm'
                    >
                        <i className='fa fa-paper-plane' />
                    </button>
                )}
            </div>
        </div>
    );
}

@injectable()
export class FokkusChatWidget extends ReactWidget {

    static readonly ID = FOKKUS_CHAT_WIDGET_ID;
    static readonly LABEL = 'Fokkus Team';

    @inject(PreferenceService)
    protected readonly preferenceService: PreferenceService;

    @inject(FokkusOrchestratorServer)
    protected readonly orchestratorServer: FokkusOrchestratorServer;

    @inject(CommandService)
    protected readonly commandService: CommandService;

    @inject(WorkspaceService)
    protected readonly workspaceService: WorkspaceService;

    @postConstruct()
    protected init(): void {
        this.id = FokkusChatWidget.ID;
        this.title.label = FokkusChatWidget.LABEL;
        this.title.caption = FokkusChatWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'fa fa-users';
        this.update();
    }

    protected render(): React.ReactNode {
        return (
            <FokkusChatApp
                preferenceService={this.preferenceService}
                orchestratorServer={this.orchestratorServer}
                commandService={this.commandService}
                workspaceService={this.workspaceService}
            />
        );
    }
}
