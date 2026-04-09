"""
enrich-stores.py — Store Location Enricher
Usa Claude AI para extraer ubicación y verificar presencia de Adidas/Puma.
Output: CSV + Excel (si openpyxl está instalado)

Uso:
  python enrich-stores.py          # corre todo
  python enrich-stores.py --sample # prueba con 15 tiendas
"""

import csv
import json
import sys
import time
import urllib.request
from pathlib import Path

# ── Cargar .env ────────────────────────────────────────────────────────────────
_env_path = Path(__file__).parent / ".env"
if _env_path.exists():
    for _line in _env_path.read_text(encoding="utf-8").splitlines():
        _m = __import__("re").match(r'^([A-Z_][A-Z0-9_]*)=(.+)$', _line.strip())
        if _m:
            import os
            os.environ.setdefault(_m.group(1), _m.group(2).strip())

import os
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
if not ANTHROPIC_API_KEY:
    print("ERROR: Falta ANTHROPIC_API_KEY en .env"); sys.exit(1)

# ── Configuración ──────────────────────────────────────────────────────────────
SAMPLE_MODE = "--sample" in sys.argv

MODEL         = "claude-sonnet-4-6"
BATCH_SIZE    = 50   # tiendas por llamada Phase 1
V2_BATCH_SIZE = 30   # ubicaciones por llamada Phase 2
MAX_RETRIES   = 3
RETRY_DELAY   = 5

# Columnas del CSV de Looker (5 columnas)
COL_GROUP    = "Ventas Stock Ytd Semanal Banner Group"
COL_CLIENTE  = "Ventas Stock Ytd Semanal Cliente"
COL_SUCURSAL = "Ventas Stock Ytd Semanal Sucursal"
COL_PAIS     = "Ventas Stock Ytd Semanal Pais"
COL_BANNER   = "Ventas Stock Ytd Semanal Banner"

# ── Prompts ─────────────────────────────────────────────────────────────────────
ENRICH_SYSTEM = """Eres experto en geografía retail de Argentina y Uruguay.
Para cada tienda extrae: sucursal, pais (AR/UY), ciudad, localidad, provincia, shopping, es_digital, es_deposito.

DEFINICIONES:
- ciudad: municipio (Esteban Echeverría, San Isidro, CABA, Rosario, Montevideo, Malvinas Argentinas...)
- localidad: barrio o localidad dentro del municipio (Monte Grande, Martínez, Flores, Grand Bourg...)
- shopping: nombre del mall si está dentro de uno, "" si es calle
- es_digital: true solo si es tienda online/e-commerce (ej. "DX DIGITAL", "DIGITAL", "ONLINE")
- es_deposito: true solo si es depósito/almacén/bodega (ej. "DEPOSITO", "CD ", "BODEGA", "WAREHOUSE")

REGLAS GBA (Gran Buenos Aires):
- Monte Grande → ciudad: Esteban Echeverría, localidad: Monte Grande
- Grand Bourg → ciudad: Malvinas Argentinas, localidad: Grand Bourg
- Martínez → ciudad: San Isidro, localidad: Martínez
- Beccar → ciudad: San Isidro, localidad: Beccar
- Florida → ciudad: Vicente López, localidad: Florida
- Quilmes → ciudad: Quilmes, localidad: Quilmes
- Lomas de Zamora → ciudad: Lomas de Zamora, localidad: Lomas de Zamora
- Banfield → ciudad: Lomas de Zamora, localidad: Banfield
- Temperley → ciudad: Lomas de Zamora, localidad: Temperley
- Haedo → ciudad: Morón, localidad: Haedo
- Morón → ciudad: Morón, localidad: Morón
- Ramos Mejía → ciudad: La Matanza, localidad: Ramos Mejía
- San Justo → ciudad: La Matanza, localidad: San Justo
- Merlo → ciudad: Merlo, localidad: Merlo
- Moreno → ciudad: Moreno, localidad: Moreno

CABA: ciudad=CABA, localidad=barrio (Flores, Belgrano, Palermo, Recoleta, Caballito...)

Para shoppings conocidos:
- Abasto, Alto Palermo, Unicenter, Dot, Palermo, Punta Carrasco → en CABA
- Devoto Shopping → en Villa del Parque (CABA)
- Alto Rosario → Rosario, Santa Fe
- Palmares → Mendoza
- Nuevocentro → Córdoba
- Punta Carretas, Montevideo Shopping, Tres Cruces → Montevideo
- La Cancha → Montevideo

Responde SOLO con array JSON válido, sin markdown:
[{"sucursal":"...","pais":"AR","ciudad":"...","localidad":"...","provincia":"...","shopping":"...","es_digital":false,"es_deposito":false}]"""

