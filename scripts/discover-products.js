#!/usr/bin/env node
/**
 * Busca productos nuevos de hogar y cocina en la Product Advertising API
 * (PA-API v5) y genera un BORRADOR listo para revisar.
 *
 * Qué hace:
 *   1. Busca en la categoría indicada (por defecto, Home & Kitchen).
 *   2. Descarta los ASIN que ya están en index.html.
 *   3. Escribe scripts/candidatos.js con las fichas en borrador.
 *
 * Qué NO hace, a propósito: no toca index.html. Los textos que genera
 * Amazon son genéricos; el criterio editorial ("ideal para", "elige este
 * si...") es lo que distingue esta web de un catálogo automático. El
 * borrador se revisa antes de publicar.
 *
 * OJO: la PA-API v5 NO devuelve valoraciones ni número de reseñas —
 * Amazon las retiró de la API. Esos dos campos siguen siendo manuales.
 *
 * Requiere Node 18+ (fetch nativo). Sin dependencias externas.
 *
 * Uso:
 *   node scripts/discover-products.js                    # Home & Kitchen
 *   node scripts/discover-products.js --nodo 284507      # otra categoría
 *   node scripts/discover-products.js --paginas 3        # más resultados
 *   node scripts/discover-products.js --buscar "air fryer"
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HOST = "webservices.amazon.com";
const REGION = "us-east-1";
const SERVICE = "ProductAdvertisingAPI";
const MARKETPLACE = "www.amazon.com";
const URI = "/paapi5/searchitems";
const TARGET = "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems";

// Categoría de Amazon US. 1055398 = Home & Kitchen.
// Si prefieres otra, saca su id de la URL de la categoría en Amazon.
const NODO_POR_DEFECTO = "1055398";
const MAX_POR_PAGINA = 10; // límite de la API

const ACCESS_KEY = process.env.PAAPI_ACCESS_KEY;
const SECRET_KEY = process.env.PAAPI_SECRET_KEY;
const PARTNER_TAG = process.env.PAAPI_PARTNER_TAG;

const INDEX_PATH = path.resolve(__dirname, "..", "index.html");
const SALIDA_PATH = path.resolve(__dirname, "candidatos.js");

/* ---------------- Argumentos ---------------- */

function arg(nombre, porDefecto) {
  const i = process.argv.indexOf("--" + nombre);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : porDefecto;
}

/* ---------------- Firma AWS SigV4 ---------------- */

const sha256hex = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data, "utf8").digest();

function buildHeaders(payload) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);

  const headers = {
    "content-encoding": "amz-1.0",
    "content-type": "application/json; charset=utf-8",
    host: HOST,
    "x-amz-date": amzDate,
    "x-amz-target": TARGET,
  };

  const signedList = ["content-encoding", "content-type", "host", "x-amz-date", "x-amz-target"];
  const canonicalHeaders = signedList.map((h) => `${h}:${headers[h]}\n`).join("");
  const signedHeaders = signedList.join(";");

  const canonicalRequest = ["POST", URI, "", canonicalHeaders, signedHeaders, sha256hex(payload)].join("\n");
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");

  let key = hmac("AWS4" + SECRET_KEY, dateStamp);
  key = hmac(key, REGION);
  key = hmac(key, SERVICE);
  key = hmac(key, "aws4_request");
  const signature = crypto.createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");

  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

