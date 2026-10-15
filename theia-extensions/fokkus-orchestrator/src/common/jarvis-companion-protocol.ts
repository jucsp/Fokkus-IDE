/********************************************************************************
 * Copyright (C) 2026 Fokkus IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Contrato del «Jarvis Companion Connector».
 *
 * Sustituye a la ventana overlay de Electron (que daba problemas de opacidad en Linux/Windows):
 * ahora Fokkus IDE se comunica con el binario independiente `fokkus-jarvis` por IPC sobre un
 * socket Unix (`~/.fokkus/jarvis.sock`). El backend Node expone este servicio RPC; el frontend
 * muestra el estado en la barra de estado y reenvía los eventos del Swarm y de la Bandeja.
 */

export const JarvisCompanionServerPath = '/services/jarvis-companion';
export const JarvisCompanionServer = Symbol('JarvisCompanionServer');

/** Última versión publicada del compañero (repositorio independiente `Fokkus-Jarvis`). */
export const JARVIS_COMPANION_RELEASES_URL = 'https://github.com/jucsp/Fokkus-Jarvis/releases/latest';

/** Estado de enlace con el compañero `fokkus-jarvis`. */
export type JarvisCompanionStatus = 'connected' | 'installed-stopped' | 'not-installed';

/** Instantánea del estado del compañero: la barra de estado la refresca periódicamente. */
export interface JarvisCompanionInfo {
    status: JarvisCompanionStatus;
    /** true = el binario `fokkus-jarvis` se encontró en el sistema. */
    installed: boolean;
    /** true = el socket responde al `jarvis.ping`. */
    running: boolean;
    /** Versión reportada por el compañero, si la informa. */
    version?: string;
    /** Ruta absoluta del socket Unix con el que se intenta hablar. */
    socketPath: string;
    /** Ruta absoluta del binario detectado, si se encontró. */
    binaryPath?: string;
    /** Ruta del ejecutable configurada a mano en Ajustes › Jarvis (vacía = búsqueda automática). */
    configuredBinaryPath?: string;
    /** Estado interno que reporta el compañero (p. ej. 'supervisando'), si lo informa. */
    state?: string;
}

/** Tarea del Swarm que Jarvis debe supervisar. */
export interface JarvisSwarmTaskNotification {
    taskId: string;
    agent: string;
    goal: string;
}

/** Resultado de una tarea del Swarm ya finalizada. */
export interface JarvisSwarmCompletedNotification {
    taskId: string;
    status: string;
    summary: string;
}

/** Alerta de la Bandeja (Triage) que Jarvis debe mostrar. */
export interface JarvisTriageAlertNotification {
    itemId: string;
    title: string;
    source: string;
}

/** Servicio RPC backend ↔ frontend del compañero Jarvis. */
export interface JarvisCompanionServer {
    /** Estado actual (instalado / en marcha / conectado) resolviendo el socket y el binario. */
    getCompanionInfo(): Promise<JarvisCompanionInfo>;
    /** Lanza `fokkus-jarvis` desacoplado del IDE. Falla si el binario no está instalado. */
    startJarvis(): Promise<{ success: boolean; error?: string }>;
    /**
     * Guarda la ruta del ejecutable para cuando no está en el PATH (`''` vuelve a la búsqueda
     * automática). Rechaza rutas relativas o que no sean un archivo ejecutable.
     */
    setBinaryPath(binaryPath: string): Promise<{ success: boolean; error?: string; info: JarvisCompanionInfo }>;
    /** Notifica a Jarvis el inicio de una tarea del Swarm de desarrollo. */
    notifySwarmTask(task: { taskId: string; agent: string; goal: string }): Promise<void>;
    /** Notifica a Jarvis que una tarea del Swarm terminó con su resumen. */
    notifySwarmCompleted(result: { taskId: string; status: string; summary: string }): Promise<void>;
    /** Notifica a Jarvis una alerta de triage (nueva solicitud en la Bandeja). */
    notifyTriageAlert(alert: { itemId: string; title: string; source: string }): Promise<void>;
}
