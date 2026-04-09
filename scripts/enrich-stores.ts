/**
 * Store Location Enrichment Script — V1 + V2
 *
 * Reads the Looker store list (CSV) and uses Claude AI to extract:
 *   - ciudad, provincia, codigo_postal, shopping, pais, es_digital, es_deposito
 *
 * V2 (--v2 flag): additionally queries Google Maps Places API to check
 *   whether Adidas and Puma have a store within 1 km of each physical location.
 *
 * Usage:
 *   # V1 only
 *   ANTHROPIC_API_KEY=sk-... npx tsx scripts/enrich-stores.ts
 *
 *   # V2 (also checks Adidas/Puma on Google Maps)
 *   ANTHROPIC_API_KEY=sk-... GOOGLE_MAPS_API_KEY=AIza... npx tsx scripts/enrich-stores.ts --v2
 *
 * Output: scripts/data/enriched-stores.csv
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env file if present (simple parser, no extra deps needed)
const envPath = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match) process.env[match[1]] ??= match[2].trim();
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const IS_V2 = process.argv.includes("--v2");
const BATCH_SIZE = 50; // stores per Claude API call (~12 calls for 592 stores)
const DELAY_MS = 500;  // delay between batches (ms)

const INPUT_CSV = path.join(__dirname, "data", "looker-stores.csv");
const OUTPUT_CSV = path.join(__dirname, "data", "enriched-stores.csv");

// ─── Types ───────────────────────────────────────────────────────────────────

interface StoreInput {
  sucursal: string;
  canal: string;
  cliente: string;
}

interface StoreLocation {
  sucursal: string;
  ciudad: string | null;
  provincia: string | null;
  pais: string; // "AR" | "UY"
  codigo_postal: string | null;
  shopping: string | null; // shopping center name if inside one, else null
  es_digital: boolean;
  es_deposito: boolean;
}

interface StoreEnrichedV2 extends StoreLocation {
  tiene_adidas: boolean | null; // null = not checked / N/A
  tiene_puma: boolean | null;
}

// ─── CSV Helpers ─────────────────────────────────────────────────────────────

function parseCSV(filePath: string): StoreInput[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n");
  // Skip header row
  return lines.slice(1).map((line) => {
    // Handle quoted fields with commas inside
    const parts = line.match(/("(?:[^"]|"")*"|[^,]+)(?:,|$)/g) ?? [];
    const clean = parts.map((p) =>
      p.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"').trim()
    );
    return {
      sucursal: clean[0] ?? "",
      canal: clean[1] ?? "",
      cliente: clean[2] ?? "",
    };
  });
}

function writeCSV(filePath: string, rows: Record<string, string | boolean | null>[]): void {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(","),
    ...rows.map((row) =>
      headers
        .map((h) => {
          const v = row[h];
          if (v === null || v === undefined) return "";
          const s = String(v);
          return s.includes(",") || s.includes('"') || s.includes("\n")
            ? `"${s.replace(/"/g, '""')}"`
            : s;
        })
        .join(",")
    ),
  ];
  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
}

// ─── Claude AI Enrichment ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres un asistente experto en geografía de Argentina y Uruguay especializado en retail deportivo.
Tu tarea es analizar nombres de sucursales/tiendas y extraer información de ubicación.

Para cada tienda devuelves un JSON con estos campos:
- sucursal: el nombre exacto recibido (sin modificar)
- ciudad: ciudad donde está la tienda (ej: "Buenos Aires", "Córdoba", "Rosario", "Mendoza", "Montevideo"). null si no se puede determinar.
- provincia: provincia/departamento (ej: "Buenos Aires", "CABA", "Córdoba", "Santa Fe", "Mendoza", "Tucumán", "Salta", "Montevideo"). null si no se puede determinar.
- pais: "AR" para Argentina, "UY" para Uruguay. Por defecto "AR".
- codigo_postal: código postal aproximado si se puede inferir por ciudad/barrio conocido. null si no es posible determinarlo.
- shopping: nombre del shopping center si la tienda está dentro de uno (ej: "Abasto Shopping", "Unicenter", "Alto Palermo", "Shopping del Siglo", "Portal Rosario", "Alto Rosario Shopping", "Palmas del Pilar", "Plaza Oeste", "San Justo Shopping"). null si es tienda de calle.
- es_digital: true si es tienda online/e-commerce/marketplace (contiene DIGITAL, MELI, MERCADOLIBRE, WEB, On Line, .com).
- es_deposito: true si es depósito/almacén (contiene DEPOSITO, DEPOSIT, Transito, Planta).

Reglas importantes:
- MELI, MERCADOLIBRE = es_digital: true, ciudad: null, shopping: null
- Tiendas con "DIGITAL" o "WEB" = es_digital: true
- "DEPOSITO" o "Transito" = es_deposito: true, ciudad puede ser la ciudad del distribuidor
- Shoppings conocidos: ABASTO→Abasto Shopping/CABA, UNICENTER→Unicenter/Vicente López, ALTO PALERMO→Alto Palermo/CABA, ALTO AVELLANEDA→Alto Avellaneda/Avellaneda, ALTO ROSARIO→Alto Rosario Shopping/Rosario, PORTAL ROSARIO→Portal Rosario/Rosario, SHOPPING DEL SIGLO→Shopping del Siglo/Rosario, PALMAS DEL PILAR→Palmas del Pilar/Pilar, PLAZA OESTE→Shopping Plaza Oeste/Merlo, SAN JUSTO SHOPPING→Shopping San Justo/La Matanza, DOT→DOT Baires Shopping/CABA, TOM→Tortugas Open Mall/Tigre, DEVOTO SHOPPING→Devoto Shopping/CABA, PORTAL SALTA→Portal de Salta/Salta, PORTAL TUCUMAN→Portal Tucumán/Tucumán, PORTAL SANTIAGO→Portal Santiago del Estero, PORTAL NEUQUEN→Portal de Neuquén/Neuquén, PUNTA SHOPPING→Punta Shopping/Punta del Este UY, NUEVO CENTRO→Shopping Nuevo Centro/Córdoba, PATIO OLMOS→Patio Olmos/Córdoba, PASEO ALCORTA→Paseo Alcorta/CABA, GALERIAS PACIFICO→Galerías Pacífico/CABA, SOLEIL→Shopping Soleil/Tigre, MENDOZA PLAZA→Mendoza Plaza Shopping/Mendoza, PALMARES→Palmares Open Mall/Mendoza, SAN LUIS SHOPPING→Shopping de San Luis/San Luis, ATLANTICO SHOPPING→Atlántico Shopping/Uruguay, MONTEVIDEO SHOPPING→Montevideo Shopping/Montevideo UY, PORTONES→Portones Shopping/Montevideo UY, PUNTA CARRETAS→Punta Carretas Shopping/Montevideo UY, TRES CRUCES→Shopping Tres Cruces/Montevideo UY, SAN JUSTO (sin "Shopping")→calle en San Justo.
- Cadenas MACRI/KICKS/LA CANCHA/SPORTLINE ATLANTICO/SPORTLINE PUNTA SHOPPING → Uruguay (pais: "UY")
- Ciudades clave: MAQ. SAVIO = Maquinista Savio (Buenos Aires), GRAND BOURG/GRANG BOURG = Grand Bourg (Buenos Aires), TORTUGUITAS = Tortuguitas (Buenos Aires), BENAVIDEZ = Benavidez (Buenos Aires), GARIN = Garín (Buenos Aires), PTE. DERQUI = Presidente Derqui (Pilar).
- Para tiendas sin shopping explícito con número de sucursal (ej: "All Sports 12", "Rossetti Deportes 17"), no puedes inferir la ciudad exacta → ciudad: null, shopping: null.

Devuelve SOLO un array JSON válido, sin markdown, sin explicaciones.`;

async function enrichBatch(stores: StoreInput[]): Promise<StoreLocation[]> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const userMessage = `Analiza estas ${stores.length} tiendas y devuelve el array JSON con la ubicación de cada una:\n\n${stores.map((s, i) => `${i + 1}. ${s.sucursal}`).join("\n")}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };
  const text = data.content.find((c) => c.type === "text")?.text ?? "";

  // Extract JSON array from response (handles any accidental markdown fences)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`No JSON array found in response: ${text.slice(0, 200)}`);

  return JSON.parse(jsonMatch[0]) as StoreLocation[];
}

// ─── Google Maps V2 ──────────────────────────────────────────────────────────

interface GeocodingResult {
  lat: number;
  lng: number;
}

async function geocode(query: string): Promise<GeocodingResult | null> {
  if (!GOOGLE_MAPS_API_KEY) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = (await res.json()) as {
    status: string;
    results: Array<{ geometry: { location: { lat: number; lng: number } } }>;
  };
  if (data.status !== "OK" || !data.results.length) return null;
  return data.results[0].geometry.location;
}

async function hasBrandNearby(
  lat: number,
  lng: number,
  brand: string,
  radiusMeters = 1000
): Promise<boolean> {
  if (!GOOGLE_MAPS_API_KEY) return false;
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radiusMeters}&keyword=${encodeURIComponent(brand)}&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = (await res.json()) as {
    status: string;
    results: unknown[];
  };
  return data.status === "OK" && data.results.length > 0;
}

async function checkCompetitors(
  location: StoreLocation
): Promise<{ tiene_adidas: boolean | null; tiene_puma: boolean | null }> {
  // Skip digital/deposit stores
  if (location.es_digital || location.es_deposito || !location.ciudad) {
    return { tiene_adidas: null, tiene_puma: null };
  }

  // Build geocoding query
  const parts = [location.shopping, location.ciudad, location.provincia, location.pais === "UY" ? "Uruguay" : "Argentina"].filter(Boolean);
  const query = parts.join(", ");

  const coords = await geocode(query);
  if (!coords) return { tiene_adidas: null, tiene_puma: null };

  const [tiene_adidas, tiene_puma] = await Promise.all([
    hasBrandNearby(coords.lat, coords.lng, "Adidas"),
    hasBrandNearby(coords.lat, coords.lng, "Puma"),
  ]);

  return { tiene_adidas, tiene_puma };
}

// ─── Sleep helper ─────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!ANTHROPIC_API_KEY) {
    console.error("ERROR: Set ANTHROPIC_API_KEY environment variable.");
    process.exit(1);
  }
  if (IS_V2 && !GOOGLE_MAPS_API_KEY) {
    console.error("ERROR: --v2 requires GOOGLE_MAPS_API_KEY environment variable.");
    process.exit(1);
  }

  console.log(`Reading stores from ${INPUT_CSV}...`);
  const stores = parseCSV(INPUT_CSV);
  console.log(`Loaded ${stores.length} stores.`);

  // Build lookup map for canal/cliente by sucursal name
  const metaMap = new Map<string, { canal: string; cliente: string }>();
  for (const s of stores) metaMap.set(s.sucursal, { canal: s.canal, cliente: s.cliente });

  // Process in batches
  const batches: StoreInput[][] = [];
  for (let i = 0; i < stores.length; i += BATCH_SIZE) {
    batches.push(stores.slice(i, i + BATCH_SIZE));
  }

  const enriched: StoreEnrichedV2[] = [];

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    console.log(`\nBatch ${b + 1}/${batches.length} — ${batch.length} stores...`);

    let locations: StoreLocation[];
    try {
      locations = await enrichBatch(batch);
    } catch (err) {
      console.error(`  Batch ${b + 1} failed:`, err);
      // Fallback: emit null rows for failed batch
      locations = batch.map((s) => ({
        sucursal: s.sucursal,
        ciudad: null,
        provincia: null,
        pais: "AR",
        codigo_postal: null,
        shopping: null,
        es_digital: false,
        es_deposito: false,
      }));
    }

    for (const loc of locations) {
      const meta = metaMap.get(loc.sucursal) ?? { canal: "", cliente: "" };
      let v2: { tiene_adidas: boolean | null; tiene_puma: boolean | null } = {
        tiene_adidas: null,
        tiene_puma: null,
      };

      if (IS_V2) {
        v2 = await checkCompetitors(loc);
        console.log(
          `  ${loc.sucursal} → ${loc.ciudad ?? "?"} | adidas:${v2.tiene_adidas} puma:${v2.tiene_puma}`
        );
      } else {
        console.log(`  ${loc.sucursal} → ${loc.ciudad ?? "?"} | shopping:${loc.shopping ?? "-"}`);
      }

      enriched.push({
        ...loc,
        ...v2,
        // Re-attach original metadata (will be spread into CSV row below)
      } as StoreEnrichedV2 & { canal: string; cliente: string });
    }

    if (b < batches.length - 1) await sleep(DELAY_MS);
  }

  // Build final CSV rows with all columns in order
  const rows = enriched.map((e) => {
    const meta = metaMap.get(e.sucursal) ?? { canal: "", cliente: "" };
    const base: Record<string, string | boolean | null> = {
      sucursal: e.sucursal,
      canal: meta.canal,
      cliente: meta.cliente,
      pais: e.pais,
      ciudad: e.ciudad,
      provincia: e.provincia,
      codigo_postal: e.codigo_postal,
      shopping: e.shopping,
      es_digital: e.es_digital,
      es_deposito: e.es_deposito,
    };
    if (IS_V2) {
      base.tiene_adidas = e.tiene_adidas;
      base.tiene_puma = e.tiene_puma;
    }
    return base;
  });

  writeCSV(OUTPUT_CSV, rows);
  console.log(`\nDone! Enriched CSV written to: ${OUTPUT_CSV}`);
  console.log(`Total rows: ${rows.length}`);

  // Quick stats
  const withCity = rows.filter((r) => r.ciudad).length;
  const withShopping = rows.filter((r) => r.shopping).length;
  const digital = rows.filter((r) => r.es_digital).length;
  const deposito = rows.filter((r) => r.es_deposito).length;
  console.log(`\nStats:`);
  console.log(`  With city:     ${withCity}/${rows.length}`);
  console.log(`  In shopping:   ${withShopping}/${rows.length}`);
  console.log(`  Digital:       ${digital}`);
  console.log(`  Deposito:      ${deposito}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
