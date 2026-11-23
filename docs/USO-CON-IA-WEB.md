# Usar Uniovi Virtual con Claude, ChatGPT o Gemini

Con esto, tu chat de IA puede **consultar tu campus**: buscar dentro de las diapositivas y PDFs de todas tus asignaturas (te dice la página), ver tus entregas y exámenes ordenados por fecha, leer los avisos de los foros y detectar fechas de examen anunciadas allí. La IA ve siempre lo último que hayas sincronizado y busca en todo a la vez, sin que tengas que subir archivos a mano.

```
Uniovi Virtual ──(extensión de Chrome)──► tu PC (asistente) ──(túnel https)──► Claude / ChatGPT / Gemini
```

Tus archivos se quedan **en tu ordenador**. No hay ningún servidor central ni cuentas nuevas: solo la de la IA que ya uses.

Requisitos: Windows 10/11 y Google Chrome (o Edge). No hacen falta permisos de administrador.

## 1. Instalar (una vez)

1. Descarga `UnioviVirtual-Setup-<versión>.exe` y ábrelo.
2. Es probable que Windows muestre **"Windows protegió su PC"** (SmartScreen), porque el instalador no está firmado. Pulsa **Más información → Ejecutar de todas formas**.
3. Sigue el asistente. Al final deja marcadas **"Iniciar el asistente ahora"** y **"Abrir la carpeta de la extensión"**.

El instalador pone todo en `%LOCALAPPDATA%\UnioviVirtual` y hace que el **asistente** (un pequeño programa sin ventanas) se inicie solo cada vez que entras en Windows.

## 2. Cargar la extensión en Chrome (una vez)

1. Escribe `chrome://extensions` en la barra de direcciones.
2. Activa **Modo de desarrollador** (arriba a la derecha).
3. Pulsa **Cargar descomprimida** y elige la carpeta `%LOCALAPPDATA%\UnioviVirtual\extension` (la que abrió el instalador).
4. Fija la extensión con el icono del puzle para tenerla a mano.

Chrome puede recordarte de vez en cuando que tienes extensiones en modo desarrollador; es normal.

## 3. Primera sincronización

