# Store Enricher

Enriquece el listado de tiendas de Looker con Ciudad, Localidad, Provincia, Shopping y País.
Opcionalmente verifica si Adidas/Puma tienen tiendas en esas ubicaciones (V2).

## Requisito

**Node.js 18 o superior** — descargalo de https://nodejs.org si no lo tenés.

Para verificar: abrí una terminal y escribí `node --version`

## Setup (solo la primera vez)

1. Abrí una terminal en esta carpeta
2. Corré: `npm install`

## Comandos

```bash
npm run sample   # Prueba rápida con 15 tiendas (recomendado primero)
npm run v1       # V1: enriquece las 592 tiendas con ubicación
npm run v2       # V2: V1 + verifica presencia de Adidas/Puma
```

## Archivos

```
store-enricher/
  enrich-stores.ts          ← script principal
  enrich-stores-sample.ts   ← prueba rápida
  .env                      ← API key (no compartir)
  data/
    looker-stores.csv        ← input (592 tiendas de Looker)
    enriched-stores.csv      ← output (se genera al correr)
```

## Output CSV — columnas

| Columna | Descripción |
|---|---|
| sucursal | Nombre original de Looker |
| canal | MB / ND |
| cliente | Nombre del cliente |
| pais | AR / UY |
| ciudad | Municipio (Merlo, San Isidro, Buenos Aires...) |
| localidad | Barrio/localidad (Flores, Martínez, Monte Grande...) |
| provincia | Provincia o departamento |
| codigo_postal | CP aproximado |
| shopping | Nombre del shopping, vacío si es calle |
| es_digital | true/false |
| es_deposito | true/false |
| ADI_shopping | (V2) Adidas en ese shopping |
| ADI_localidad | (V2) Adidas en esa localidad |
| ADI_ciudad | (V2) Adidas en esa ciudad |
| PUM_shopping | (V2) Puma en ese shopping |
| PUM_localidad | (V2) Puma en esa localidad |
| PUM_ciudad | (V2) Puma en esa ciudad |
