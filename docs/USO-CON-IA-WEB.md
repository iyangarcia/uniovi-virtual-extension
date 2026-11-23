# Usar Uniovi Virtual con ChatGPT, Gemini o Claude (web)

Con esto, tu chat de IA puede **consultar tu campus en directo**: buscar dentro de todas las diapositivas y PDFs de tus asignaturas (con página), ver tus entregas y exámenes ordenados por fecha, leer los avisos de los foros y detectar fechas de examen anunciadas allí. Eso no se consigue subiendo archivos a mano: la IA ve siempre lo último que hayas sincronizado y busca en todo a la vez.

## Cómo funciona

```
Uniovi Virtual ──(extensión de Chrome)──► tu PC (servidor local) ──(túnel https)──► ChatGPT / Gemini / Claude
```

Tus datos se quedan en tu ordenador (`~/uniovi-data`). El chat solo puede **leerlos**, y únicamente mientras la ventana `start-remote` esté abierta.

## Requisitos (una sola vez)

1. **Node.js** 22.18 o superior: <https://nodejs.org>.
2. **cloudflared** (crea el túnel; no necesita cuenta). En Windows, abre PowerShell y ejecuta:
   ```
   winget install --id Cloudflare.cloudflared
   ```
3. La **extensión** instalada y una sincronización hecha. Para ello, abre Uniovi Virtual y pulsa "Sync now" en la extensión.

## Cada vez que quieras usarlo

1. Haz doble clic en **`start-remote.bat`**. Si estás en una terminal, usa `npm run remote`.
2. Espera a que aparezca la **URL del conector**, que termina en `/mcp/…`. También la verás en la ventanita de la extensión, con el botón **Copiar URL del conector**.
3. Pégala en tu chat, como se explica abajo.
4. Deja la ventana abierta mientras estudias. Al cerrarla, el chat pierde el acceso.

> La URL **cambia cada vez** que vuelves a abrir `start-remote`, así que actualízala en el chat.

## Añadir el conector

### Claude (claude.ai)
Ve a *Settings → Connectors → Add custom connector*. Pon de nombre "Uniovi Virtual", pega la URL y guarda. Después, en un chat nuevo, actívalo desde el botón de herramientas.

### ChatGPT
Ve a *Settings → Apps & Connectors → Advanced → Developer mode* y actívalo. Después, en *Create*, pon de nombre "Uniovi Virtual", pega la URL en *MCP Server URL*, elige **No authentication** y marca que confías en la aplicación. En el chat, selecciónalo con el botón **+** y luego **Developer mode**.
Según el plan de ChatGPT, el modo desarrollador puede no estar disponible (oficialmente: Business/Enterprise/Edu; algunos planes Plus/Pro lo tienen en modo solo lectura, que es suficiente).

### Gemini
Ve a *Settings → Connected apps → Add custom app*, pega la URL y guarda.
Google lo está desplegando poco a poco y puede pedir la interfaz en inglés, tener activada la *Actividad* o no estar disponible en tu país.

## Qué pedirle

- "¿Qué entregas y exámenes tengo en las próximas dos semanas?"
- "Prepárame el próximo examen de Física: fecha, qué entra, plan de estudio y preguntas de práctica."
- "Explícame el tema 3 de Cálculo con las diapositivas de la asignatura y hazme un mini test."
- "Busca en mis apuntes dónde se explica la ley de Ohm."
- "¿Ha habido avisos nuevos en los foros esta semana?"

Si algo sale vacío o antiguo, pídele que mire `sync_status` y vuelve a sincronizar desde la extensión.

## Privacidad (importante)

- **La URL es como una contraseña.** Quien la tenga puede leer tus asignaturas, materiales y avisos mientras `start-remote` esté abierto. No la compartas ni la publiques.
- Si crees que se ha filtrado, ciérralo y ábrelo con un token nuevo: `npm run remote -- --rotate-token` (o `start-remote.bat --rotate-token`). La URL antigua deja de funcionar.
- El chat solo puede **leer**: no puede entregar tareas, escribir en foros ni cambiar nada del campus.
- Lo que la IA lea pasa a la conversación del servicio que uses (OpenAI, Google o Anthropic), con sus propias condiciones.

## Limitaciones

- Tu PC tiene que estar encendido, con `start-remote` abierto.
- Los datos son los de tu **última sincronización**. La extensión puede sincronizar sola cada pocas horas (ajústalo en su ventana).
- Sin acceso a conectores, puedes seguir descargando materiales y subirlos al chat, aunque sin búsqueda en todo ni fechas actualizadas.
