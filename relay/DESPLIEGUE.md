# Desplegar el relay de Uniovi Virtual

El relay es un pequeño programa (un "Worker") que corre gratis en Cloudflare. Hace de puente: la IA del
estudiante (claude.ai, ChatGPT…) llama a una dirección fija del relay, y el relay pasa la pregunta a la
extensión de Chrome de ese estudiante y devuelve la respuesta. No guarda preguntas, respuestas ni archivos:
solo una huella (hash) de la clave de cada extensión, para que nadie pueda hacerse pasar por ella.

Solo hay que hacerlo **una vez** (y repetir `npx wrangler deploy` si cambia el código de `relay/`).

## 1. Crear la cuenta de Cloudflare (gratis, sin tarjeta)

1. Entra en <https://dash.cloudflare.com/sign-up> y regístrate con un correo y una contraseña.
2. Confirma el correo. No hace falta añadir ningún dominio ni tarjeta: el plan gratuito ("Workers Free")
   basta.

## 2. Publicar el relay

Necesitas Node.js en tu ordenador (solo tú, el mantenedor; los estudiantes no). En una terminal, desde la
carpeta del proyecto:

```sh
cd relay
npm install
npx wrangler login
npx wrangler deploy
```

- `npx wrangler login` abre el navegador para que autorices a Wrangler en tu cuenta de Cloudflare.
- La primera vez, `deploy` puede preguntarte por un subdominio `workers.dev`: elige uno (por ejemplo, tu
  nombre). Es parte de la dirección y no se puede cambiar fácilmente, así que elige algo neutro.
- Al terminar imprime una dirección como:

  ```
  https://uniovi-relay.<subdominio>.workers.dev
  ```

## 3. Poner la dirección en la extensión

1. Abre `shared/relay.ts` y cambia `RELAY_URL` por la dirección que imprimió `deploy`, **sin barra final**:

   ```ts
   export const RELAY_URL = "https://uniovi-relay.<subdominio>.workers.dev";
   ```

2. Reconstruye: `npm run build` (en la raíz del proyecto).
3. Publica un zip nuevo de la extensión (`npm run package`) para que los estudiantes lo descarguen.

Ojo: si más adelante cambias de dirección, todos los enlaces que los estudiantes pegaron en su IA dejarán de
funcionar y tendrán que pegar el nuevo. Elige la dirección una vez y no la cambies.

## 4. Comprobar que funciona

```sh
curl https://uniovi-relay.<subdominio>.workers.dev/
```

Debe mostrar una página corta «Uniovi Virtual» (su icono está en `/icon.png`). Cualquier otra dirección (por ejemplo `/hola`) responde `Not found`.

Con la extensión instalada y Chrome abierto, la IA del estudiante ya debería poder usar sus apuntes. Si Chrome
está cerrado, la IA recibe el mensaje "Uniovi Virtual no está conectado: abre Chrome…".

## 5. Límites del plan gratuito

- **100.000 peticiones al día** entre todos los estudiantes (se reinicia a las 00:00 UTC, la 1:00 o las 2:00
  en España). Cada pregunta a la IA suele usar unas pocas peticiones, así que da para muchos estudiantes.
- Si se supera, Cloudflare **no cobra nada**: simplemente rechaza las peticiones con el **error 1027** hasta el
  día siguiente. Las IAs mostrarán un error y los estudiantes tendrán que esperar al reinicio.
- El relay limita además a cada estudiante a 120 peticiones por minuto (responde 429 si se pasa), para que un
  solo uso descontrolado no gaste la cuota de todos.
- Los "ping" que la extensión manda cada 20 segundos los contesta Cloudflare sin despertar al relay.
- Puedes ver el consumo en el panel de Cloudflare: **Workers & Pages → uniovi-relay → Metrics**.

## 6. Volver atrás

- **A la versión anterior del relay:** `npx wrangler rollback` (dentro de `relay/`) y elige la versión;
  `npx wrangler deployments list` muestra el historial.
- **Quitarlo del todo:** `npx wrangler delete` (dentro de `relay/`). Las extensiones dirán "no está
  conectado" hasta que haya un relay de nuevo.
- **Volver al instalador anterior:** la versión con instalador para Windows está guardada en la etiqueta de
  git `v0.1.0-instalador`.

## Para desarrollo (sin cuenta)

`npx wrangler dev --port 8787` (dentro de `relay/`) ejecuta el relay en tu ordenador, en
`http://127.0.0.1:8787`. La prueba completa está en `relay/test/e2e.mjs` (las instrucciones, al principio del
archivo). `npm run typecheck` en la raíz necesita haber hecho antes `npm install` dentro de `relay/`.
