# Fokkus IDE

Fokkus IDE es un entorno de desarrollo integrado avanzado basado en Eclipse Theia, potenciado por **Fokkus Swarm**, un ecosistema de agentes de IA autónomos (Antigravity, Claude Code, DeepSeek, etc.) que colaboran como una fábrica de software directamente en tu entorno local.

## Características Principales

*   **Orquestación de Agentes:** Asigna roles (Product Owner, Project Manager, Senior Dev, Junior Dev, QA) a diferentes modelos de IA.
*   **Aislamiento por Proyecto:** La memoria y el historial del chat se aíslan y persisten por workspace (`.fokkus/chat_history.json`).
*   **Ejecución Nativa:** Conexión directa a CLIs instaladas en la máquina host (`agy`, `claude`) o mediante llamadas a API REST para máxima flexibilidad.
*   **Constructor de Swarm (Grafo):** Interfaz visual basada en nodos para estructurar el equipo de desarrollo, con capacidad de exportación e importación de topologías.
*   **Gestión Inteligente de Tokens:** Compactación automática de historiales y streaming de comandos asincrónicos.

## Estructura del Proyecto

*   `theia-extensions/fokkus-orchestrator`: El núcleo de la extensión que gestiona el panel de chat, la UI gráfica de nodos, y el backend RPC que se comunica con los agentes locales.

## Construcción (Desarrollo)

Para compilar y lanzar la versión de desarrollo en el navegador local:

```bash
yarn
yarn --cwd theia-extensions/fokkus-orchestrator build
yarn build:applications:dev
yarn browser start
```

## Configuración del Equipo (Swarm)

1. Abre las configuraciones del IDE (Preferencias).
2. Asigna tus API Keys para los diferentes proveedores.
3. Utiliza la interfaz de Grafo para designar qué proveedor cumplirá cada rol (ej. Claude como PM, DeepSeek como Dev).
4. El Product Owner será tu punto de contacto en el chat.