V2_SYSTEM = """Eres experto en presencia retail de Adidas y Puma en Argentina y Uruguay.
Verificas tiendas PROPIAS monobrand/oficiales. NO incluyas multimarcas ni tiendas que venden sus productos entre otras marcas.

Para cada ubicación indica si Adidas o Puma tienen tienda propia en:
- shopping: dentro del mall específico mencionado (solo si hay shopping)
- localidad: en ese barrio/localidad
- ciudad: en ese municipio/ciudad

Responde SOLO con array JSON válido, sin markdown:
[{"key":"...","adidas":true,"puma":false}]

El campo "key" debe ser exactamente el mismo que te enviaron."""

# ── Helpers ────────────────────────────────────────────────────────────────────
def claude(system: str, user: str) -> str:
    """Llama a Claude API y devuelve el texto de respuesta."""
    body = json.dumps({
        "model": MODEL,
        "max_tokens": 4096,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }).encode()

    for attempt in range(1, MAX_RETRIES + 1):
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=body,
            headers={
                "Content-Type": "application/json",
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                data = json.loads(r.read())
                return data["content"][0]["text"]
        except Exception as e:
            print(f"  ⚠ Error Claude (intento {attempt}/{MAX_RETRIES}): {e}")
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_DELAY * attempt)
    return ""


def parse_json_array(text: str) -> list:
    """Extrae el primer array JSON de un texto."""
    m = __import__("re").search(r'\[[\s\S]*\]', text)
    if not m:
        return []
    try:
        return json.loads(m.group())
    except json.JSONDecodeError:
        return []


def find_input_csv() -> Path:
    """Busca el CSV de input, maneja extensión doble (.csv.csv de Windows)."""
    data_dir = Path(__file__).parent / "data"
    data_dir.mkdir(exist_ok=True)

    candidates = [
        data_dir / "looker-stores.csv",
        data_dir / "looker-stores.csv.csv",
        data_dir / "stores.csv",
    ]
    for c in candidates:
        if c.exists():
            return c

    # Fallback: cualquier CSV en data/
    csvs = list(data_dir.glob("*.csv"))
    if csvs:
        return sorted(csvs)[0]

    print(f"ERROR: No se encontró CSV de input en {data_dir}")
    print("Colocá el archivo como data/looker-stores.csv")
    sys.exit(1)


# ── Palabras clave para pre-clasificar ────────────────────────────────────────
DIGITAL_KW  = ["DIGITAL", "ONLINE", "E-COMMERCE", "ECOMMERCE"]
DEPOSITO_KW = ["DEPOSITO", "DEPÓSITO", "CD ", " CD-", "BODEGA", "WAREHOUSE",
                "ALMACEN", "ALMACÉN", "CENTRAL DASH", "DEPOSITO CENTRAL"]


def preclass(name: str) -> tuple[bool, bool]:
    up = name.upper()
    is_dig = any(k in up for k in DIGITAL_KW)
    is_dep = any(k in up for k in DEPOSITO_KW)
    return is_dig, is_dep


# ── Fase 1: Enriquecer ubicaciones ────────────────────────────────────────────
def enrich_batch(stores: list[dict]) -> list[dict]:
    """Llama a Claude para enriquecer una tanda de tiendas."""
    lines = "\n".join(f"{i+1}. {s['sucursal']} (país={s.get('pais_raw','?')})"
                      for i, s in enumerate(stores))
    text = claude(ENRICH_SYSTEM, f"Analiza estas tiendas:\n{lines}")
    return parse_json_array(text)


# ── Fase 2: Verificar presencia Adidas/Puma ───────────────────────────────────
presenceCache: dict[str, dict] = {}  # key → {"adidas": bool, "puma": bool}


