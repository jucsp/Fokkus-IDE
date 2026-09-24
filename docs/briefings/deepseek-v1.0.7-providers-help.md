# Briefing DeepSeek V4 Pro — v1.0.7: Ayuda para integrar proveedores (#3)

## Contexto de Negocio
Cuando un usuario abre Fokkus Settings > Providers para registrar un proveedor de IA, la UI solo muestra campos vacíos (API Key, Base URL, Modelo, Comando CLI) sin explicar de dónde sacar la clave, qué Base URL usar ni cuál es el nombre exacto del modelo. Se equivocan en el nombre del modelo o en el endpoint y el Swarm falla sin que sepan por qué. El cliente quiere un botón de ayuda dentro de Providers que explique, por proveedor (Claude, Gemini, OpenAI/GPT, DeepSeek, Ollama), dónde conseguir la API Key, qué Base URL usar y qué modelos poner.

Extensión: `theia-extensions/fokkus-orchestrator` (Theia 1.76, React 19, TypeScript 5.9). Estilo: 4 espacios, comillas simples, sin `null` (usar `undefined`), sin `any` nuevo, llaves en todos los `if`, sin líneas en blanco dobles ni espacios al final. Textos de UI en español.

Dato importante: los proveedores de tipo `api` no los llama el backend directamente. `src/node/fokkus-orchestrator-server.ts` los pasa como variables de entorno (`FOKKUS_TEAM_<ROL>_ENDPOINT/KEY/MODEL`) al agente CLI del Product Owner, que los consume como endpoints **compatibles con OpenAI**. Por eso la Base URL recomendada debe ser la compatible con OpenAI de cada proveedor.

## HU-3 — Helper de ayuda en Providers
- 📁 Repo: /home/juancarlos/Proyectos/Personales/Fokkus-IDE
- 🎯 Capa: Frontend (`ProvidersPanel` y `FokkusSettingsWidget` en `src/browser/fokkus-orchestrator-widget.tsx`, CSS en `src/browser/style/index.css`)
- 📌 Objetivo técnico:
  1. En la cabecera de `ProvidersPanel`, agregar un botón de ayuda (`fa fa-question-circle`, `title='¿Cómo integrar proveedores?'`, `aria-expanded`) que abra y cierre un panel de ayuda dentro de la misma pestaña (no un diálogo modal).
  2. Los datos de ayuda van en una constante tipada (`PROVIDER_HELP_GUIDES`), no escritos a mano en el JSX. Cada guía tiene: nombre, tipo (`api`/`cli`), URL de la consola donde se crea la clave, Base URL recomendada, lista de modelos de ejemplo y una nota corta. Contenido obligatorio:
     - **Anthropic (Claude)**: clave en https://console.anthropic.com/settings/keys · Base URL `https://api.anthropic.com/v1/` · modelos `claude-sonnet-5`, `claude-opus-5-5`, `claude-haiku-4-5`. Nota: para el rol PO también se puede usar Claude Code como CLI (`claude`).
     - **Google Gemini**: clave en https://aistudio.google.com/apikey · Base URL `https://generativelanguage.googleapis.com/v1beta/openai/` · modelos `gemini-2.5-pro`, `gemini-2.5-flash`.
     - **OpenAI (GPT)**: clave en https://platform.openai.com/api-keys · Base URL `https://api.openai.com/v1` · modelos `gpt-4o`, `gpt-4o-mini`.
     - **DeepSeek**: clave en https://platform.deepseek.com/api_keys · Base URL `https://api.deepseek.com` · modelos `deepseek-chat`, `deepseek-reasoner`.
     - **Ollama (local)**: tipo CLI, sin clave; instalar desde https://ollama.com/download, valor `http://localhost:11434`, modelos de ejemplo `llama3.1`, `qwen2.5-coder` (se descargan con `ollama pull <modelo>`).
     - Una nota general al pie: los nombres de modelos cambian con el tiempo, así que hay que revisar la documentación oficial de cada proveedor. Y una advertencia: el rol Product Owner debe ser de tipo CLI (así lo exige el backend).
  3. Los links deben abrirse en el navegador del sistema, no dentro de la ventana Electron. Usa `WindowService` (`@theia/core/lib/browser/window/window-service`) con `openNewWindow(url, { external: true })`, inyectado en `FokkusSettingsWidget` y pasado por props hasta `ProvidersPanel`.
  4. Cada guía de tipo `api` tiene un botón «Usar esta configuración» que abre el formulario de alta (el mismo flujo de `startCreate`) con tipo `api` y con nombre, Base URL y primer modelo ya rellenos. La API Key queda vacía.
  5. Los nombres de modelo y las Base URL se muestran en `<code>` y se pueden seleccionar para copiar (`user-select: text`).
  6. Mejorar los placeholders de `PROVIDER_FIELDS_BY_TYPE.api` para que el campo Modelo muestre ejemplos reales (ej. `claude-sonnet-5, gemini-2.5-pro, deepseek-chat, gpt-4o`).
  7. Estilos nuevos con prefijo `fokkus-help-`, siguiendo el estilo glass de `.fokkus-provider-card` / `.fokkus-crud-form` y usando variables `--theia-*` para que el texto se lea bien en tema oscuro y claro (ver bug #8 de texto opaco).
  8. No tocar el backend, el protocolo ni la persistencia de preferencias.
