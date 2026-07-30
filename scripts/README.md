# Automatización del catálogo con la PA-API de Amazon

Este directorio contiene la integración **preparada pero todavía inactiva** con la
Product Advertising API (PA-API v5) de Amazon.

| Script | Para qué sirve |
|---|---|
| `update-products.js` | Refresca los productos **que ya están** en la web y oculta los agotados. |
| `discover-products.js` | **Busca productos nuevos** de hogar y cocina y genera un borrador para revisar. |

## Buscar productos nuevos (`discover-products.js`)

Es lo más parecido a "que se añadan solos". Busca en la categoría de Amazon que
le indiques, descarta los ASIN que ya tienes y escribe `scripts/candidatos.js`
con las fichas en borrador.

```bash
node scripts/discover-products.js                  # Home & Kitchen, 2 páginas
node scripts/discover-products.js --paginas 4      # más resultados
node scripts/discover-products.js --buscar "air fryer"
node scripts/discover-products.js --nodo 284507    # otra categoría
```

**No toca `index.html` a propósito.** Los textos que devuelve Amazon son
genéricos y en varios idiomas mezclados; el criterio editorial ("ideal para…",
"elige este si…") es justo lo que distingue esta web de un catálogo automático.
El flujo es: generar borrador → revisar y reescribir → pegar en `index.html`.

**Dos campos siguen siendo manuales:** `valoracion_media` y `resenas_cantidad`.
Amazon retiró las valoraciones de la PA-API, así que no hay forma de obtenerlas
por API; hay que copiarlas de la página del producto.

## Refrescar lo que ya está (`update-products.js`)

Cuando se active, cada día automáticamente:

- Refresca el **enlace de afiliado** de cada producto (con tu tag ya incluido).
- Refresca la **imagen oficial** desde la API (uso permitido por Amazon).
- Refresca la **marca**.
- Marca como `disponible: false` los productos **agotados o retirados**, y la web
  **los oculta sola** del catálogo.

## Por qué todavía no está activa

Amazon **solo concede acceso a la PA-API después de 3 ventas válidas**. Hoy la
cuenta tiene 0 ventas, así que las credenciales aún no existen. No hay atajo:
es un requisito de Amazon, no una limitación del código.

Hasta entonces, la web **no muestra precios** (`Ver precio en Amazon`), que es
justamente lo que exige el Acuerdo Operativo de Associates: no se pueden publicar
precios estáticos porque se desactualizan.

## Cómo activarla (cuando tengas las 3 ventas)

1. **Consigue las credenciales.** En Associates Central → *Herramientas* →
   *Product Advertising API* → *Join / Manage credentials*. Apunta el
   `Access Key` y el `Secret Key` (el secreto **solo se muestra una vez**).

2. **Guárdalas como secretos de GitHub.** En el repositorio →
   *Settings* → *Secrets and variables* → *Actions* → *New repository secret*:

   | Nombre | Valor |
   |---|---|
   | `PAAPI_ACCESS_KEY` | tu Access Key |
   | `PAAPI_SECRET_KEY` | tu Secret Key |
   | `PAAPI_PARTNER_TAG` | `micasaperfect-20` |

   > Nunca pongas estas claves en el código. El repositorio es público.

3. **Añade el `asin` a cada producto** en el array `products` de `index.html`.
   El ASIN es el código que aparece en cualquier URL de Amazon:
   `amazon.com/dp/`**`B08XYZ1234`**`/...`

   ```js
   {
     name: "Cafetera Keurig K-Express (cápsulas K-Cup)",
     asin: "B08XYZ1234",
     ...
   }
   ```

4. **Pruébala a mano.** En GitHub → pestaña *Actions* →
   *Actualizar productos (Amazon PA-API)* → *Run workflow*.
   Revisa el registro: debe decir cuántos productos actualizó.

5. **Automatízala.** Si el paso 4 va bien, edita
   `.github/workflows/update-products.yml` y descomenta el bloque `schedule`.

## Volver a mostrar precios

Con la PA-API activa **sí se pueden mostrar precios**, pero Amazon exige enseñar
también **la fecha y hora de la última actualización**. Eso implica dos cambios:

- En `scripts/update-products.js`, guardar `precio` y `precio_actualizado` en
  cada producto (los datos ya se piden en `Resources`, solo hay que persistirlos).
- En `index.html`, volver a dibujar el precio junto a un texto tipo
  *"Precio a fecha de 3 jul 2026, 06:00 UTC"*.

No lo he dejado hecho a propósito: mostrar un precio sin refresco automático
funcionando sería exactamente el problema que esta refactorización elimina.

## Ejecutar en local

Necesitas **Node 18 o superior** (usa `fetch` nativo; no hay dependencias):

```bash
export PAAPI_ACCESS_KEY="..."
export PAAPI_SECRET_KEY="..."
export PAAPI_PARTNER_TAG="micasaperfect-20"
node scripts/update-products.js
```

## Estado del código

Los dos scripts implementan la firma **AWS Signature V4** que exige la PA-API,
sin librerías externas. **Ninguno se ha podido ejecutar todavía contra la API
real** porque no existen credenciales, ni siquiera en local (esta máquina no
tiene Node instalado). Cuando los pruebes por primera vez, espera tener que
ajustar algún detalle: revisa la salida antes de fiarte de ella, y en el caso
de `update-products.js`, antes de programar el `cron`.

Si `discover-products.js` no devuelve nada, lo primero que hay que revisar es
el id de categoría (`--nodo`): Amazon los cambia y varían por marketplace.
