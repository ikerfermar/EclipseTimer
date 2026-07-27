#!/usr/bin/env node
"use strict";

// Compacta assets/data/lunar_contacts_2026.u16 para servirlo desde la app.
//
// Transformación: filtro delta por fila (igual que el filtro "Sub" de PNG),
// mod 65536, aplicado banda a banda (c1, c2, c3, c4), seguido de gzip nivel 9.
// Es reversible bit a bit -> el runtime (loadLunarProfileDataset en app.js)
// deshace la suma acumulada por fila y recupera el u16 original exacto,
// incluidos los píxeles nodata (65535): se tratan como un valor normal más,
// nunca como caso especial, así el filtro no se desincroniza fila a fila.
//
// Uso:
//   node scripts/build-lunar-contacts.mjs
//
// Lee:
//   assets/data/lunar_contacts_2026.meta.json
//   assets/data/lunar_contacts_2026.u16
// Escribe:
//   assets/data/lunar_contacts_2026.u16.delta.gz

import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "assets", "data");
const META_PATH = path.join(DATA_DIR, "lunar_contacts_2026.meta.json");
const SRC_PATH = path.join(DATA_DIR, "lunar_contacts_2026.u16");
const OUT_PATH = path.join(DATA_DIR, "lunar_contacts_2026.u16.delta.gz");

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function deltaEncodeBand(band, width, height) {
  // band: Uint16Array de longitud width*height (una banda ya extraída)
  const out = new Uint16Array(band.length);
  for (let r = 0; r < height; r += 1) {
    const rowStart = r * width;
    out[rowStart] = band[rowStart];
    for (let c = 1; c < width; c += 1) {
      const idx = rowStart + c;
      // resta mod 65536: uint16 wraparound, reversible sin pérdida
      out[idx] = (band[idx] - band[idx - 1]) & 0xffff;
    }
  }
  return out;
}

function deltaDecodeBand(band, width, height) {
  const out = new Uint16Array(band.length);
  for (let r = 0; r < height; r += 1) {
    const rowStart = r * width;
    out[rowStart] = band[rowStart];
    for (let c = 1; c < width; c += 1) {
      const idx = rowStart + c;
      out[idx] = (out[idx - 1] + band[idx]) & 0xffff;
    }
  }
  return out;
}

function main() {
  const meta = JSON.parse(readFileSync(META_PATH, "utf8"));
  const { width, height, bandOrder } = meta;
  if (!Number.isFinite(width) || !Number.isFinite(height) || !Array.isArray(bandOrder)) {
    throw new Error("meta.json inválido: falta width/height/bandOrder");
  }

  const srcBuffer = readFileSync(SRC_PATH);
  const srcU16 = new Uint16Array(srcBuffer.buffer, srcBuffer.byteOffset, srcBuffer.byteLength / 2);
  const cells = width * height;
  const expectedLen = cells * bandOrder.length;
  if (srcU16.length !== expectedLen) {
    throw new Error(`tamaño inesperado: ${srcU16.length} valores, se esperaban ${expectedLen}`);
  }

  console.log(`Origen: ${srcBuffer.length} bytes, ${bandOrder.length} bandas de ${width}x${height}`);

  // Delta por banda, concatenado en el mismo orden que bandOrder
  const deltaU16 = new Uint16Array(srcU16.length);
  bandOrder.forEach((_bandName, i) => {
    const band = srcU16.subarray(i * cells, (i + 1) * cells);
    const encoded = deltaEncodeBand(band, width, height);
    deltaU16.set(encoded, i * cells);
  });

  const deltaBuffer = Buffer.from(deltaU16.buffer, deltaU16.byteOffset, deltaU16.byteLength);
  const gz = gzipSync(deltaBuffer, { level: 9 });

  // --- Verificación de round-trip antes de escribir nada ---
  const roundTripDelta = gunzipSync(gz);
  const roundTripU16 = new Uint16Array(
    roundTripDelta.buffer,
    roundTripDelta.byteOffset,
    roundTripDelta.byteLength / 2
  );
  const reconstructed = new Uint16Array(roundTripU16.length);
  bandOrder.forEach((_bandName, i) => {
    const band = roundTripU16.subarray(i * cells, (i + 1) * cells);
    const decoded = deltaDecodeBand(band, width, height);
    reconstructed.set(decoded, i * cells);
  });
  const reconstructedBuffer = Buffer.from(
    reconstructed.buffer,
    reconstructed.byteOffset,
    reconstructed.byteLength
  );

  const srcHash = sha256(srcBuffer);
  const outHash = sha256(reconstructedBuffer);
  if (srcHash !== outHash) {
    throw new Error(
      `FALLO de verificación: el round-trip no reproduce el original exacto ` +
      `(sha256 origen ${srcHash} != reconstruido ${outHash}). No se escribe el .gz.`
    );
  }

  writeFileSync(OUT_PATH, gz);

  console.log(`Comprimido: ${gz.length} bytes (${((gz.length / srcBuffer.length) * 100).toFixed(1)}% del original)`);
  console.log(`Verificación round-trip: OK (sha256 idéntico al original)`);
  console.log(`Escrito: ${OUT_PATH}`);
}

main();
