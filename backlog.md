# Product Backlog — Fokkus IDE

## HU-09: [FIX-PRIORITARIO] Corrección de Contexto del Workspace Activo (Aislamiento)
**Como:** Usuario de Fokkus IDE.
**Quiero:** Que el orquestador y los agentes reconozcan estrictamente el contexto del proyecto abierto (ej. el proyecto de la Calculadora) y su propio `chat_history.json` / `backlog.md`, sin arrastrar la memoria ni el backlog del propio proyecto anfitrión Fokkus-IDE.
**Para:** Evitar que el PO asuma que seguimos desarrollando el IDE cuando el usuario ya abrió un nuevo workspace para un proyecto distinto.

## HU-10: Soporte Markdown Avanzado en Chat (Tablas y Mermaid)
**Como:** Usuario de Fokkus IDE.
**Quiero:** Que el chat sea capaz de renderizar correctamente tablas de Markdown y diagramas de Mermaid devueltos por los agentes.
**Para:** Visualizar correctamente estructuras complejas, flujos (flowcharts) y tabulaciones de datos sin ver el código en crudo.

## HU-01: Certificación E2E del Swarm Nativo (Prueba de Producción)
**Como:** Product Owner / QA.
**Quiero:** Ejecutar el Fokkus IDE, configurar los proveedores dinámicos y roles, y solicitar mediante el nuevo Chat (FokkusChatWidget) la creación de un proyecto pequeño (ej. Calculadora).
**Para:** Validar visualmente en la interfaz del IDE que el Swarm despacha los agentes de forma paralela, que el backend procesa las respuestas, que los diffs se abren nativamente en el área principal y que el código resultante es correcto, certificando así que la herramienta está 100% lista para producción.

### Criterios de Aceptación:
1. El Theia IDE arranca correctamente con los nuevos widgets desacoplados (`fokkus-chat-widget` en la izquierda, `fokkus-settings-widget` accesible vía engranaje).
2. Se pueden configurar proveedores (DeepSeek/Claude) y asignar roles desde la interfaz.
3. El Chat recibe el prompt ("Crea una calculadora") y el motor RPC del backend paraleliza/encola el trabajo según los roles.
4. El resultado del agente gatilla la apertura del visor nativo de Diffs de Theia en el panel principal.
5. Si ocurre algún error en el flujo, el código fuente del IDE se corrige y se repite la prueba hasta alcanzar el éxito.

## HU-02: Forzar Workspace Activo en Agentes CLI
**Como:** Usuario de Fokkus IDE.
**Quiero:** Que el orquestador pase explícitamente el directorio abierto (`--add-dir <cwd>`) a Antigravity CLI si no hay un repositorio `.git` inicializado.
**Para:** Evitar que los agentes generen los archivos en directorios temporales o externos (como `scratch/`) y trabajen directamente sobre mi proyecto abierto.

## HU-03: Configuración Global del Swarm (No por proyecto)
**Como:** Usuario de Fokkus IDE.
**Quiero:** Que las configuraciones del equipo, proveedores, roles y jerarquías del Grafo se guarden en la configuración global del IDE (ej. `~/.theia-ide` o `~/.fokkus`) en lugar de en el directorio `.fokkus/` de cada proyecto.
**Para:** No tener que reconfigurar mi equipo de agentes cada vez que abro una carpeta o proyecto nuevo.

## HU-04: Persistencia y Gestión del Historial de Chat
**Como:** Usuario de Fokkus IDE.
**Quiero:** Que el historial de la conversación del chat se guarde de forma persistente asociado al proyecto/workspace activo, con opciones en la interfaz para "Limpiar Historial" o "Compactar/Resumir".
**Para:** Retomar el contexto al reiniciar el IDE y tener herramientas para controlar el uso de tokens sin perder la información clave.

## HU-05: Documentación de Proyecto por Workspace
**Como:** Product Owner.
**Quiero:** Que el IDE provea/exija que cada proyecto tenga su propio archivo de `backlog`, `historial`, y `plan de implementación` dentro de su carpeta local.
**Para:** Mantener la organización del estado de desarrollo aislada al código fuente del proyecto, incluso si la configuración de los agentes es global.

