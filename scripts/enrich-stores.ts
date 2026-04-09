/**
 * Store Location Enrichment Script — V1 + V2
 *
 * V1: Reads the Looker store CSV and calls Claude AI to extract per store:
 *   pais, ciudad, localidad, provincia, codigo_postal, shopping, es_digital, es_deposito
 *
 * V2 (--v2 flag): also queries Google Maps Places API to check Adidas/Puma presence at
 *   three granularities:
 *     ADI_shopping  / PUM_shopping  → Adidas/Puma inside that specific shopping (500 m)
 *     ADI_localidad / PUM_localidad → Adidas/Puma in that localidad/barrio     (2500 m)
 *     ADI_ciudad    / PUM_ciudad    → Adidas/Puma in that city/municipio       (8000 m)
 *   null = not applicable (digital/deposito/location unknown)
 *
 * Usage:
 *   npx tsx scripts/enrich-stores.ts          # V1 only
 *   npx tsx scripts/enrich-stores.ts --v2     # V1 + V2 competitor check
 *
 * Keys are loaded from .env.local in the project root.
 * Output: scripts/data/enriched-stores.csv
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Load .env.local ─────────────────────────────────────────────────────────

const envPath = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (match) process.env[match[1]] ??= match[2].trim();
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const IS_V2 = process.argv.includes("--v2");
const BATCH_SIZE = 50;
const DELAY_MS = 500;

// Search radii for competitor check
const RADIUS_SHOPPING = 500;    // just the mall building
const RADIUS_LOCALIDAD = 2500;  // neighborhood / localidad scale
const RADIUS_CIUDAD = 8000;     // full city / municipio scale

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
  pais: string;           // "AR" | "UY"
  ciudad: string | null;  // municipio (Merlo, San Isidro, CABA, Esteban Echeverría)
  localidad: string | null; // barrio/localidad (Flores, Monte Grande, Martínez, Grand Bourg)
  provincia: string | null;
  codigo_postal: string | null;
  shopping: string | null;
  es_digital: boolean;
  es_deposito: boolean;
}

interface CompetitorFlags {
  ADI_shopping: boolean | null;
  ADI_localidad: boolean | null;
  ADI_ciudad: boolean | null;
  PUM_shopping: boolean | null;
  PUM_localidad: boolean | null;
  PUM_ciudad: boolean | null;
}

// ─── CSV Helpers ─────────────────────────────────────────────────────────────

function parseCSV(filePath: string): StoreInput[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n");
  return lines.slice(1).map((line) => {
    const parts = line.match(/("(?:[^"]|"")*"|[^,]+)(?:,|$)/g) ?? [];
    const clean = parts.map((p) =>
      p.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"').trim()
    );
    return { sucursal: clean[0] ?? "", canal: clean[1] ?? "", cliente: clean[2] ?? "" };
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
            ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(",")
    ),
  ];
  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
}

// ─── Claude AI Enrichment ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Eres un asistente experto en geografía de Argentina y Uruguay, especializado en retail deportivo.
Analizas nombres de sucursales y extraes información de ubicación con dos niveles geográficos:

• localidad: barrio o localidad específica donde está la tienda.
  - En CABA: barrio porteño (Flores, Recoleta, Belgrano, Caballito, Balvanera, Villa Crespo, Villa del Parque, Barrio Norte, Microcentro, etc.)
  - En GBA: localidad dentro del partido (Monte Grande [Esteban Echeverría], Martínez [San Isidro], Grand Bourg [Malvinas Argentinas], Lavallol [Lomas de Zamora], Maquinista Savio [Escobar], Don Torcuato [Tigre], Trujui [Moreno], etc.)
  - En ciudades del interior: puede coincidir con ciudad (ej: localidad "Mendoza" en ciudad "Mendoza")
  - null si no se puede determinar

• ciudad: municipio o ciudad principal.
  - CABA siempre es "Buenos Aires" (ciudad autónoma)
  - GBA: partido/municipio (Merlo, Moreno, San Isidro, Esteban Echeverría, Lomas de Zamora, La Matanza, Tigre, etc.)
  - Interior: ciudad cabecera (Mendoza, Córdoba, Rosario, Tucumán, Salta, etc.)
  - null si no se puede determinar

Devuelve un array JSON. Cada objeto tiene:
- sucursal: nombre exacto recibido (sin modificar)
- pais: "AR" o "UY"
- ciudad: municipio (ver arriba)
- localidad: barrio/localidad (ver arriba). Puede ser igual a ciudad cuando coinciden.
- provincia: provincia o departamento
- codigo_postal: CP aproximado si es inferible, sino null
- shopping: nombre del shopping si la tienda está dentro de uno, sino null
- es_digital: true si contiene DIGITAL, MELI, MERCADOLIBRE, WEB, "On Line", .com
- es_deposito: true si contiene DEPOSITO, Transito, Planta, Almacen

SHOPPINGS CONOCIDOS (nombre → shopping / localidad / ciudad):
ABASTO → Abasto Shopping / Balvanera / Buenos Aires
UNICENTER → Unicenter / Martínez / San Isidro
ALTO PALERMO → Alto Palermo Shopping / Palermo / Buenos Aires
PASEO ALCORTA → Paseo Alcorta / Palermo / Buenos Aires
GALERIAS PACIFICO → Galerías Pacífico / Retiro / Buenos Aires
DOT → DOT Baires Shopping / Saavedra / Buenos Aires
DEVOTO SHOPPING → Devoto Shopping / Villa del Parque / Buenos Aires
ALTO AVELLANEDA → Alto Avellaneda Shopping / Avellaneda / Avellaneda
SOLEIL → Shopping Soleil / Don Torcuato / Tigre
TOM → Tortugas Open Mall / Nordelta / Tigre
PALMAS DEL PILAR → Palmas del Pilar / Pilar / Pilar
PLAZA OESTE → Shopping Plaza Oeste / Merlo / Merlo
SAN JUSTO SHOPPING / FORLEDEN SAN JUSTO → Shopping San Justo / San Justo / La Matanza
ALTO ROSARIO → Alto Rosario Shopping / Rosario / Rosario
PORTAL ROSARIO → Portal Rosario / Rosario / Rosario
SHOPPING DEL SIGLO → Shopping del Siglo / Rosario / Rosario
NUEVO CENTRO (Córdoba) → Shopping Nuevo Centro / Córdoba / Córdoba
PATIO OLMOS → Patio Olmos / Córdoba / Córdoba
PORTAL TUCUMAN → Portal Tucumán / Tucumán / Tucumán
PORTAL SALTA → Portal de Salta / Salta / Salta
PORTAL SANTIAGO → Portal Santiago del Estero / Santiago del Estero / Santiago del Estero
PORTAL NEUQUEN / IRSA NEUQUEN → Portal de Neuquén / Neuquén / Neuquén
MENDOZA PLAZA → Mendoza Plaza Shopping / Mendoza / Mendoza
PALMARES → Palmares Open Mall / Mendoza / Mendoza
SAN LUIS SHOPPING → Shopping de San Luis / San Luis / San Luis
PUNTA SHOPPING → Punta Shopping / Punta del Este / Punta del Este (UY)
ATLANTICO SHOPPING → Atlántico Shopping / Montevideo / Montevideo (UY)
MONTEVIDEO SHOPPING → Montevideo Shopping / Montevideo / Montevideo (UY)
PORTONES → Portones Shopping / Montevideo / Montevideo (UY)
PUNTA CARRETAS → Punta Carretas Shopping / Montevideo / Montevideo (UY)
TRES CRUCES → Shopping Tres Cruces / Montevideo / Montevideo (UY)

LOCALIDADES GBA clave:
MAQ. SAVIO = Maquinista Savio → ciudad: Escobar
GRAND BOURG / GRANG BOURG → ciudad: Malvinas Argentinas
TORTUGUITAS → ciudad: Malvinas Argentinas
BENAVIDEZ → ciudad: Tigre
GARIN → ciudad: Escobar
PTE. DERQUI → ciudad: Pilar
VILLA LUZURIAGA → ciudad: La Matanza
VIRREYES → ciudad: San Fernando
LAFERRERE → ciudad: La Matanza
TRUJUI → ciudad: Moreno
MARIANO ACOSTA → ciudad: Moreno
MONTE GRANDE → ciudad: Esteban Echeverría
LAVALLOL → ciudad: Lomas de Zamora
WILLIAM MORRIS → ciudad: Hurlingham
PADUA → ciudad: Merlo
CASTELAR → ciudad: Morón

REGLAS:
- MELI / MERCADOLIBRE / "On Line" → es_digital: true, ciudad: null, localidad: null, shopping: null
- Cadenas UY: MACRI, KICKS, LA CANCHA, Jerome, NVS Tres Cruces, Nike.com UY, Sportline Atlántico/Punta Shopping → pais: "UY"
- Tiendas con número de sucursal sin nombre de ciudad (ej: "All Sports 12", "Rossetti Deportes 17") → ciudad: null, localidad: null
- Cuando localidad y ciudad son el mismo lugar (ej: tienda en el centro de Mendoza) → ambos campos con el mismo valor

Devuelve SOLO el array JSON, sin markdown, sin explicaciones.`;

async function enrichBatch(stores: StoreInput[]): Promise<StoreLocation[]> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const userMessage = `Analiza estas ${stores.length} tiendas y devuelve el array JSON:\n\n${
    stores.map((s, i) => `${i + 1}. ${s.sucursal}`).join("\n")
  }`;

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

  const data = (await response.json()) as { content: Array<{ type: string; text: string }> };
  const text = data.content.find((c) => c.type === "text")?.text ?? "";
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error(`No JSON in response: ${text.slice(0, 300)}`);
  return JSON.parse(jsonMatch[0]) as StoreLocation[];
}

// ─── Google Maps V2 ──────────────────────────────────────────────────────────

interface Coords { lat: number; lng: number }

// Cache geocoding results to avoid duplicate API calls
const geocodeCache = new Map<string, Coords | null>();

async function geocode(query: string): Promise<Coords | null> {
  if (geocodeCache.has(query)) return geocodeCache.get(query)!;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = (await res.json()) as {
    status: string;
    results: Array<{ geometry: { location: Coords } }>;
  };
  const result = data.status === "OK" && data.results.length
    ? data.results[0].geometry.location
    : null;
  geocodeCache.set(query, result);
  return result;
}

async function hasBrandNearby(lat: number, lng: number, brand: string, radius: number): Promise<boolean> {
  const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&keyword=${encodeURIComponent(brand + " tienda")}&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = (await res.json()) as { status: string; results: unknown[] };
  return data.status === "OK" && data.results.length > 0;
}

async function checkBrandAtCoords(coords: Coords | null, radius: number): Promise<{ adidas: boolean | null; puma: boolean | null }> {
  if (!coords) return { adidas: null, puma: null };
  const [adidas, puma] = await Promise.all([
    hasBrandNearby(coords.lat, coords.lng, "Adidas", radius),
    hasBrandNearby(coords.lat, coords.lng, "Puma", radius),
  ]);
  return { adidas, puma };
}

async function checkCompetitors(loc: StoreLocation): Promise<CompetitorFlags> {
  const nullFlags: CompetitorFlags = {
    ADI_shopping: null, ADI_localidad: null, ADI_ciudad: null,
    PUM_shopping: null, PUM_localidad: null, PUM_ciudad: null,
  };

  if (loc.es_digital || loc.es_deposito) return nullFlags;

  const country = loc.pais === "UY" ? "Uruguay" : "Argentina";
  const province = loc.provincia ?? country;

  // ── Shopping level (500 m) ───────────────────────────────────────────────
  let shoppingFlags = { adidas: null as boolean | null, puma: null as boolean | null };
  if (loc.shopping && loc.ciudad) {
    const shoppingCoords = await geocode(`${loc.shopping}, ${loc.ciudad}, ${province}, ${country}`);
    shoppingFlags = await checkBrandAtCoords(shoppingCoords, RADIUS_SHOPPING);
  }

  // ── Localidad level (2500 m) ─────────────────────────────────────────────
  let localidadFlags = { adidas: null as boolean | null, puma: null as boolean | null };
  if (loc.localidad && loc.ciudad) {
    // If localidad === ciudad, we'll reuse ciudad result (skip separate geocode)
    if (loc.localidad === loc.ciudad) {
      // Will be set after ciudad computation below — placeholder
      localidadFlags = { adidas: null, puma: null }; // filled after
    } else {
      const localidadCoords = await geocode(`${loc.localidad}, ${loc.ciudad}, ${province}, ${country}`);
      localidadFlags = await checkBrandAtCoords(localidadCoords, RADIUS_LOCALIDAD);
    }
  }

  // ── Ciudad level (8000 m) ────────────────────────────────────────────────
  let ciudadFlags = { adidas: null as boolean | null, puma: null as boolean | null };
  if (loc.ciudad) {
    const ciudadCoords = await geocode(`${loc.ciudad}, ${province}, ${country}`);
    ciudadFlags = await checkBrandAtCoords(ciudadCoords, RADIUS_CIUDAD);

    // If localidad === ciudad, reuse ciudad result (avoids redundant API call)
    if (loc.localidad === loc.ciudad) {
      localidadFlags = ciudadFlags;
    }
  }

  return {
    ADI_shopping:  loc.shopping ? shoppingFlags.adidas  : null,
    ADI_localidad: loc.localidad ? localidadFlags.adidas : null,
    ADI_ciudad:    loc.ciudad    ? ciudadFlags.adidas    : null,
    PUM_shopping:  loc.shopping ? shoppingFlags.puma    : null,
    PUM_localidad: loc.localidad ? localidadFlags.puma   : null,
    PUM_ciudad:    loc.ciudad    ? ciudadFlags.puma      : null,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!ANTHROPIC_API_KEY) {
    console.error("ERROR: ANTHROPIC_API_KEY not set (check .env.local)");
    process.exit(1);
  }
  if (IS_V2 && !GOOGLE_MAPS_API_KEY) {
    console.error("ERROR: --v2 requires GOOGLE_MAPS_API_KEY in .env.local");
    process.exit(1);
  }

  console.log(`Mode: V${IS_V2 ? "2 (AI + Google Maps)" : "1 (AI only)"}`);
  console.log(`Reading: ${INPUT_CSV}`);
  const stores = parseCSV(INPUT_CSV);
  console.log(`Loaded ${stores.length} stores. Batch size: ${BATCH_SIZE}\n`);

  const metaMap = new Map<string, { canal: string; cliente: string }>();
  for (const s of stores) metaMap.set(s.sucursal, { canal: s.canal, cliente: s.cliente });

  const batches: StoreInput[][] = [];
  for (let i = 0; i < stores.length; i += BATCH_SIZE) batches.push(stores.slice(i, i + BATCH_SIZE));

  const allLocations: StoreLocation[] = [];

  // ── Phase 1: Claude AI enrichment ─────────────────────────────────────────
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    process.stdout.write(`Batch ${b + 1}/${batches.length} (${batch.length} stores) ... `);

    let locations: StoreLocation[];
    try {
      locations = await enrichBatch(batch);
      // Ensure all stores in batch are represented (Claude might skip some)
      const returned = new Set(locations.map((l) => l.sucursal));
      for (const s of batch) {
        if (!returned.has(s.sucursal)) {
          locations.push({ sucursal: s.sucursal, pais: "AR", ciudad: null, localidad: null, provincia: null, codigo_postal: null, shopping: null, es_digital: false, es_deposito: false });
        }
      }
      console.log("OK");
    } catch (err) {
      console.log(`FAILED: ${err}`);
      locations = batch.map((s) => ({ sucursal: s.sucursal, pais: "AR", ciudad: null, localidad: null, provincia: null, codigo_postal: null, shopping: null, es_digital: false, es_deposito: false }));
    }

    allLocations.push(...locations);
    if (b < batches.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\nAI enrichment done. ${allLocations.length} stores processed.`);

  // ── Phase 2: Google Maps V2 ───────────────────────────────────────────────
  const rows: Record<string, string | boolean | null>[] = [];

  for (const loc of allLocations) {
    const meta = metaMap.get(loc.sucursal) ?? { canal: "", cliente: "" };
    const base: Record<string, string | boolean | null> = {
      sucursal:      loc.sucursal,
      canal:         meta.canal,
      cliente:       meta.cliente,
      pais:          loc.pais,
      ciudad:        loc.ciudad,
      localidad:     loc.localidad,
      provincia:     loc.provincia,
      codigo_postal: loc.codigo_postal,
      shopping:      loc.shopping,
      es_digital:    loc.es_digital,
      es_deposito:   loc.es_deposito,
    };

    if (IS_V2) {
      const flags = await checkCompetitors(loc);
      Object.assign(base, flags);
      const tag = loc.shopping ? `[shopping] ` : loc.localidad ? `[${loc.localidad}] ` : "";
      console.log(`  ${loc.sucursal} → ${tag}${loc.ciudad ?? "?"} | ADI:${flags.ADI_ciudad} PUM:${flags.PUM_ciudad}`);
    }

    rows.push(base);
  }

  writeCSV(OUTPUT_CSV, rows);
  console.log(`\nWritten: ${OUTPUT_CSV}`);
  console.log(`Total rows: ${rows.length}`);

  // Stats
  const physical = rows.filter((r) => !r.es_digital && !r.es_deposito);
  console.log(`\n── Stats ──────────────────────────────────`);
  console.log(`  Total stores:      ${rows.length}`);
  console.log(`  Physical:          ${physical.length}`);
  console.log(`  With ciudad:       ${physical.filter((r) => r.ciudad).length}`);
  console.log(`  With localidad:    ${physical.filter((r) => r.localidad).length}`);
  console.log(`  In shopping:       ${physical.filter((r) => r.shopping).length}`);
  console.log(`  Digital:           ${rows.filter((r) => r.es_digital).length}`);
  console.log(`  Depósito:          ${rows.filter((r) => r.es_deposito).length}`);
  if (IS_V2) {
    console.log(`  ADI city-level:    ${rows.filter((r) => r.ADI_ciudad === true).length} stores with Adidas nearby`);
    console.log(`  PUM city-level:    ${rows.filter((r) => r.PUM_ciudad === true).length} stores with Puma nearby`);
    console.log(`  Geocode cache hits: ${geocodeCache.size} unique locations resolved`);
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