async function searchItems({ nodo, keywords, pagina }) {
  const cuerpo = {
    PartnerTag: PARTNER_TAG,
    PartnerType: "Associates",
    Marketplace: MARKETPLACE,
    BrowseNodeId: nodo,
    SearchIndex: "All",
    ItemCount: MAX_POR_PAGINA,
    ItemPage: pagina,
    // "Featured" se aproxima al orden de superventas de la categoría.
    SortBy: "Featured",
    Resources: [
      "Images.Primary.Large",
      "ItemInfo.ByLineInfo",
      "ItemInfo.Features",
      "ItemInfo.Title",
      "Offers.Listings.Availability.Message",
      "Offers.Listings.Price",
    ],
  };
  if (keywords) cuerpo.Keywords = keywords;

  const payload = JSON.stringify(cuerpo);
  const res = await fetch(`https://${HOST}${URI}`, {
    method: "POST",
    headers: buildHeaders(payload),
    body: payload,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`PA-API respondió ${res.status}: ${text}`);
  return JSON.parse(text);
}

/* ---------------- Catálogo actual ---------------- */

// Solo necesitamos saber qué ASIN ya tenemos, así que basta con leerlos.
function asinsExistentes() {
  const html = fs.readFileSync(INDEX_PATH, "utf8");
  const array = html.match(/ {4}const products = \[[\s\S]*?\n {4}\];/);
  if (!array) throw new Error("No se encontró el array `products` en index.html");
  return new Set([...array[0].matchAll(/asin:\s*"([A-Z0-9]{10})"/g)].map((m) => m[1]));
}

/* ---------------- Generación del borrador ---------------- */

const esc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

function fichaBorrador(item) {
  const titulo = item.ItemInfo?.Title?.DisplayValue || "";
  const marca = item.ItemInfo?.ByLineInfo?.Brand?.DisplayValue || "";
  const imagen = item.Images?.Primary?.Large?.URL || "";
  // Las features de Amazon son el "Sobre este artículo"; sirven de punto
  // de partida, pero conviene reescribirlas con voz propia.
  const features = (item.ItemInfo?.Features?.DisplayValues || [])
    .slice(0, 5)
    .map((f) => f.replace(/\s+/g, " ").trim());

  return `      {
        // REVISAR: acortar el nombre, escribir descripcion propia,
        // elegir categoria y anadir valoracion_media + resenas_cantidad.
        name: "${esc(titulo)}",
        description: "",
        affiliate_link: "${esc(item.DetailPageURL || "")}",
        isFeatured: false,
        category: "Cocina",
        showInTopMenu: true,
        image_url: "${esc(imagen)}",
        marca: "${esc(marca)}",
        asin: "${esc(item.ASIN)}",
        ideal_para: "",
        pros: "${esc(features.join("|"))}",
        destacado_editorial: "",
        en: { name: "", description: "", ideal_para: "", pros: "", destacado_editorial: "" }
      }`;
}

/* ---------------- Programa principal ---------------- */

async function main() {
  for (const [nombre, valor] of Object.entries({
    PAAPI_ACCESS_KEY: ACCESS_KEY,
    PAAPI_SECRET_KEY: SECRET_KEY,
    PAAPI_PARTNER_TAG: PARTNER_TAG,
  })) {
    if (!valor) {
      console.error(`Falta la variable de entorno ${nombre}. Ver scripts/README.md`);
      process.exit(1);
    }
  }

  const nodo = arg("nodo", NODO_POR_DEFECTO);
  const keywords = arg("buscar", null);
  const paginas = Math.min(Number(arg("paginas", 2)) || 2, 10);

  const yaTengo = asinsExistentes();
  console.log(`Catálogo actual: ${yaTengo.size} productos con ASIN.`);
  console.log(`Buscando en la categoría ${nodo}${keywords ? ` ("${keywords}")` : ""}, ${paginas} página(s)...`);

  const nuevos = new Map();
  for (let pagina = 1; pagina <= paginas; pagina++) {
    let data;
    try {
      data = await searchItems({ nodo, keywords, pagina });
    } catch (e) {
      console.warn(`Página ${pagina}: ${e.message}`);
      break;
    }

    for (const item of data?.SearchResult?.Items ?? []) {
      if (yaTengo.has(item.ASIN) || nuevos.has(item.ASIN)) continue;
      // Sin oferta activa no lo proponemos: estaría agotado desde el día uno.
      if (!item.Offers?.Listings?.[0]?.Price?.Amount) continue;
      nuevos.set(item.ASIN, item);
    }

    // La API limita las peticiones por segundo; un respiro entre páginas.
    if (pagina < paginas) await new Promise((r) => setTimeout(r, 1100));
  }

  if (!nuevos.size) {
    console.log("No se encontraron productos nuevos que no estén ya en la web.");
    return;
  }

  const fecha = new Date().toISOString().slice(0, 10);
  const cabecera = [
    `/* Borrador generado por discover-products.js el ${fecha}.`,
    `   ${nuevos.size} candidato(s). NO se han publicado: revisa y completa los`,
    `   campos vacíos antes de pegarlos en el array products de index.html.`,
    `   Recuerda que valoracion_media y resenas_cantidad hay que copiarlos a`,
    `   mano desde la página del producto: la PA-API no los devuelve. */`,
    ``,
    `const CANDIDATOS = [`,
    [...nuevos.values()].map(fichaBorrador).join(",\n"),
    `];`,
    ``,
  ].join("\n");

  fs.writeFileSync(SALIDA_PATH, cabecera, "utf8");
  console.log(`\n${nuevos.size} candidato(s) escritos en scripts/candidatos.js`);
  console.log("Revisa el archivo, completa los textos y pégalos en index.html.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
