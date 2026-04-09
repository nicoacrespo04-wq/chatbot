/**
 * Store Location Enrichment — V1 + V2
 * Correr desde la carpeta desktop-app:
 *
 *   npm install          (solo la primera vez)
 *   npm run v1           → solo ubicaciones
 *   npm run v2           → ubicaciones + presencia Adidas/Puma
 *   npm run sample       → prueba con 15 tiendas
 *
 * Output: data/enriched-stores.csv
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Carga .env del mismo directorio
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
    if (match) process.env[match[1]] ??= match[2].trim();
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const IS_V2 = process.argv.includes("--v2");
const BATCH_SIZE = 50;
const V2_BATCH_SIZE = 60;
const DELAY_MS = 500;

const INPUT_CSV  = path.join(__dirname, "data", "looker-stores.csv");
const OUTPUT_CSV = path.join(__dirname, "data", "enriched-stores.csv");

// ─── Types ────────────────────────────────────────────────────────────────────
interface StoreInput { sucursal: string; canal: string; cliente: string }

interface StoreLocation {
  sucursal: string;
  pais: string;
  ciudad: string | null;
  localidad: string | null;
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

// ─── CSV ──────────────────────────────────────────────────────────────────────
function parseCSV(filePath: string): StoreInput[] {
  const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
  return lines.slice(1).map((line) => {
    const parts = line.match(/("(?:[^"]|"")*"|[^,]+)(?:,|$)/g) ?? [];
    const c = parts.map((p) => p.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"').trim());
    return { sucursal: c[0] ?? "", canal: c[1] ?? "", cliente: c[2] ?? "" };
  });
}

function writeCSV(filePath: string, rows: Record<string, string | boolean | null>[]): void {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const esc = (v: string | boolean | null) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))];
  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
}

// ─── Claude ───────────────────────────────────────────────────────────────────
async function claudeCall(system: string, user: string, maxTokens = 8192): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY!,
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
  if (!match) throw new Error(`No JSON en respuesta: ${text.slice(0, 200)}`);
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
- sucursal: nombre exacto (sin modificar)
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
MAQ. SAVIO → Escobar | GRAND BOURG / GRANG BOURG → Malvinas Argentinas
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

// ─── Phase 2: Verificación Adidas/Puma con Claude ─────────────────────────────
const V2_SYSTEM = `Eres un experto en presencia retail de marcas deportivas en Argentina y Uruguay.
Verificás si Adidas y Puma tienen tiendas PROPIAS (monobrand/oficiales) en las ubicaciones indicadas.

Se te pasa un array con campo "tipo":
- "shopping": ¿hay tienda propia dentro de ese shopping center?
- "localidad": ¿hay tienda propia en esa localidad/barrio?
- "ciudad": ¿hay tienda propia en esa ciudad/municipio?

Solo contás tiendas oficiales (Adidas Store, Puma Store, Adidas Originals, etc.).
NO contás multimarcas que venden la marca (Solo Deportes, Sportline, etc.).

Devuelve array JSON con los mismos "key":
[{ "key": "...", "adidas": true/false, "puma": true/false }, ...]

Basate en tu conocimiento real. Si no estás seguro → false.
Devuelve SOLO el array JSON, sin markdown.`;

interface LocationQuery { key: string; tipo: "shopping" | "localidad" | "ciudad"; nombre: string; ciudad?: string; pais: string }
interface BrandPresence { key: string; adidas: boolean; puma: boolean }

const presenceCache = new Map<string, { adidas: boolean; puma: boolean }>();

async function checkPresenceBatch(queries: LocationQuery[]): Promise<void> {
  const needed = queries.filter((q) => !presenceCache.has(q.key));
  if (!needed.length) return;
  const text = await claudeCall(V2_SYSTEM, `Verificá estas ${needed.length} ubicaciones:\n${JSON.stringify(needed, null, 2)}`, 4096);
  for (const r of extractJSON<BrandPresence[]>(text)) {
    presenceCache.set(r.key, { adidas: r.adidas, puma: r.puma });
  }
}

function buildLocationQueries(locations: StoreLocation[]): LocationQuery[] {
  const seen = new Set<string>();
  const queries: LocationQuery[] = [];
  for (const loc of locations) {
    if (loc.es_digital || loc.es_deposito) continue;
    const ciudad = loc.ciudad ?? "";
    if (loc.shopping && ciudad) {
      const key = `shopping:${loc.shopping}`;
      if (!seen.has(key)) { seen.add(key); queries.push({ key, tipo: "shopping", nombre: loc.shopping, ciudad, pais: loc.pais }); }
    }
    if (loc.localidad && ciudad && loc.localidad !== loc.ciudad) {
      const key = `localidad:${loc.localidad}:${ciudad}`;
      if (!seen.has(key)) { seen.add(key); queries.push({ key, tipo: "localidad", nombre: loc.localidad, ciudad, pais: loc.pais }); }
    }
    if (loc.ciudad) {
      const key = `ciudad:${loc.ciudad}:${loc.pais}`;
      if (!seen.has(key)) { seen.add(key); queries.push({ key, tipo: "ciudad", nombre: loc.ciudad, pais: loc.pais }); }
    }
  }
  return queries;
}

function getFlags(loc: StoreLocation): CompetitorFlags {
  if (loc.es_digital || loc.es_deposito) return { ADI_shopping: null, ADI_localidad: null, ADI_ciudad: null, PUM_shopping: null, PUM_localidad: null, PUM_ciudad: null };
  const ciudad = loc.ciudad ?? "";
  const shoppingRes = loc.shopping && ciudad ? presenceCache.get(`shopping:${loc.shopping}`) : undefined;
  const localidadKey = loc.localidad && ciudad
    ? (loc.localidad === loc.ciudad ? `ciudad:${loc.ciudad}:${loc.pais}` : `localidad:${loc.localidad}:${ciudad}`)
    : undefined;
  const localidadRes = localidadKey ? presenceCache.get(localidadKey) : undefined;
  const ciudadRes = loc.ciudad ? presenceCache.get(`ciudad:${loc.ciudad}:${loc.pais}`) : undefined;
  return {
    ADI_shopping:  loc.shopping  ? (shoppingRes?.adidas  ?? null) : null,
    ADI_localidad: loc.localidad ? (localidadRes?.adidas ?? null) : null,
    ADI_ciudad:    loc.ciudad    ? (ciudadRes?.adidas    ?? null) : null,
    PUM_shopping:  loc.shopping  ? (shoppingRes?.puma    ?? null) : null,
    PUM_localidad: loc.localidad ? (localidadRes?.puma   ?? null) : null,
    PUM_ciudad:    loc.ciudad    ? (ciudadRes?.puma      ?? null) : null,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!ANTHROPIC_API_KEY) {
    console.error("\nERROR: No se encontró ANTHROPIC_API_KEY en el archivo .env\n");
    process.exit(1);
  }
  console.log(`\n=== Store Enricher ===`);
  console.log(`Modo: V${IS_V2 ? "2 (ubicación + Adidas/Puma)" : "1 (solo ubicación)"}`);
  console.log(`Input:  ${INPUT_CSV}`);
  console.log(`Output: ${OUTPUT_CSV}\n`);

  const stores = parseCSV(INPUT_CSV);
  console.log(`${stores.length} tiendas cargadas.\n`);

  const metaMap = new Map<string, { canal: string; cliente: string }>();
  for (const s of stores) metaMap.set(s.sucursal, { canal: s.canal, cliente: s.cliente });

  const batches: StoreInput[][] = [];
  for (let i = 0; i < stores.length; i += BATCH_SIZE) batches.push(stores.slice(i, i + BATCH_SIZE));

  const fallback = (s: StoreInput): StoreLocation => ({
    sucursal: s.sucursal, pais: "AR", ciudad: null, localidad: null,
    provincia: null, codigo_postal: null, shopping: null, es_digital: false, es_deposito: false,
  });

  // ── Phase 1 ──────────────────────────────────────────────────────────────────
  console.log(`── Fase 1: Enriquecimiento de ubicación (${batches.length} batches) ──`);
  const allLocations: StoreLocation[] = [];

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    process.stdout.write(`  Batch ${b + 1}/${batches.length} (${batch.length} tiendas)... `);
    try {
      const locs = await enrichBatch(batch);
      const returned = new Set(locs.map((l) => l.sucursal));
      for (const s of batch) if (!returned.has(s.sucursal)) locs.push(fallback(s));
      allLocations.push(...locs);
      console.log("✓");
    } catch (err) {
      console.log(`ERROR: ${err}`);
      allLocations.push(...batch.map(fallback));
    }
    if (b < batches.length - 1) await sleep(DELAY_MS);
  }
  console.log(`  → ${allLocations.length} tiendas procesadas.\n`);

  // ── Phase 2 ──────────────────────────────────────────────────────────────────
  if (IS_V2) {
    const queries = buildLocationQueries(allLocations);
    const v2Batches: LocationQuery[][] = [];
    for (let i = 0; i < queries.length; i += V2_BATCH_SIZE) v2Batches.push(queries.slice(i, i + V2_BATCH_SIZE));

    console.log(`── Fase 2: Verificación Adidas/Puma (${queries.length} ubicaciones únicas, ${v2Batches.length} batches) ──`);
    for (let b = 0; b < v2Batches.length; b++) {
      process.stdout.write(`  Batch ${b + 1}/${v2Batches.length} (${v2Batches[b].length} ubicaciones)... `);
      try { await checkPresenceBatch(v2Batches[b]); console.log("✓"); }
      catch (err) { console.log(`ERROR: ${err}`); }
      if (b < v2Batches.length - 1) await sleep(DELAY_MS);
    }
    console.log(`  → ${presenceCache.size} ubicaciones verificadas.\n`);
  }

  // ── Output ───────────────────────────────────────────────────────────────────
  const rows: Record<string, string | boolean | null>[] = [];
  for (const loc of allLocations) {
    const meta = metaMap.get(loc.sucursal) ?? { canal: "", cliente: "" };
    const row: Record<string, string | boolean | null> = {
      sucursal: loc.sucursal, canal: meta.canal, cliente: meta.cliente,
      pais: loc.pais, ciudad: loc.ciudad, localidad: loc.localidad,
      provincia: loc.provincia, codigo_postal: loc.codigo_postal,
      shopping: loc.shopping, es_digital: loc.es_digital, es_deposito: loc.es_deposito,
    };
    if (IS_V2) Object.assign(row, getFlags(loc));
    rows.push(row);
  }

  writeCSV(OUTPUT_CSV, rows);

  const physical = rows.filter((r) => !r.es_digital && !r.es_deposito);
  console.log(`── Resultado ─────────────────────────────────`);
  console.log(`  CSV generado:   ${OUTPUT_CSV}`);
  console.log(`  Total filas:    ${rows.length}`);
  console.log(`  Físicas:        ${physical.length}`);
  console.log(`  Con ciudad:     ${physical.filter((r) => r.ciudad).length}`);
  console.log(`  Con localidad:  ${physical.filter((r) => r.localidad).length}`);
  console.log(`  En shopping:    ${physical.filter((r) => r.shopping).length}`);
  console.log(`  Digital:        ${rows.filter((r) => r.es_digital).length}`);
  console.log(`  Depósito:       ${rows.filter((r) => r.es_deposito).length}`);
  if (IS_V2) {
    console.log(`  ADI en ciudad:  ${rows.filter((r) => r.ADI_ciudad === true).length} tiendas`);
    console.log(`  PUM en ciudad:  ${rows.filter((r) => r.PUM_ciudad === true).length} tiendas`);
  }
  console.log(`\n¡Listo! Abrí data/enriched-stores.csv con Excel.\n`);
}

main().catch((err) => { console.error("Error fatal:", err); process.exit(1); });
