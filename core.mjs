// Funciones sin DOM compartidas por la aplicación y sus pruebas.

export function parseCoordinateInput(value) {
  if (typeof value !== "string") return NaN;
  const normalized = value.trim().replace(",", ".");
  // Number() evita que entradas parcialmente válidas, como "42n" o
  // "42,5,1", se conviertan silenciosamente en una coordenada distinta.
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return NaN;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function validateCoordinates(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { valid: false, message: "Introduce latitud y longitud válidas." };
  }
  if (lat < -90 || lat > 90) {
    return { valid: false, message: "La latitud debe estar entre 90° S y 90° N." };
  }
  if (lon < -180 || lon > 180) {
    return { valid: false, message: "La longitud debe estar entre 180° O y 180° E." };
  }
  return { valid: true, message: "" };
}

export function chunkPoints(points, maxPointsPerRequest) {
  if (!Array.isArray(points) || !Number.isInteger(maxPointsPerRequest) || maxPointsPerRequest < 1) {
    throw new TypeError("invalid terrain request batch");
  }
  const batches = [];
  for (let index = 0; index < points.length; index += maxPointsPerRequest) {
    batches.push(points.slice(index, index + maxPointsPerRequest));
  }
  return batches;
}