def build_presence_keys(loc: dict) -> list[str]:
    """Genera las claves de presencia para una tienda."""
    keys = []
    ciudad    = (loc.get("ciudad")    or "").strip()
    localidad = (loc.get("localidad") or "").strip()
    shopping  = (loc.get("shopping")  or "").strip()
    pais      = (loc.get("pais")      or "AR").strip()

    if shopping:
        keys.append(f"shopping:{shopping}:{ciudad}:{pais}")
    if localidad:
        keys.append(f"localidad:{localidad}:{ciudad}:{pais}")
    if ciudad:
        keys.append(f"ciudad:{ciudad}:{pais}")
    return keys


def query_presence(keys: list[str]) -> None:
    """Consulta a Claude cuáles de las keys tienen Adidas/Puma, cachea resultados."""
    new_keys = [k for k in keys if k not in presenceCache]
    if not new_keys:
        return

    # Procesar en lotes
    for i in range(0, len(new_keys), V2_BATCH_SIZE):
        batch = new_keys[i:i + V2_BATCH_SIZE]
        items = []
        for k in batch:
            parts = k.split(":", 3)
            tipo  = parts[0]
            nombre = parts[1]
            ciudad = parts[2] if len(parts) > 2 else ""
            pais   = parts[3] if len(parts) > 3 else "AR"
            items.append(f'- key="{k}" tipo={tipo} nombre="{nombre}" ciudad="{ciudad}" pais={pais}')

        text = claude(V2_SYSTEM, "Verificá presencia Adidas/Puma en:\n" + "\n".join(items))
        results = parse_json_array(text)

        for r in results:
            k = r.get("key", "")
            if k:
                presenceCache[k] = {
                    "adidas": bool(r.get("adidas", False)),
                    "puma":   bool(r.get("puma",   False)),
                }

        # Marcar como consultadas (pueden no volver en el JSON si Claude las omite)
        for k in batch:
            presenceCache.setdefault(k, {"adidas": False, "puma": False})

        if i + V2_BATCH_SIZE < len(new_keys):
            time.sleep(1)


def get_flags(loc: dict) -> dict:
    """Devuelve las 6 columnas ADI/PUM para una tienda."""
    empty = {k: "" for k in [
        "ADI_shopping", "ADI_localidad", "ADI_ciudad",
        "PUM_shopping", "PUM_localidad", "PUM_ciudad",
    ]}

    if loc.get("es_digital") or loc.get("es_deposito"):
        return empty

    ciudad    = (loc.get("ciudad")    or "").strip()
    localidad = (loc.get("localidad") or "").strip()
    shopping  = (loc.get("shopping")  or "").strip()
    pais      = (loc.get("pais")      or "AR").strip()

    def yn(val: bool | None) -> str:
        if val is None:
            return ""
        return "SI" if val else "NO"

    k_shop = f"shopping:{shopping}:{ciudad}:{pais}"   if shopping  else None
    k_loc  = f"localidad:{localidad}:{ciudad}:{pais}" if localidad else None
    k_city = f"ciudad:{ciudad}:{pais}"                if ciudad    else None

    adi_shop = yn(presenceCache.get(k_shop, {}).get("adidas")) if k_shop else ""
    adi_loc  = yn(presenceCache.get(k_loc,  {}).get("adidas")) if k_loc  else ""
    adi_city = yn(presenceCache.get(k_city, {}).get("adidas")) if k_city else ""
    pum_shop = yn(presenceCache.get(k_shop, {}).get("puma"))   if k_shop else ""
    pum_loc  = yn(presenceCache.get(k_loc,  {}).get("puma"))   if k_loc  else ""
    pum_city = yn(presenceCache.get(k_city, {}).get("puma"))   if k_city else ""

    return {
        "ADI_shopping": adi_shop,
        "ADI_localidad": adi_loc,
        "ADI_ciudad": adi_city,
        "PUM_shopping": pum_shop,
        "PUM_localidad": pum_loc,
        "PUM_ciudad": pum_city,
    }


# ── Columnas del output ───────────────────────────────────────────────────────
OUTPUT_COLS = [
    "banner_group", "cliente", "sucursal", "pais", "banner",
    "ciudad", "localidad", "provincia", "shopping",
    "es_digital", "es_deposito",
    "ADI_shopping", "ADI_localidad", "ADI_ciudad",
    "PUM_shopping", "PUM_localidad", "PUM_ciudad",
]