Entra en [Uniovi Virtual](https://campusvirtual.uniovi.es) con tu usuario de siempre. La extensión sincroniza sola (tarda unos segundos la primera vez, algo más si tienes muchos archivos). También puedes pulsar **Sync now** en su ventanita.

La extensión **nunca** ve tu contraseña: usa la sesión que ya tienes abierta en el navegador.

## 4. La ventanita de la extensión

En el apartado **Usar con ChatGPT / Gemini / Claude web** verás el estado del asistente:

| Estado | Qué significa | Qué hacer |
|---|---|---|
| Asistente no instalado | Chrome no encuentra el asistente | Ejecuta el instalador otra vez |
| Asistente detenido | Instalado pero apagado | Pulsa **Iniciar** |
| Conectando… | Abriendo el túnel (hasta un minuto) | Espera |
| Listo | Hay una URL del conector | Pulsa **Copiar URL del conector** |
| Error | Ningún túnel ha funcionado (sigue reintentando) | Mira "Problemas frecuentes" |

También puedes **Detener** el asistente, desactivar el conector para IAs web, o **Cambiar** la carpeta de datos (los archivos ya descargados no se mueven).

## 5. Añadir el conector a tu IA

Copia la URL (termina en `/mcp/…`) y pégala como **conector personalizado**. Solo hay que hacerlo una vez, salvo que la URL cambie (ver más abajo). Los menús cambian a menudo; si no encuentras la opción, busca "conectores" o "MCP" en la ayuda de tu IA.

### Claude (claude.ai)
*Settings → Connectors → Add custom connector*. Nombre: "Uniovi Virtual". Pega la URL y guarda. En un chat nuevo, actívalo desde el botón de herramientas. Según tu plan, el número de conectores personalizados puede estar limitado.

### ChatGPT
*Settings → Apps & Connectors → Advanced → Developer mode*: actívalo. Después pulsa *Create*: nombre "Uniovi Virtual", pega la URL en *MCP Server URL*, elige **No authentication** y marca que confías en la aplicación. En el chat, pulsa **+ → Developer mode** y elige el conector.
Según tu plan, el modo desarrollador puede no estar disponible (oficialmente Business/Enterprise/Edu; algunos planes Plus/Pro lo tienen en modo solo lectura, que es suficiente porque todo esto es de solo lectura).

### Gemini
Siendo sinceros: la app de Gemini **solo** admite conectores MCP personalizados en algunos planes y países, y Google lo está desplegando poco a poco. Si en *Settings* ves algo como *Connected apps → Add custom app*, pega ahí la URL. Si no aparece, tu cuenta todavía no lo permite; usa Claude o ChatGPT.

## 6. Cuando la URL cambia

La URL pública **puede cambiar**: al reiniciar el PC, al cambiar de red o si se corta el túnel. Cuando pase, la extensión te mostrará un aviso ("pega la nueva URL en tu IA"). Entonces:

1. Abre la ventanita de la extensión y pulsa **Copiar URL del conector**.
2. En tu IA, **edita** el conector "Uniovi Virtual" (o bórralo y créalo de nuevo) y pega la URL nueva.

En algunas redes (por ejemplo, Wi-Fi que bloquea casi todos los puertos) solo funciona un proveedor de túnel cuyas sesiones gratuitas duran **60 minutos**: en ese caso la URL cambia cada hora y tendrás que repetir estos pasos. En casa suele durar mucho más.

## 7. Qué pedirle

- "¿Qué exámenes tengo esta semana?"
- "¿Qué entregas y exámenes tengo en las próximas dos semanas?"
- "Prepárame el próximo examen de Física: fecha, qué entra, plan de estudio y preguntas de práctica."
- "Explícame el tema 3 de Cálculo con las diapositivas de la asignatura y hazme un mini test."
- "Busca en mis apuntes dónde se explica la ley de Ohm."
- "¿Ha habido avisos nuevos en los foros esta semana?"

Las fechas que vienen de los foros se detectan automáticamente: la IA debería citarte la frase y el enlace al aviso. Compruébalas en el campus.

## 8. Privacidad (léelo)

- **Tus archivos se quedan en tu PC**, en tu carpeta de datos (la ves en la ventanita). Nada se sube a ningún servidor nuestro: no lo hay.
- **La IA que conectes lee lo que pide** (un PDF, una lista de fechas, un aviso…). Eso pasa a tu conversación con esa empresa (Anthropic, OpenAI o Google) y se rige por sus condiciones.
- **El proveedor del túnel** (localhost.run, tunnelmole, pinggy o Cloudflare) puede ver ese tráfico mientras pasa por él, porque el cifrado https termina en sus servidores.
- Las URL de tunnelmole y pinggy **incluyen tu IP pública** en el nombre.
- **La URL del conector es como una contraseña.** Quien la tenga puede leer tus asignaturas, materiales y avisos mientras tu PC esté encendido. No la compartas ni la publiques.
- Si crees que se ha filtrado: pulsa **Detener**, borra el archivo `remote.json` de tu carpeta de datos y pulsa **Iniciar**. Se crea una URL nueva y la antigua deja de funcionar para siempre. Luego actualiza el conector en tu IA.
- Todo es **de solo lectura**: la IA no puede entregar tareas, escribir en foros ni cambiar nada del campus.
- Si no quieres conector web, desactiva "Conector para IAs web" en la ventanita: el panel y los avisos de la extensión siguen funcionando igual.

## 9. Problemas frecuentes

- **"Asistente no instalado"** en la ventanita: vuelve a ejecutar el instalador y recarga la extensión en `chrome://extensions`.
- **"Error" o se queda en "Conectando…"**: tu red puede estar bloqueando los túneles. El asistente prueba varios y reintenta solo; prueba con otra red (por ejemplo, datos del móvil) para comprobarlo.
- **La IA dice que no encuentra datos o están viejos**: pídele que mire `sync_status` y vuelve a entrar en el campus para sincronizar.
- **El conector deja de responder**: ¿está tu PC encendido y sin suspender? ¿Ha cambiado la URL? (sección 6).
- **Desinstalar**: *Configuración de Windows → Aplicaciones → Uniovi Virtual → Desinstalar*, y quita la extensión en `chrome://extensions`. Tu carpeta de datos **no** se borra; elimínala tú si quieres.

## Limitaciones

- Tu PC tiene que estar encendido y con internet mientras usas el conector.
- Los datos son los de tu **última sincronización**. La extensión sincroniza sola cada pocas horas cuando abres el campus (ajústalo en su ventanita).
- Sin conector, puedes seguir descargando materiales y subiéndolos al chat, aunque sin búsqueda en todo ni fechas actualizadas.

---

### Para desarrolladores

Sin instalador: `npm install && npm run build`, carga `extension/dist` y ejecuta `npm run remote` (o `start-remote.bat`), que abre el puente, el MCP remoto en `127.0.0.1:47824/mcp/<token>` y un túnel; `--rotate-token` cambia la URL. El instalador se genera con `npm run package` (ver README y CLAUDE.md).
