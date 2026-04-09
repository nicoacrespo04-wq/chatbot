/**
 * Store Location Enrichment Script — V1 + V2
 *
 * V1: Claude AI extrae por cada tienda:
 *   pais, ciudad, localidad, provincia, codigo_postal, shopping, es_digital, es_deposito
 *
 * V2 (--v2): Claude AI verifica si Adidas/Puma tienen tienda REAL en cada ubicación:
 *   ADI_shopping  / PUM_shopping  → ¿hay tienda en ese shopping center puntual?
 *   ADI_localidad / PUM_localidad → ¿hay tienda en esa localidad/barrio?
 *   ADI_ciudad    / PUM_ciudad    → ¿hay tienda en esa ciudad/municipio?
 *   null = no aplica (digital/depósito/ubicación desconocida)
 *
 * Todo con Claude API — no requiere Google Maps.
 *
 * Usage:
 *   npx tsx scripts/enrich-stores.ts        # V1 solo
 *   npx tsx scripts/enrich-stores.ts --v2   # V1 + V2
 *
 * Keys: ANTHROPIC_API_KEY en .env.local
 * Output: scripts/data/enriched-stores.csv
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Load .env.local ──────────────────────────────────────────────────────────
const envPath = path.join(__dirname, "..", ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (match) process.env[match[1]] ??= match[2].trim();
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const IS_V2 = process.argv.includes("--v2");
const BATCH_SIZE = 50;       // tiendas por llamada Claude (Phase 1)
const V2_BATCH_SIZE = 60;    // ubicaciones únicas por llamada Claude (Phase 2)
const DELAY_MS = 500;

const INPUT_CSV = path.join(__dirname, "data", "looker-stores.csv");
const OUTPUT_CSV = path.join(__dirname, "data", "enriched-stores.csv");

// ─── Types ────────────────────────────────────────────────────────────────────
interface StoreInput { sucursal: string; canal: string; cliente: string }

interface StoreLocation {
  sucursal: string;
  pais: string;             // "AR" | "UY"
  ciudad: string | null;    // municipio (La Matanza, San Isidro, CABA→"Buenos Aires")
  localidad: string | null; // barrio/localidad (Flores, Monte Grande, Martínez)
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

// ─── CSV Helpers ──────────────────────────────────────────────────────────────
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
  const escape = (v: string | boolean | null) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(","), ...rows.map((r) => headers.map((h) => escape(r[h])).join(","))];
  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
}

// ─── Claude helper ────────────────────────────────────────────────────────────
async function claudeCall(system: string, user: string, maxTokens = 8192): Promise<string> {
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content: Array<{ type: string; text: string }> };
  return data.content.find((c) => c.type === "text")?.text ?? "";
}

function extractJSON<T>(text: string): T {
  const match = text.match(/[\[{][\s\S]*[\]}]/);
  if (!match) throw new Error(`No JSON in: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]) as T;
}

// ─── Phase 1: Enriquecimiento de ubicación ────────────────────────────────────

const ENRICH_SYSTEM = `Eres un asistente experto en geografía de Argentina y Uruguay, especializado en retail deportivo.
Analizas nombres de sucursales y extraes información de ubicación con dos niveles:

• localidad: barrio o localidad específica.
  - CABA: barrio porteño (Flores, Recoleta, Belgrano, Caballito, Balvanera, Villa Crespo, Villa del Parque, Barrio Norte, Microcentro, Palermo, Retiro, Saavedra, etc.)
  - GBA: localidad dentro del partido (Monte Grande→Esteban Echeverría, Martínez→San Isidro, Grand Bourg→Malvinas Argentinas, Lavallol→Lomas de Zamora, Maq. Savio→Escobar, Don Torcuato→Tigre, Trujui→Moreno, etc.)
  - Interior: puede coincidir con ciudad (ej: "Mendoza" en ciudad "Mendoza")
  - null si no se puede determinar

• ciudad: municipio o ciudad principal.
  - CABA → siempre "Buenos Aires"
  - GBA: partido/municipio (Merlo, Moreno, San Isidro, Esteban Echeverría, Lomas de Zamora, La Matanza, Tigre, etc.)
  - Interior: ciudad cabecera (Mendoza, Córdoba, Rosario, Tucumán, Salta, etc.)
  - null si no se puede determinar

Devuelve array JSON. Cada objeto:
- sucursal: nombre exacto recibido (sin modificar)
- pais: "AR" o "UY"
- ciudad: municipio
- localidad: barrio/localidad (puede ser igual a ciudad)
- provincia: provincia o departamento
- codigo_postal: CP aproximado si es inferible, sino null
- shopping: nombre del shopping si está dentro de uno, sino null
- es_digital: true si contiene DIGITAL, MELI, MERCADOLIBRE, WEB, "On Line", .com
- es_deposito: true si contiene DEPOSITO, Transito, Planta, Almacen

SHOPPINGS CONOCIDOS:
ABASTO → Abasto Shopping | Balvanera | Buenos Aires
UNICENTER → Unicenter | Martínez | San Isidro
ALTO PALERMO → Alto Palermo Shopping | Palermo | Buenos Aires
PASEO ALCORTA → Paseo Alcorta | Palermo | Buenos Aires
GALERIAS PACIFICO → Galerías Pacífico | Retiro | Buenos Aires
DOT → DOT Baires Shopping | Saavedra | Buenos Aires
DEVOTO SHOPPING → Devoto Shopping | Villa del Parque | Buenos Aires
ALTO AVELLANEDA → Alto Avellaneda Shopping | Avellaneda | Avellaneda
SOLEIL → Shopping Soleil | Don Torcuato | Tigre
TOM → Tortugas Open Mall | Nordelta | Tigre
PALMAS DEL PILAR → Palmas del Pilar | Pilar | Pilar
PLAZA OESTE → Shopping Plaza Oeste | Merlo | Merlo
SAN JUSTO SHOPPING / FORLEDEN SAN JUSTO → Shopping San Justo | San Justo | La Matanza
ALTO ROSARIO → Alto Rosario Shopping | Rosario | Rosario
PORTAL ROSARIO → Portal Rosario | Rosario | Rosario
SHOPPING DEL SIGLO → Shopping del Siglo | Rosario | Rosario
NUEVO CENTRO (Córdoba) → Shopping Nuevo Centro | Córdoba | Córdoba
PATIO OLMOS → Patio Olmos | Córdoba | Córdoba
PORTAL TUCUMAN → Portal Tucumán | Tucumán | Tucumán
PORTAL SALTA → Portal de Salta | Salta | Salta
PORTAL SANTIAGO → Portal Santiago del Estero | Santiago del Estero | Santiago del Estero
PORTAL NEUQUEN / IRSA NEUQUEN → Portal de Neuquén | Neuquén | Neuquén
MENDOZA PLAZA → Mendoza Plaza Shopping | Mendoza | Mendoza
PALMARES → Palmares Open Mall | Mendoza | Mendoza
SAN LUIS SHOPPING → Shopping de San Luis | San Luis | San Luis
PUNTA SHOPPING → Punta Shopping | Punta del Este | Punta del Este (UY)
ATLANTICO SHOPPING → Atlántico Shopping | Montevideo | Montevideo (UY)
MONTEVIDEO SHOPPING → Montevideo Shopping | Montevideo | Montevideo (UY)
PORTONES → Portones Shopping | Montevideo | Montevideo (UY)
PUNTA CARRETAS → Punta Carretas Shopping | Montevideo | Montevideo (UY)
TRES CRUCES → Shopping Tres Cruces | Montevideo | Montevideo (UY)

LOCALIDADES GBA:
MAQ. SAVIO = Maquinista Savio → Escobar | GRAND BOURG / GRANG BOURG → Malvinas Argentinas
TORTUGUITAS → Malvinas Argentinas | BENAVIDEZ → Tigre | GARIN → Escobar
PTE. DERQUI → Pilar | VILLA LUZURIAGA → La Matanza | VIRREYES → San Fernando
LAFERRERE → La Matanza | TRUJUI → Moreno | MARIANO ACOSTA → Moreno
MONTE GRANDE → Esteban Echeverría | LAVALLOL → Lomas de Zamora
WILLIAM MORRIS → Hurlingham | PADUA → Merlo | CASTELAR → Morón

REGLAS:
- MELI / MERCADOLIBRE / "On Line" → es_digital:true, ciudad:null, localidad:null, shopping:null
- Cadenas UY: MACRI, KICKS, LA CANCHA, Jerome, NVS Tres Cruces, Nike.com UY, Sportline Atlántico/Punta → pais:"UY"
- Tiendas con número sin ciudad (ej: "All Sports 12", "Rossetti Deportes 17") → ciudad:null, localidad:null
- localidad igual a ciudad cuando coinciden (interior sin barrio específico)

Devuelve SOLO el array JSON, sin markdown.`;

async function enrichBatch(stores: StoreInput[]): Promise<StoreLocation[]> {
  const text = await claudeCall(
    ENRICH_SYSTEM,
    `Analiza estas ${stores.length} tiendas:\n\n${stores.map((s, i) => `${i + 1}. ${s.sucursal}`).join("\n")}`
  );
  return extractJSON<StoreLocation[]>(text);
}

// ─── Phase 2: Verificación de Adidas/Puma con Claude ─────────────────────────

const V2_SYSTEM = `Eres un experto en presencia retail de marcas deportivas en Argentina y Uruguay.
Tu tarea es verificar si Adidas y Puma tienen tiendas PROPIAS (monobrand, locales de la marca) en las ubicaciones indicadas.

Se te pasa un array de ubicaciones con un campo "tipo":
- "shopping": ¿hay una tienda propia de Adidas/Puma DENTRO de ese shopping center?
- "localidad": ¿hay una tienda propia de Adidas/Puma en esa localidad/barrio?
- "ciudad": ¿hay una tienda propia de Adidas/Puma en esa ciudad/municipio?

Responde SOLO tiendas propias (monobrand). NO cuentes:
- Multimarcas que venden esa marca (Solo Deportes, Sportline, etc.)
- Outlets o tiendas de terceros
- Solo las tiendas oficiales de la marca (Adidas Store, Puma Store, Adidas Originals, etc.)

Devuelve un array JSON con exactamente los mismos "key" recibidos:
[{ "key": "...", "adidas": true/false, "puma": true/false }, ...]

Basate en tu conocimiento real de la presencia retail de estas marcas. Si no estás seguro, pon false.
Devuelve SOLO el array JSON, sin markdown.`;

interface LocationQuery {
  key: string;
  tipo: "shopping" | "localidad" | "ciudad";
  nombre: string;
  ciudad?: string;
  pais: string;
}

interface BrandPresence { key: string; adidas: boolean; puma: boolean }

// Cache: evita llamar Claude dos veces por la misma ubicación
const presenceCache = new Map<string, { adidas: boolean; puma: boolean }>();

async function checkPresenceBatch(queries: LocationQuery[]): Promise<void> {
  // Filter out already-cached
  const needed = queries.filter((q) => !presenceCache.has(q.key));
  if (needed.length === 0) return;

  const text = await claudeCall(
    V2_SYSTEM,
    `Verificá la presencia de Adidas y Puma en estas ${needed.length} ubicaciones:\n${JSON.stringify(needed, null, 2)}`,
    4096
  );

  const results = extractJSON<BrandPresence[]>(text);
  for (const r of results) {
    presenceCache.set(r.key, { adidas: r.adidas, puma: r.puma });
  }
}

function buildLocationQueries(locations: StoreLocation[]): LocationQuery[] {
  const seen = new Set<string>();
  const queries: LocationQuery[] = [];

  for (const loc of locations) {
    if (loc.es_digital || loc.es_deposito) continue;
    const pais = loc.pais;
    const ciudad = loc.ciudad ?? "";

    if (loc.shopping && ciudad) {
      const key = `shopping:${loc.shopping}`;
      if (!seen.has(key)) {
        seen.add(key);
        queries.push({ key, tipo: "shopping", nombre: loc.shopping, ciudad, pais });
      }
    }
    if (loc.localidad && ciudad && loc.localidad !== loc.ciudad) {
      const key = `localidad:${loc.localidad}:${ciudad}`;
      if (!seen.has(key)) {
        seen.add(key);
        queries.push({ key, tipo: "localidad", nombre: loc.localidad, ciudad, pais });
      }
    }
    if (loc.ciudad) {
      const key = `ciudad:${loc.ciudad}:${pais}`;
      if (!seen.has(key)) {
        seen.add(key);
        queries.push({ key, tipo: "ciudad", nombre: loc.ciudad, pais });
      }
    }
  }
  return queries;
}

function getFlags(loc: StoreLocation): CompetitorFlags {
  const nullFlags: CompetitorFlags = {
    ADI_shopping: null, ADI_localidad: null, ADI_ciudad: null,
    PUM_shopping: null, PUM_localidad: null, PUM_ciudad: null,
  };
  if (loc.es_digital || loc.es_deposito) return nullFlags;

  const ciudad = loc.ciudad ?? "";

  const shoppingResult = loc.shopping && ciudad
    ? presenceCache.get(`shopping:${loc.shopping}`) : undefined;

  // If localidad === ciudad, they share the same cache entry
  const localidadKey = loc.localidad && ciudad
    ? (loc.localidad === loc.ciudad
        ? `ciudad:${loc.ciudad}:${loc.pais}`
        : `localidad:${loc.localidad}:${ciudad}`)
    : undefined;
  const localidadResult = localidadKey ? presenceCache.get(localidadKey) : undefined;

  const ciudadResult = loc.ciudad
    ? presenceCache.get(`ciudad:${loc.ciudad}:${loc.pais}`) : undefined;

  return {
    ADI_shopping:  loc.shopping    ? (shoppingResult?.adidas  ?? null) : null,
    ADI_localidad: loc.localidad   ? (localidadResult?.adidas ?? null) : null,
    ADI_ciudad:    loc.ciudad      ? (ciudadResult?.adidas    ?? null) : null,
    PUM_shopping:  loc.shopping    ? (shoppingResult?.puma    ?? null) : null,
    PUM_localidad: loc.localidad   ? (localidadResult?.puma   ?? null) : null,
    PUM_ciudad:    loc.ciudad      ? (ciudadResult?.puma      ?? null) : null,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!ANTHROPIC_API_KEY) {
    console.error("ERROR: ANTHROPIC_API_KEY no encontrada (revisá .env.local)");
    process.exit(1);
  }

  console.log(`Modo: V${IS_V2 ? "2 — Claude AI (ubicación + presencia Adidas/Puma)" : "1 — Claude AI (ubicación)"}`);
  console.log(`Input: ${INPUT_CSV}\n`);

  const stores = parseCSV(INPUT_CSV);
  console.log(`${stores.length} tiendas cargadas. Batch size: ${BATCH_SIZE}`);

  const metaMap = new Map<string, { canal: string; cliente: string }>();
  for (const s of stores) metaMap.set(s.sucursal, { canal: s.canal, cliente: s.cliente });

  const batches: StoreInput[][] = [];
  for (let i = 0; i < stores.length; i += BATCH_SIZE) batches.push(stores.slice(i, i + BATCH_SIZE));

  // ── Phase 1: Claude enriquece ubicaciones ───────────────────────────────────
  console.log(`\n── Phase 1: Enriquecimiento de ubicación (${batches.length} batches) ──`);
  const allLocations: StoreLocation[] = [];
  const fallback = (s: StoreInput): StoreLocation => ({
    sucursal: s.sucursal, pais: "AR", ciudad: null, localidad: null,
    provincia: null, codigo_postal: null, shopping: null, es_digital: false, es_deposito: false,
  });

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    process.stdout.write(`  Batch ${b + 1}/${batches.length} (${batch.length} tiendas)... `);
    try {
      const locs = await enrichBatch(batch);
      const returned = new Set(locs.map((l) => l.sucursal));
      for (const s of batch) if (!returned.has(s.sucursal)) locs.push(fallback(s));
      allLocations.push(...locs);
      console.log("OK");
    } catch (err) {
      console.log(`ERROR: ${err}`);
      allLocations.push(...batch.map(fallback));
    }
    if (b < batches.length - 1) await sleep(DELAY_MS);
  }
  console.log(`  → ${allLocations.length} tiendas procesadas.`);

  // ── Phase 2: Claude verifica Adidas/Puma por ubicación única ───────────────
  if (IS_V2) {
    const queries = buildLocationQueries(allLocations);
    console.log(`\n── Phase 2: Verificación Adidas/Puma (${queries.length} ubicaciones únicas) ──`);

    const v2Batches: LocationQuery[][] = [];
    for (let i = 0; i < queries.length; i += V2_BATCH_SIZE) v2Batches.push(queries.slice(i, i + V2_BATCH_SIZE));

    for (let b = 0; b < v2Batches.length; b++) {
      process.stdout.write(`  Batch ${b + 1}/${v2Batches.length} (${v2Batches[b].length} ubicaciones)... `);
      try {
        await checkPresenceBatch(v2Batches[b]);
        console.log("OK");
      } catch (err) {
        console.log(`ERROR: ${err}`);
      }
      if (b < v2Batches.length - 1) await sleep(DELAY_MS);
    }
    console.log(`  → ${presenceCache.size} ubicaciones verificadas.`);
  }

  // ── Build output rows ────────────────────────────────────────────────────────
  const rows: Record<string, string | boolean | null>[] = [];
  for (const loc of allLocations) {
    const meta = metaMap.get(loc.sucursal) ?? { canal: "", cliente: "" };
    const row: Record<string, string | boolean | null> = {
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
    if (IS_V2) Object.assign(row, getFlags(loc));
    rows.push(row);
  }

  writeCSV(OUTPUT_CSV, rows);

  // ── Stats ────────────────────────────────────────────────────────────────────
  const physical = rows.filter((r) => !r.es_digital && !r.es_deposito);
  console.log(`\n── Resultado ────────────────────────────────`);
  console.log(`  Output: ${OUTPUT_CSV}`);
  console.log(`  Total:          ${rows.length}`);
  console.log(`  Físicas:        ${physical.length}`);
  console.log(`  Con ciudad:     ${physical.filter((r) => r.ciudad).length}`);
  console.log(`  Con localidad:  ${physical.filter((r) => r.localidad).length}`);
  console.log(`  En shopping:    ${physical.filter((r) => r.shopping).length}`);
  console.log(`  Digital:        ${rows.filter((r) => r.es_digital).length}`);
  console.log(`  Depósito:       ${rows.filter((r) => r.es_deposito).length}`);
  if (IS_V2) {
    console.log(`  ADI en ciudad:  ${rows.filter((r) => r.ADI_ciudad === true).length} tiendas con Adidas en esa ciudad`);
    console.log(`  PUM en ciudad:  ${rows.filter((r) => r.PUM_ciudad === true).length} tiendas con Puma en esa ciudad`);
    console.log(`  ADI en shopping:${rows.filter((r) => r.ADI_shopping === true).length} tiendas con Adidas en ese shopping`);
    console.log(`  PUM en shopping:${rows.filter((r) => r.PUM_shopping === true).length} tiendas con Puma en ese shopping`);
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