# ── Excel ──────────────────────────────────────────────────────────────────────
def write_excel(rows: list[dict], path: Path) -> None:
    try:
        import openpyxl
        from openpyxl.styles import PatternFill, Font, Alignment
    except ImportError:
        print("  (openpyxl no instalado, omitiendo Excel)")
        return

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Tiendas Enriquecidas"

    # Colores de encabezado
    HEADER_COLORS = {
        "banner_group": "1F4E79", "cliente": "1F4E79", "sucursal": "1F4E79",
        "pais": "1F4E79", "banner": "1F4E79",
        "ciudad": "375623", "localidad": "375623", "provincia": "375623",
        "shopping": "375623",
        "es_digital": "7B3F00", "es_deposito": "7B3F00",
        "ADI_shopping": "7B2D8B", "ADI_localidad": "7B2D8B", "ADI_ciudad": "7B2D8B",
        "PUM_shopping": "0D47A1", "PUM_localidad": "0D47A1", "PUM_ciudad": "0D47A1",
    }

    # Escribir encabezados
    for col_idx, col_name in enumerate(OUTPUT_COLS, 1):
        cell = ws.cell(row=1, column=col_idx, value=col_name)
        hex_color = HEADER_COLORS.get(col_name, "333333")
        cell.fill = PatternFill("solid", fgColor=hex_color)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.alignment = Alignment(horizontal="center")

    # Escribir datos
    for row_idx, row in enumerate(rows, 2):
        for col_idx, col_name in enumerate(OUTPUT_COLS, 1):
            ws.cell(row=row_idx, column=col_idx, value=row.get(col_name, ""))

    # Formato
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions

    # Ancho de columnas
    col_widths = {
        "banner_group": 25, "cliente": 20, "sucursal": 35, "pais": 6, "banner": 15,
        "ciudad": 20, "localidad": 20, "provincia": 18, "shopping": 25,
        "es_digital": 12, "es_deposito": 12,
        "ADI_shopping": 14, "ADI_localidad": 14, "ADI_ciudad": 14,
        "PUM_shopping": 14, "PUM_localidad": 14, "PUM_ciudad": 14,
    }
    for col_idx, col_name in enumerate(OUTPUT_COLS, 1):
        ws.column_dimensions[
            openpyxl.utils.get_column_letter(col_idx)
        ].width = col_widths.get(col_name, 15)

    wb.save(path)
    print(f"  Excel guardado: {path}")