## HU-06: Compactación Automática y Manual de Historial
**Como:** Usuario de Fokkus IDE.
**Quiero:** Visualizar una pequeña barra de progreso en la sección inferior del chat que indique el llenado del contexto. Cuando se llene, debe ocultarse automáticamente la barra y mostrar "Compactando" con un loader animado en miniatura. Adicionalmente, debe existir un icono para forzar la compactación manual.
**Para:** Resumir el historial, evitar enviar prompts excesivamente largos al CLI y mantener el consumo de tokens optimizado.

## HU-07: Indicador de Agente Trabajando (Typing/Loader)
**Como:** Usuario de Fokkus IDE.
**Quiero:** Ver mensajes dinámicos ("Cargando...", "Analizando...", "Procesando tu respuesta...") mientras el orquestador o los agentes están resolviendo la petición, tal como lo hacen Claude o ChatGPT.
**Para:** Tener retroalimentación visual clara de que el sistema no se ha colgado y el agente efectivamente está procesando la solicitud.

## HU-08: Mini-Terminal de Ejecución de Agentes en Chat
**Como:** Usuario de Fokkus IDE.
**Quiero:** Que, al mostrarse el mensaje dinámico de agente trabajando, aparezca una pequeña flecha desplegable al lado que permita expandir una mini-terminal dentro del chat.
**Para:** Poder observar en tiempo real los logs y comandos (stdout/stderr) que están ejecutando todos los agentes del Swarm en segundo plano (y no solo el líder), facilitando la depuración y auditoría del proceso.

## HU-11: [FIX] Visibilidad de Botón de Compactación
**Como:** Usuario de Fokkus IDE.
**Quiero:** Que el botón (icono de escoba) para compactar el historial sea claramente visible.
**Para:** Poder accionar la compactación de forma manual sin problemas.

## HU-12: [FIX] Reubicación de Barra de Compactar
**Como:** Usuario de Fokkus IDE.
**Quiero:** Que la barra de progreso del historial de chat se ubique en la zona inferior del chat (sobre la caja de entrada de texto).
**Para:** Tener el indicador de contexto cerca del lugar donde se ingresa el texto nuevo.

## HU-13: [FIX] Visualización de Logs en el Desplegable de Procesamiento
**Como:** Usuario de Fokkus IDE.
**Quiero:** Que al hacer clic en la flecha para desplegar el detalle del procesamiento, los logs se vean correctamente.
**Para:** Poder seguir en tiempo real lo que está ejecutando el Swarm.

## HU-14: [FIX] Rediseño del Indicador de Procesamiento
**Como:** Usuario de Fokkus IDE.
**Quiero:** Que el indicador de "Analizando..." deje de verse como una burbuja de mensaje de chat tradicional, adoptando un diseño más sutil y propio de un estado de carga.
**Para:** Diferenciar entre un mensaje final de respuesta y un estado de procesamiento.

## HU-15: [FEATURE] Resumen al Compactar Historial
**Como:** Usuario de Fokkus IDE.
**Quiero:** Que al accionar la compactación del chat, se genere automáticamente un pequeño resumen indicando todo lo realizado hasta el momento y se muestre como un mensaje en el chat.
**Para:** No perder el contexto humano de las acciones previas al reiniciar o limpiar la ventana, manteniendo un registro de los logros alcanzados.

## HU-16: [FIX] Superposición de Flechas en el Grafo
**Como:** Usuario de Fokkus IDE.
**Quiero:** Que las líneas/flechas de conexión en el constructor del Swarm queden por encima (z-index mayor) de los nodos de los agentes.
**Para:** Que las conexiones sean visualmente claras y no se oculten por detrás de las tarjetas de agente.

## HU-17: [FEATURE] Selección Dinámica del Agente Líder
**Como:** Usuario de Fokkus IDE.
**Quiero:** Poder designar qué agente será el "Líder de Equipo" (PO) directamente desde el grafo, reemplazando la configuración estática actual que fija a Antigravity.
**Para:** Tener flexibilidad y asignar el rol de comunicación principal con el usuario a cualquier agente del Swarm.

## HU-18: [FEATURE] Renombrado de Agentes en el Grafo
**Como:** Usuario de Fokkus IDE.
**Quiero:** Poder editar y cambiar los nombres visibles de los agentes dentro de las tarjetas del grafo.
**Para:** Personalizar la visualización de los roles en lugar de estar atado a los nombres por defecto.
