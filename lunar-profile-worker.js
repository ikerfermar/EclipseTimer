"use strict";

const META_URL = "assets/data/lunar_contacts_2026.meta.json";
const BIN_URL = "assets/data/lunar_contacts_2026.u16.delta.gz";
const META_TIMEOUT_MS = 6000;
const BIN_TIMEOUT_MS = 20000;

function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { cache: "force-cache", signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}

function undoRowDeltaInPlace(arr, width, height, cells, bandCount) {
  for (let band = 0; band < bandCount; band += 1) {
    const bandOffset = band * cells;
    for (let row = 0; row < height; row += 1) {
      const rowStart = bandOffset + row * width;
      for (let col = 1; col < width; col += 1) {
        const index = rowStart + col;
        arr[index] = (arr[index - 1] + arr[index]) & 0xffff;
      }
    }
  }
}

async function load() {
  const metaResponse = await fetchWithTimeout(META_URL, META_TIMEOUT_MS);
  if (!metaResponse.ok) throw new Error("lunar profile meta unavailable");
  const meta = await metaResponse.json();

  const binResponse = await fetchWithTimeout(BIN_URL, BIN_TIMEOUT_MS);
  if (!binResponse.ok) throw new Error("lunar profile binary unavailable");
  if (typeof DecompressionStream !== "function" || !binResponse.body) {
    throw new Error("gzip decompression unsupported");
  }

  const buffer = await new Response(
    binResponse.body.pipeThrough(new DecompressionStream("gzip"))
  ).arrayBuffer();
  const width = Number(meta.width);
  const height = Number(meta.height);
  const cells = width * height;
  const encoding = typeof meta.encoding === "string" ? meta.encoding : "f32-planar";
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("invalid lunar profile metadata");
  }

  if (encoding === "u16-linear-per-band") {
    const data = new Uint16Array(buffer);
    if (data.length !== cells * 4) throw new Error("unexpected lunar profile binary size");
    undoRowDeltaInPlace(data, width, height, cells, 4);
  } else if (new Float32Array(buffer).length !== cells * 4) {
    throw new Error("unexpected lunar profile binary size");
  }
  return { meta, buffer };
}

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "load") return;
  try {
    const result = await load();
    self.postMessage({ type: "ready", ...result }, [result.buffer]);
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : "lunar profile unavailable" });
  }
});