# ── Main ───────────────────────────────────────────────────────────────────────
def main() -> None:
    input_csv = find_input_csv()
    print(f"Input:  {input_csv}")

    # Leer CSV
    with open(input_csv, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        all_rows = list(reader)

    if SAMPLE_MODE:
        all_rows = all_rows[:15]
        print(f"SAMPLE MODE: procesando {len(all_rows)} tiendas\n")
    else:
        print(f"Total tiendas: {len(all_rows)}\n")

    # Preparar lista de tiendas
    stores: list[dict] = []
    for r in all_rows:
        sucursal = (r.get(COL_SUCURSAL) or r.get("Sucursal") or r.get("sucursal") or "").strip()
        pais_raw = (r.get(COL_PAIS)     or r.get("Pais")     or r.get("pais")     or "AR").strip()
        is_dig, is_dep = preclass(sucursal)
        stores.append({
            "banner_group": (r.get(COL_GROUP)   or r.get("Banner Group") or "").strip(),
            "cliente":      (r.get(COL_CLIENTE)  or r.get("Cliente")     or "").strip(),
            "sucursal":     sucursal,
            "pais_raw":     pais_raw,
            "banner":       (r.get(COL_BANNER)   or r.get("Banner")      or "").strip(),
            "pre_digital":  is_dig,
            "pre_deposito": is_dep,
        })

    # ── Fase 1: Enriquecer ubicaciones ────────────────────────────────────────
    print("=== Fase 1: Enriqueciendo ubicaciones con Claude ===")
    enriched: dict[str, dict] = {}  # sucursal → location data

    # Pre-clasificados (no necesitan Claude)
    pre_done = [s for s in stores if s["pre_digital"] or s["pre_deposito"]]
    to_enrich = [s for s in stores if not s["pre_digital"] and not s["pre_deposito"]]

    print(f"  Pre-clasificados (digital/deposito): {len(pre_done)}")
    print(f"  A enriquecer con Claude: {len(to_enrich)}")

    for s in pre_done:
        enriched[s["sucursal"]] = {
            "ciudad": "", "localidad": "", "provincia": "",
            "shopping": "", "pais": s["pais_raw"],
            "es_digital": s["pre_digital"],
            "es_deposito": s["pre_deposito"],
        }

    for i in range(0, len(to_enrich), BATCH_SIZE):
        batch = to_enrich[i:i + BATCH_SIZE]
        print(f"  Lote {i // BATCH_SIZE + 1}: tiendas {i + 1}-{min(i + BATCH_SIZE, len(to_enrich))}")
        results = enrich_batch(batch)

        # Mapear resultados por nombre de sucursal
        result_map: dict[str, dict] = {}
        for r in results:
            name = (r.get("sucursal") or "").strip()
            if name:
                result_map[name] = r

        for s in batch:
            r = result_map.get(s["sucursal"]) or (results[batch.index(s)] if batch.index(s) < len(results) else {})
            enriched[s["sucursal"]] = {
                "ciudad":     (r.get("ciudad")    or "").strip(),
                "localidad":  (r.get("localidad") or "").strip(),
                "provincia":  (r.get("provincia") or "").strip(),
                "shopping":   (r.get("shopping")  or "").strip(),
                "pais":       (r.get("pais")       or s["pais_raw"]).strip(),
                "es_digital": bool(r.get("es_digital", s["pre_digital"])),
                "es_deposito": bool(r.get("es_deposito", s["pre_deposito"])),
            }

        if i + BATCH_SIZE < len(to_enrich):
            time.sleep(1)

    print(f"  Fase 1 completa: {len(enriched)} tiendas enriquecidas\n")

    # ── Fase 2: Verificar presencia Adidas/Puma ───────────────────────────────
    print("=== Fase 2: Verificando presencia Adidas/Puma ===")

    # Recolectar todas las claves únicas
    all_presence_keys: list[str] = []
    for s in stores:
        loc = enriched.get(s["sucursal"], {})
        keys = build_presence_keys(loc)
        for k in keys:
            if k not in all_presence_keys:
                all_presence_keys.append(k)

    print(f"  Ubicaciones únicas a verificar: {len(all_presence_keys)}")
    query_presence(all_presence_keys)
    print(f"  Fase 2 completa: {len(presenceCache)} ubicaciones verificadas\n")

    # ── Construir filas de output ──────────────────────────────────────────────
    output_rows: list[dict] = []
    for s in stores:
        loc = enriched.get(s["sucursal"], {})
        row = {
            "banner_group": s["banner_group"],
            "cliente":      s["cliente"],
            "sucursal":     s["sucursal"],
            "pais":         loc.get("pais")      or s["pais_raw"],
            "banner":       s["banner"],
            "ciudad":       loc.get("ciudad")    or "",
            "localidad":    loc.get("localidad") or "",
            "provincia":    loc.get("provincia") or "",
            "shopping":     loc.get("shopping")  or "",
            "es_digital":   loc.get("es_digital",  False),
            "es_deposito":  loc.get("es_deposito", False),
        }
        row.update(get_flags(loc))
        output_rows.append(row)

    # ── Guardar CSV ────────────────────────────────────────────────────────────
    data_dir = Path(__file__).parent / "data"
    csv_path  = data_dir / ("enriched-stores-sample.csv" if SAMPLE_MODE else "enriched-stores.csv")
    xlsx_path = data_dir / ("enriched-stores-sample.xlsx" if SAMPLE_MODE else "enriched-stores.xlsx")

    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=OUTPUT_COLS)
        writer.writeheader()
        writer.writerows(output_rows)
    print(f"  CSV guardado: {csv_path}")

    # ── Guardar Excel ──────────────────────────────────────────────────────────
    write_excel(output_rows, xlsx_path)

    print(f"\n✓ {len(output_rows)} tiendas procesadas.")


if __name__ == "__main__":
    main()
