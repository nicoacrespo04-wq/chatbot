/**
 * Prueba rápida — verifica 15 tiendas de muestra antes de correr todo.
 * npm run sample
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (match) process.env[match[1]] ??= match[2].trim();
  }
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SAMPLE = [
  "GRID ABASTO",
  "GRID UNICENTER",
  "NSO ALTO PALERMO",
  "BLAST ALTO ROSARIO",
  "DASH(AMI) MENDOZA - A26",
  "SOLO DEPORTES FLORES 1",
  "SOLO DEPORTES BELGRANO",
  "SC MONTE GRANDE 174",
  "SPORTLINE DEVOTO SHOPPING",
  "SPORTING PALMARES (57)",
  "DX DIGITAL",
  "DEPOSITO CENTRAL DASH",
  "MACRI SPORT CENTER Punta del Este -06",
  "LA CANCHA MONTEVIDEO SHOPPING",
  "NBA MARTINEZ - N01",
];

async function main() {
  if (!ANTHROPIC_API_KEY) { console.error("Falta ANTHROPIC_API_KEY en .env"); process.exit(1); }

  console.log(`Probando ${SAMPLE.length} tiendas de muestra...\n`);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6", max_tokens: 4096,
      system: "Eres experto en geografía de Argentina/Uruguay. Para cada tienda devuelve JSON con: sucursal, pais, ciudad, localidad, provincia, shopping, es_digital, es_deposito. Solo array JSON, sin markdown.",
      messages: [{ role: "user", content: `Analiza:\n${SAMPLE.map((s, i) => `${i + 1}. ${s}`).join("\n")}` }],
    }),
  });

  if (!res.ok) { console.error(await res.text()); process.exit(1); }
  const data = (await res.json()) as { content: Array<{ type: string; text: string }> };
  const text = data.content.find((c) => c.type === "text")?.text ?? "";
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) { console.error("Sin JSON:", text); process.exit(1); }

  const results = JSON.parse(match[0]);
  console.log(JSON.stringify(results, null, 2));
  console.log(`\n✓ ${results.length} tiendas procesadas OK`);
}

main().catch(console.error);
