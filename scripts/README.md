# Store Location Enrichment

Enriquece el listado de tiendas de Looker con Ciudad, Provincia, Código Postal, Shopping y País usando Claude AI. Opcionalmente detecta presencia de Adidas/Puma vía Google Maps (V2).

## Setup

1. Agregá tu API key al archivo `.env.local` en la raíz del proyecto:

```
ANTHROPIC_API_KEY=sk-ant-api03-...
# Solo para V2:
GOOGLE_MAPS_API_KEY=AIza...
```

2. Instalá dependencias (si no están instaladas):

```bash
pnpm install
```

## Cómo correr

### Prueba rápida (15 tiendas de muestra)
```bash
npx tsx scripts/enrich-stores-sample.ts
```

### V1 — Enriquecimiento completo con IA
```bash
npx tsx scripts/enrich-stores.ts
```
Genera `scripts/data/enriched-stores.csv` con columnas:
`sucursal, canal, cliente, pais, ciudad, provincia, codigo_postal, shopping, es_digital, es_deposito`

### V2 — V1 + presencia de Adidas/Puma en Google Maps
```bash
npx tsx scripts/enrich-stores.ts --v2
```
Agrega columnas: `tiene_adidas, tiene_puma`

## Costos estimados

| Run | Llamadas API | Costo aprox. |
|-----|-------------|--------------|
| V1 (592 tiendas) | ~12 llamadas Claude | ~$1 USD |
| V2 (+ Google Maps) | ~12 Claude + ~1200 Maps | ~$1 + Maps pricing |

## Output para Looker / Data Team

El CSV de salida está listo para hacer JOIN en Looker:

```sql
-- JOIN con tabla de ciudades
SELECT s.*, e.ciudad, e.provincia, e.shopping, e.pais
FROM ventas_stock_ytd s
LEFT JOIN store_enriched e ON s.sucursal = e.sucursal

-- Filtrar por shopping
WHERE e.shopping IS NOT NULL

-- Filtrar por país
WHERE e.pais = 'AR'
```
