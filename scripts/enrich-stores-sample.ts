/**
 * Dry-run: enrich a small sample of stores without writing an output file.
 * Useful to verify the AI output quality before running the full dataset.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/enrich-stores-sample.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SAMPLE_STORES = [
  "GRID ABASTO",
  "GRID UNICENTER",
  "NSO ALTO PALERMO",
  "BLAST ALTO ROSARIO",
  "DASH(AMI) MENDOZA - A26",
  "SOLO DEPORTES BELGRANO",
  "SPORTING PALMARES (57)",
  "SPORTLINE DEVOTO SHOPPING",
  "DX DIGITAL",
  "DEPOSITO CENTRAL DASH",
  "MACRI SPORT CENTER Punta del Este -06",
  "LA CANCHA MONTEVIDEO SHOPPING",
  "NEWSPORT- PATIO OLMOS",
  "DX PALMAS DEL PILAR 147",
  "MV ABASTO 121",
];

const SYSTEM_PROMPT = `Eres un asistente experto en geografía de Argentina y Uruguay especializado en retail deportivo.
Tu tarea es analizar nombres de sucursales/tiendas y extraer información de ubicación.

Para cada tienda devuelves un JSON con estos campos:
- sucursal: el nombre exacto recibido (sin modificar)
- ciudad: ciudad donde está la tienda. null si no se puede determinar.
- provincia: provincia/departamento. null si no se puede determinar.
- pais: "AR" para Argentina, "UY" para Uruguay. Por defecto "AR".
- codigo_postal: código postal aproximado si se puede inferir. null si no es posible.
- shopping: nombre del shopping center si está dentro de uno. null si es tienda de calle.
- es_digital: true si es tienda online/e-commerce/marketplace.
- es_deposito: true si es depósito/almacén.

Devuelve SOLO un array JSON válido, sin markdown, sin explicaciones.`;

async function main() {
  if (!ANTHROPIC_API_KEY) {
    console.error("Set ANTHROPIC_API_KEY");
    process.exit(1);
  }

  console.log(`Testing ${SAMPLE_STORES.length} sample stores...\n`);

  const userMsg = `Analiza estas tiendas:\n${SAMPLE_STORES.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    }),
  });

  if (!res.ok) {
    console.error(await res.text());
    process.exit(1);
  }

  const data = (await res.json()) as { content: Array<{ type: string; text: string }> };
  const text = data.content.find((c) => c.type === "text")?.text ?? "";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) {
    console.error("No JSON found:", text);
    process.exit(1);
  }

  const results = JSON.parse(match[0]);
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
