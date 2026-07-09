#!/usr/bin/env node
/**
 * Actualiza el catálogo de index.html con datos en vivo de la
 * Product Advertising API (PA-API v5) de Amazon.
 *
 * Qué actualiza de cada producto que tenga `asin`:
 *   - affiliate_link : DetailPageURL de Amazon (ya incluye tu tag de afiliado)
 *   - image_url      : imagen oficial (uso permitido: viene de la API)
 *   - marca          : marca declarada por Amazon
 *   - disponible     : false si Amazon no ofrece el producto -> se oculta solo
 *
 * NO toca `name` ni los textos editoriales: esos los escribes tú.
 * NO escribe precios: para mostrarlos hay que renderizarlos junto a la
 * fecha de actualización (requisito de Amazon). Ver README.md.
 *
 * Requiere Node 18+ (usa fetch nativo). Sin dependencias externas.
 *
 * Variables de entorno:
 *   PAAPI_ACCESS_KEY, PAAPI_SECRET_KEY, PAAPI_PARTNER_TAG
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const HOST = "webservices.amazon.com";
const REGION = "us-east-1";
const SERVICE = "ProductAdvertisingAPI";
const MARKETPLACE = "www.amazon.com";
const URI = "/paapi5/getitems";
const TARGET = "com.amazon.paapi5.v1.ProductAdvertisingAPIv1.GetItems";
const MAX_POR_LOTE = 10; // límite de GetItems

const ACCESS_KEY = process.env.PAAPI_ACCESS_KEY;
const SECRET_KEY = process.env.PAAPI_SECRET_KEY;
const PARTNER_TAG = process.env.PAAPI_PARTNER_TAG;

const INDEX_PATH = path.resolve(__dirname, "..", "index.html");
const ARRAY_RE = /( {4}const products = )\[[\s\S]*?\n {4}\];/;

/* ---------------- Firma AWS SigV4 ---------------- */

const sha256hex = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data, "utf8").digest();

function buildHeaders(payload) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  const headers = {
    "content-encoding": "amz-1.0",
    "content-type": "application/json; charset=utf-8",
    host: HOST,
    "x-amz-date": amzDate,
    "x-amz-target": TARGET,
  };

  // Deben ir en minúsculas y ordenados alfabéticamente.
  const signedList = ["content-encoding", "content-type", "host", "x-amz-date", "x-amz-target"];
  const canonicalHeaders = signedList.map((h) => `${h}:${headers[h]}\n`).join("");
  const signedHeaders = signedList.join(";");

  const canonicalRequest = [
    "POST",
    URI,
    "", // query string vacío
    canonicalHeaders,
    signedHeaders,
    sha256hex(payload),
  ].join("\n");

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

async function getItems(asins) {
  const payload = JSON.stringify({
    ItemIds: asins,
    ItemIdType: "ASIN",
    PartnerTag: PARTNER_TAG,
    PartnerType: "Associates",
    Marketplace: MARKETPLACE,
    Resources: [
      "Images.Primary.Large",
      "ItemInfo.ByLineInfo",
      "ItemInfo.Title",
      "Offers.Listings.Availability.Message",
      "Offers.Listings.Price",
    ],
  });

  const res = await fetch(`https://${HOST}${URI}`, {
    method: "POST",
    headers: buildHeaders(payload),
    body: payload,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`PA-API respondió ${res.status}: ${text}`);
  return JSON.parse(text);
}

/* ---------------- Lectura / escritura del catálogo ---------------- */

function leerProductos(html) {
  const m = html.match(ARRAY_RE);
  if (!m) throw new Error("No se encontró el array `const products = [...]` en index.html");
  const literal = m[0].slice(m[1].length); // solo el "[...]"
  // Es nuestro propio archivo y son literales de objeto: evaluarlo es seguro aquí.
  return new Function("return " + literal.replace(/;$/, ""))();
}

function escribirProductos(html, productos) {
  const json = JSON.stringify(productos, null, 2)
    .split("\n")
    .map((linea, i) => (i === 0 ? linea : "    " + linea))
    .join("\n");
  return html.replace(ARRAY_RE, (_, prefijo) => `${prefijo}${json};`);
}

const chunk = (arr, n) =>
  Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/* ---------------- Programa principal ---------------- */

async function main() {
  for (const [nombre, valor] of Object.entries({ PAAPI_ACCESS_KEY: ACCESS_KEY, PAAPI_SECRET_KEY: SECRET_KEY, PAAPI_PARTNER_TAG: PARTNER_TAG })) {
    if (!valor) {
      console.error(`Falta la variable de entorno ${nombre}. Ver scripts/README.md`);
      process.exit(1);
    }
  }

  const html = fs.readFileSync(INDEX_PATH, "utf8");
  const productos = leerProductos(html);

  const conAsin = productos.filter((p) => p.asin);
  if (!conAsin.length) {
    console.log("Ningún producto tiene `asin`. Nada que actualizar.");
    return;
  }
  console.log(`${conAsin.length} de ${productos.length} productos tienen ASIN.`);

  // Amazon devuelve solo los ASIN que resuelve; los ausentes se marcan agotados.
  const encontrados = new Map();
  for (const lote of chunk(conAsin.map((p) => p.asin), MAX_POR_LOTE)) {
    const data = await getItems(lote);
    for (const item of data?.ItemsResult?.Items ?? []) encontrados.set(item.ASIN, item);
    if (data?.Errors?.length) {
      for (const e of data.Errors) console.warn(`Aviso de Amazon: ${e.Code} — ${e.Message}`);
    }
  }

  let actualizados = 0;
  let agotados = 0;

  for (const p of productos) {
    if (!p.asin) continue;
    const item = encontrados.get(p.asin);

    if (!item) {
      if (p.disponible !== false) agotados++;
      p.disponible = false; // ASIN inválido o retirado: ocúltalo
      continue;
    }

    const oferta = item.Offers?.Listings?.[0];
    const hayOferta = Boolean(oferta?.Price?.Amount);

    p.disponible = hayOferta;
    if (!hayOferta) agotados++;

    if (item.DetailPageURL) p.affiliate_link = item.DetailPageURL; // ya lleva el tag
    const img = item.Images?.Primary?.Large?.URL;
    if (img) p.image_url = img;
    const marca = item.ItemInfo?.ByLineInfo?.Brand?.DisplayValue;
    if (marca) p.marca = marca;

    actualizados++;
  }

  fs.writeFileSync(INDEX_PATH, escribirProductos(html, productos), "utf8");
  console.log(`Listo. Actualizados: ${actualizados}. Marcados como agotados: ${agotados}.`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
