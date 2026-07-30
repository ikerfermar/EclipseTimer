"use strict";

const T0_TDT = 18.0;
const DELTA_T = 71.4;
const SUN_SEMI_DIAMETER_DEG = 0.26667;

const COEFF = {
  x: [0.475593, 0.5189288, -0.0000773, -0.0000088],
  y: [0.771161, -0.2301664, -0.0001245, 0.0000037],
  d: [14.79667, -0.012065, -0.000003, 0],
  l1: [0.537954, 0.000094, -0.0000121, 0],
  l2: [-0.008142, 0.0000935, -0.0000121, 0],
  mu: [88.74776, 15.003093, 0, 0]
};

const TAN_F1 = 0.0046141;
const TAN_F2 = 0.0045911;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
// Antes se recalculaba todo a 10 Hz (100 ms) sin parar, incluso con horas
// de margen hasta el próximo contacto. Solo hace falta esa resolución justo
// antes de un evento, para sincronizar bien los beeps y la cuenta atrás.
// El resto del tiempo, 1 Hz es de sobra para un reloj y ahorra CPU/batería.
// Nota: como los avisos de buildTimedEvents() están agrupados cada 20-40 s
// alrededor de C2/C3, en la práctica el modo "fast" se mantiene activo casi
// todo ese tramo (no solo los últimos AUDIO_FAST_WINDOW_SEC segundos),
// porque siempre hay un aviso cercano tirando del intervalo hacia abajo.
const FAST_TICK_MS = 100;
const MEDIUM_TICK_MS = 300;
const SLOW_TICK_MS = 1000;
const BACKGROUND_TICK_MS = 5000;
const IDLE_TICK_MS = 10000;
const AUDIO_FAST_WINDOW_SEC = 20;
const AUDIO_MEDIUM_WINDOW_SEC = 120;
// Margen para reanudar el AudioContext con antelación. Debe ser
// sensiblemente mayor que AUDIO_FAST_WINDOW_SEC: si coincidiera con la
// misma ventana, la reanudación (asíncrona) y el primer beep se pedirían
// casi en el mismo tick, sin margen real de reloj para que resume()
// termine antes de que haga falta sonido. 40 s da varios ciclos de tick
// "medium" (300 ms) de margen real antes de necesitar sonido, sin tener el
// audio despierto tanto tiempo como con el margen anterior (120 s).
const AUDIO_SUSPEND_MARGIN_SEC = 40;
// Avisos de gafas y filtro fotográfico sin sesgo artificial: se disparan
// exactamente en el instante calculado de C2/C3. El acotado de error ya se
// resuelve en la propia precisión del cálculo y en el perfil lunar aplicado
// al recalcular la ubicación.
const SAFETY_MARGIN_SEC = 0;
const SAFETY_MARGIN_HOURS = SAFETY_MARGIN_SEC / 3600;
// Tolerancia de "llegada tarde" para eventos de seguridad ocular (gafas y
// filtro fotográfico). Si el tick se retrasa (pantalla bloqueada, app en
// segundo plano) más de ALERT_MAX_LATE_SEC, el aviso normal se descarta en
// silencio. Para gafas/filtro eso puede significar que el aviso crítico no
// suene nunca. Se les da más margen de tolerancia para que, aunque lleguen
// tarde, sigan sonando en vez de perderse.
const SAFETY_ALERT_MAX_LATE_SEC = 6;
const PROTECTIVE_ALERT_MAX_LATE_SEC = 120;
const PREFS_KEY = "eclipsetimer-alert-prefs-v1";
const AUDIO_ADVANCE_SEC = 0.5;
const AUDIO_ADVANCE_HOURS = AUDIO_ADVANCE_SEC / 3600;
const LEON_PRESET = Object.freeze({
  lat: 42.5987,
  lon: -5.5671,
  sourceLabel: "manual (León)"
});
const LOCATION_SOURCE_REAL = "real";
const LOCATION_SOURCE_PRESET = "preset";

const $ = (id) => document.getElementById(id);

// Los campos de coordenadas ya no son type="number": en un movil con
// idioma espanol, ese input nativo espera coma decimal (formato del
// sistema), pero el placeholder mostraba un ejemplo con punto -
// inconsistente, y encima algunos navegadores llegan a rechazar el
// caracter "equivocado" al pegar. Con type="text" + este parser propio
// aceptamos coma o punto indistintamente (por ejemplo, al pegar unas
// coordenadas copiadas de Google Maps, que usa punto).
function parseDecimal(str) {
  if (typeof str !== "string") return NaN;
  return parseFloat(str.trim().replace(",", "."));
}

const DEFAULT_ALERT_COPY = {
  events: {
    "c1-minus-60": {
      tag: "Aviso",
      text: "Falta 1 minuto para C1",
      voice: "Falta un minuto para C1."
    },
    "c1-contact": {
      tag: "C1",
      text: "Comienza la fase parcial",
      voice: "Contacto uno. Comienza la fase parcial."
    },
    "c2-minus-60": {
      tag: "Aviso",
      text: "Falta 1 minuto para C2",
      voice: "Falta un minuto para C2."
    },
    "glasses-off": {
      tag: "Seguridad visual",
      text: "Solo si está oscuro: gafas fuera",
      voice: "Contacto dos. Si está oscuro, puedes quitar las gafas. Si ves luz brillante, espera."
    },
    "glasses-on": {
      tag: "Seguridad visual",
      text: "Gafas puestas ahora",
      voice: "Termina la totalidad. Gafas puestas ahora."
    },
    "photo-hand": {
      tag: "Aviso",
      text: "Prepara el filtro",
      voice: "Prepara el filtro."
    },
    "photo-refocus": {
      tag: "Aviso",
      text: "Re-enfoca en el sol",
      voice: "Quedan cuatro minutos y medio para C2. Re-enfoca en el sol."
    },
    "photo-remove-filter": {
      tag: "Aviso",
      text: "Filtro fuera ahora",
      voice: "Filtro fuera ahora."
    },
    "photo-mode-totality": {
      tag: "Aviso",
      text: "Cambiar a modo totalidad",
      voice: "Cambia a modo totalidad."
    },
    "photo-mode-partial": {
      tag: "Aviso",
      text: "Cambiar a modo semiparcialidad",
      voice: "Cambia a modo semiparcialidad."
    },
    "photo-filter-on": {
      tag: "Aviso",
      text: "Filtro puesto ahora",
      voice: "Filtro puesto ahora."
    },
    "c4-minus-60": {
      tag: "Aviso",
      text: "Falta 1 minuto para C4",
      voice: "Falta un minuto para C4."
    },
    "c4-contact": {
      tag: "C4",
      text: "Termina el eclipse",
      voice: "Contacto cuatro. Termina el eclipse."
    }
  },
  photoSummary: {
    rows: {
      "photo-hand": "Prepara el filtro",
      "photo-refocus": "Re-enfoca en el sol",
      "photo-remove-countdown": "Cuenta atrás filtro fuera",
      "photo-remove-filter": "Filtro fuera ahora",
      "photo-mode-totality": "Cambiar a modo totalidad",
      "photo-mode-partial": "Cambiar a modo semiparcialidad",
      "photo-filter-on-countdown": "Cuenta atrás filtro puesto",
      "photo-filter-on": "Filtro puesto ahora"
    }
  }
};

let state = {
  lat: null,
  lon: null,
  alt: 0,
  contacts: null,
  alertsFired: {},
  photoEnabled: false,
  testMode: false,
  testStartWallMs: null,
  testStartVirtualT: null,
  prevTickTUTC: null,
  testSpeed: 1,
  locating: false,
  locationRequestId: 0,
  altitudeRequestId: 0,
  lunarProfileApplied: false,
  locationSourceKind: LOCATION_SOURCE_REAL
};

let wakeLockRef = null;
let bannerTimeout = null;
let tickTimerId = null;
let tickIntervalMs = SLOW_TICK_MS;
let sharedAudioCtx = null;
let alertAudioUnlocked = false;
let diskNodes = null;
let tickNodes = null;
let viewportUpdateFrame = null;
let previousFocusBeforeAbout = null;
let offlineStatusTimeout = null;
const SW_RELOAD_KEY = "eclipsetimer-sw-reload-version";
const OFFLINE_READY_KEY = "eclipsetimer-offline-ready-seen-v1";

function getTickNodes() {
  if (!tickNodes) {
    tickNodes = {
      phaseName: $("phase-name"),
      magNum: $("mag-num"),
      sunGeo: $("sun-geo"),
      cdClock: $("cd-clock"),
      cdEvent: $("cd-event"),
      cdLabel: $("cd-label")
    };
  }
  return tickNodes;
}
let alertDisplayQueue = [];
let alertDisplayActive = false;
let countdownFlashTimer = null;
let alertCopy = DEFAULT_ALERT_COPY;
let lunarProfileDataset = null;
let lunarProfileLoadPromise = null;
let visibilityProfileRequestId = 0;
const visibilityProfileCache = new Map();

const DEFAULT_PAYPAL_CONFIG = {
  enabled: true,
  label: "Apoyar el proyecto",
  url: ""
};

let paypalConfig = DEFAULT_PAYPAL_CONFIG;

const ALERT_MAX_LATE_SEC = 0.9;
const RESULT_SECTION_IDS = ["main-section", "ops-section", "alerts-section"];
const COLLAPSIBLE_POST_LOCATION_IDS = ["ops-section", "alerts-section"];

function clearSpeechQueue() {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
}

function clearAlertDisplayQueue() {
  alertDisplayQueue = [];
  alertDisplayActive = false;
  if (bannerTimeout) {
    clearTimeout(bannerTimeout);
    bannerTimeout = null;
  }
}

function mergeStringMap(defaults, override) {
  const merged = { ...defaults };
  if (!override || typeof override !== "object") return merged;
  Object.keys(defaults).forEach((key) => {
    if (typeof override[key] === "string") merged[key] = override[key];
  });
  return merged;
}

function mergeAlertCopyConfig(config) {
  if (!config || typeof config !== "object") return DEFAULT_ALERT_COPY;

  const events = {};
  Object.entries(DEFAULT_ALERT_COPY.events).forEach(([key, defaults]) => {
    events[key] = mergeStringMap(defaults, config.events && config.events[key]);
  });

  return {
    events,
    photoSummary: {
      rows: mergeStringMap(DEFAULT_ALERT_COPY.photoSummary.rows, config.photoSummary?.rows)
    }
  };
}

const CONFIG_FETCH_TIMEOUT_MS = 1500;
const ELEVATION_FETCH_TIMEOUT_MS = 5000;
const ELEVATION_API_BASE_URL = "https://api.open-meteo.com/v1/elevation";
const LUNAR_PROFILE_META_FETCH_TIMEOUT_MS = 6000;
const LUNAR_PROFILE_BIN_FETCH_TIMEOUT_MS = 20000;
const LUNAR_PROFILE_META_URL = "assets/data/lunar_contacts_2026.meta.json";
const LUNAR_PROFILE_BIN_URL = "assets/data/lunar_contacts_2026.u16.delta.gz";
const ECLIPSE_T0_UTC_HOUR = T0_TDT - DELTA_T / 3600;
const VIS_PROFILE_FETCH_TIMEOUT_MS = 5000;
const VIS_PROFILE_MAX_DISTANCE_M = 10000;
// 3 momentos (C1, CM, C4) x este valor no puede superar el límite de 100
// coordenadas por request de la Open-Meteo Elevation API.
const VIS_PROFILE_SAMPLE_COUNT = 33;

// fetch() no tiene timeout propio: con red lenta o intermitente (típico en
// un sitio de observación remoto) podía tardar mucho en fallar. Como antes
// se esperaba a esto antes de bindEvents(), los botones se quedaban sin
// responder mientras tanto. Con la carrera contra el timeout, como mucho
// tarda CONFIG_FETCH_TIMEOUT_MS y sigue con los valores por defecto.
function fetchWithTimeout(url, timeoutMs, fetchOptions = {}) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error("config fetch timeout")), timeoutMs);
    fetch(url, { cache: "no-cache", ...fetchOptions }).then(
      (response) => {
        clearTimeout(timeoutId);
        resolve(response);
      },
      (err) => {
        clearTimeout(timeoutId);
        reject(err);
      }
    );
  });
}

// Toda la precisión de la app (ΔT a 0.1s, ráster IGN a ~1s) no sirve de nada
// si el reloj del dispositivo está desajustado unos segundos, algo que pasa
// más de lo que parece (hora manual, cambio de país sin cobertura, etc.) y
// de lo que el usuario no tiene forma de enterarse por sí mismo. Esta
// comprobación contrasta Date.now() contra la cabecera HTTP "Date" del
// propio servidor estático como segunda fuente independiente.
//
// Usamos HEAD en vez de GET a propósito: service-worker.js solo intercepta
// peticiones GET ("if (event.request.method !== 'GET') return;"), así que
// un HEAD se salta el Service Worker por completo. Eso nos garantiza (a)
// una ida y vuelta real a la red cuando hay conexión, y (b) un fallo limpio
// cuando no la hay, sin arriesgarnos a leer la cabecera Date de una
// respuesta cacheada antigua y disparar un falso aviso.
const CLOCK_SKEW_WARN_THRESHOLD_SEC = 2;
const CLOCK_SKEW_CHECK_TIMEOUT_MS = 5000;
const CLOCK_SKEW_CHECK_URL = "index.html";

async function checkClockSkew() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  try {
    const sentAt = Date.now();
    const response = await fetchWithTimeout(CLOCK_SKEW_CHECK_URL, CLOCK_SKEW_CHECK_TIMEOUT_MS, {
      method: "HEAD",
      cache: "no-store"
    });
    const receivedAt = Date.now();
    const serverDateHeader = response.headers.get("date");
    if (!serverDateHeader) return; // servidor sin cabecera Date: no podemos verificar, no avisamos
    const serverMs = Date.parse(serverDateHeader);
    if (!Number.isFinite(serverMs)) return;

    // La cabecera Date solo tiene resolución de 1s y no nos da el instante
    // exacto de servidor; usamos el punto medio del viaje de ida y vuelta
    // como mejor estimación del instante local equivalente.
    const localMidpointMs = (sentAt + receivedAt) / 2;
    const skewSec = (localMidpointMs - serverMs) / 1000;

    if (Math.abs(skewSec) >= CLOCK_SKEW_WARN_THRESHOLD_SEC) {
      const dir = skewSec > 0 ? "adelantado" : "atrasado";
      setClockStatus(`Reloj ${dir} ~${Math.round(Math.abs(skewSec))}s: revisa el ajuste automático.`, "warn");
    } else {
      setClockStatus("");
    }
  } catch (_) {
    // Sin red, timeout, o CORS: no podemos verificar. No avisamos para
    // evitar falsos positivos (igual que el resto de la app, un fallo aquí
    // no debe bloquear ni alarmar sin motivo).
  }
}

// El día del eclipse, api.open-meteo.com es un servicio gratuito de
// terceros que muy probablemente estará bajo carga alta (mucha gente
// consultando circunstancias locales a la vez) justo cuando la red móvil
// también puede ir peor de lo normal. La elevación de un punto no cambia,
// así que cachearla en localStorage evita depender de esa red en
// consultas repetidas al mismo sitio (p. ej. el botón rápido de León).
const ELEVATION_CACHE_KEY = "eclipsetimer-elevation-cache-v1";
const ELEVATION_CACHE_MAX_ENTRIES = 30;

function elevationCacheKey(lat, lon) {
  // 3 decimales ≈ 111 m de precisión horizontal, de sobra para elevación.
  return `${lat.toFixed(3)},${lon.toFixed(3)}`;
}

function readElevationCache() {
  try {
    const raw = localStorage.getItem(ELEVATION_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function getCachedAltitude(lat, lon) {
  const cache = readElevationCache();
  const entry = cache[elevationCacheKey(lat, lon)];
  return Number.isFinite(entry?.alt) ? entry.alt : null;
}

function setCachedAltitude(lat, lon, alt) {
  try {
    const cache = readElevationCache();
    const key = elevationCacheKey(lat, lon);
    cache[key] = { alt, ts: Date.now() };
    const keys = Object.keys(cache);
    if (keys.length > ELEVATION_CACHE_MAX_ENTRIES) {
      // Descarta las entradas más antiguas si la caché crece demasiado.
      keys
        .sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0))
        .slice(0, keys.length - ELEVATION_CACHE_MAX_ENTRIES)
        .forEach((k) => delete cache[k]);
    }
    localStorage.setItem(ELEVATION_CACHE_KEY, JSON.stringify(cache));
  } catch (_) {
    // localStorage lleno o no disponible (modo privado, etc.): no es crítico,
    // simplemente no cachea y se repetirá la consulta la próxima vez.
  }
}

// La altitud se obtiene del modelo de elevación usando lat/lon (sin entrada
// manual) para simplificar el panel de ubicación.
async function fetchAltitudeMeters(lat, lon) {
  const cached = getCachedAltitude(lat, lon);
  if (cached !== null) return cached;

  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon)
  });
  const response = await fetchWithTimeout(`${ELEVATION_API_BASE_URL}?${params.toString()}`, ELEVATION_FETCH_TIMEOUT_MS);
  if (!response.ok) throw new Error("elevation api error");
  const data = await response.json();
  const value = Array.isArray(data?.elevation) ? data.elevation[0] : data?.elevation;
  if (!Number.isFinite(value)) throw new Error("invalid elevation payload");
  const rounded = Math.round(value);
  setCachedAltitude(lat, lon, rounded);
  return rounded;
}

function lonLatToWebMercator(lonDeg, latDeg) {
  const x = 6378137 * lonDeg * D2R;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, latDeg));
  const y = 6378137 * Math.log(Math.tan(Math.PI / 4 + (clampedLat * D2R) / 2));
  return { x, y };
}

// Deshace in-place el filtro delta por fila (mod 65536) aplicado en el build
// a cada una de las `bandCount` bandas concatenadas dentro de `arr`. Debe ser
// el inverso exacto de deltaEncodeBand() en scripts/build-lunar-contacts.mjs.
function undoRowDeltaInPlace(arr, width, height, cells, bandCount) {
  for (let b = 0; b < bandCount; b += 1) {
    const bandOffset = b * cells;
    for (let r = 0; r < height; r += 1) {
      const rowStart = bandOffset + r * width;
      for (let c = 1; c < width; c += 1) {
        const idx = rowStart + c;
        arr[idx] = (arr[idx - 1] + arr[idx]) & 0xffff;
      }
    }
  }
}

async function loadLunarProfileDataset() {
  if (lunarProfileDataset) return lunarProfileDataset;
  if (lunarProfileLoadPromise) return lunarProfileLoadPromise;

  lunarProfileLoadPromise = (async () => {
    const metaResponse = await fetchWithTimeout(LUNAR_PROFILE_META_URL, LUNAR_PROFILE_META_FETCH_TIMEOUT_MS, { cache: "force-cache" });
    if (!metaResponse.ok) throw new Error("lunar profile meta unavailable");
    const meta = await metaResponse.json();

    const binResponse = await fetchWithTimeout(LUNAR_PROFILE_BIN_URL, LUNAR_PROFILE_BIN_FETCH_TIMEOUT_MS, { cache: "force-cache" });
    if (!binResponse.ok) throw new Error("lunar profile binary unavailable");
    if (typeof DecompressionStream !== "function" || !binResponse.body) {
      throw new Error("gzip decompression unsupported");
    }
    const decompressedStream = binResponse.body.pipeThrough(new DecompressionStream("gzip"));
    const buffer = await new Response(decompressedStream).arrayBuffer();

    const width = Number(meta.width);
    const height = Number(meta.height);
    const nodata = Number(meta.nodata);
    const scaleX = Number(meta.pixelScaleX);
    const scaleY = Number(meta.pixelScaleY);
    const tieX = Number(meta.tieX);
    const tieY = Number(meta.tieY);
    const encoding = typeof meta.encoding === "string" ? meta.encoding : "f32-planar";
    const quantization = meta.quantization && typeof meta.quantization === "object"
      ? meta.quantization
      : null;

    if (![width, height, scaleX, scaleY, tieX, tieY, nodata].every(Number.isFinite)) {
      throw new Error("invalid lunar profile metadata");
    }

    const cells = width * height;
    let arr;
    if (encoding === "u16-linear-per-band") {
      arr = new Uint16Array(buffer);
      if (arr.length !== cells * 4) throw new Error("unexpected lunar profile binary size");
      // El fichero servido está delta-codificado por fila (mod 65536, filtro
      // tipo PNG "Sub") + gzip para bajar de 88.6 MB a ~5.4 MB. Se deshace
      // aquí con una suma acumulada por fila, banda a banda, incluyendo los
      // píxeles nodata (65535) como un valor más: el codificador de build
      // (scripts/build-lunar-contacts.mjs) tampoco los trata como caso
      // especial, así que la reconstrucción es exacta bit a bit.
      undoRowDeltaInPlace(arr, width, height, cells, 4);
    } else {
      arr = new Float32Array(buffer);
      if (arr.length !== cells * 4) throw new Error("unexpected lunar profile binary size");
    }

    lunarProfileDataset = {
      width,
      height,
      nodata,
      scaleX,
      scaleY,
      tieX,
      tieY,
      encoding,
      quantization,
      data: arr,
      cells,
      offsets: {
        c1: 0,
        c2: cells,
        c3: cells * 2,
        c4: cells * 3
      }
    };
    return lunarProfileDataset;
  })().catch((err) => {
    lunarProfileDataset = null;
    throw err;
  }).finally(() => {
    lunarProfileLoadPromise = null;
  });

  return lunarProfileLoadPromise;
}

function sampleProfileNearest(dataset, bandName, row, col) {
  const r = Math.max(0, Math.min(dataset.height - 1, Math.round(row)));
  const c = Math.max(0, Math.min(dataset.width - 1, Math.round(col)));
  const idx = dataset.offsets[bandName] + r * dataset.width + c;
  const rawValue = dataset.data[idx];
  if (!Number.isFinite(rawValue) || rawValue === dataset.nodata) return null;

  if (dataset.encoding === "u16-linear-per-band") {
    const q = dataset.quantization && dataset.quantization[bandName];
    if (!q || !Number.isFinite(q.offsetHours) || !Number.isFinite(q.scaleHours)) return null;
    return q.offsetHours + rawValue * q.scaleHours;
  }
  return rawValue;
}

function sampleProfileBilinear(dataset, bandName, row, col) {
  if (row < 0 || col < 0 || row > dataset.height - 1 || col > dataset.width - 1) return null;

  const r0 = Math.floor(row);
  const c0 = Math.floor(col);
  const r1 = Math.min(dataset.height - 1, r0 + 1);
  const c1 = Math.min(dataset.width - 1, c0 + 1);
  const fr = row - r0;
  const fc = col - c0;

  const idx00 = dataset.offsets[bandName] + r0 * dataset.width + c0;
  const idx10 = dataset.offsets[bandName] + r1 * dataset.width + c0;
  const idx01 = dataset.offsets[bandName] + r0 * dataset.width + c1;
  const idx11 = dataset.offsets[bandName] + r1 * dataset.width + c1;

  const v00 = dataset.data[idx00];
  const v10 = dataset.data[idx10];
  const v01 = dataset.data[idx01];
  const v11 = dataset.data[idx11];
  const allValid = [v00, v10, v01, v11].every((v) => Number.isFinite(v) && v !== dataset.nodata);
  if (!allValid) return sampleProfileNearest(dataset, bandName, row, col);

  const top = v00 + (v01 - v00) * fc;
  const bottom = v10 + (v11 - v10) * fc;
  const raw = top + (bottom - top) * fr;
  if (dataset.encoding === "u16-linear-per-band") {
    const q = dataset.quantization && dataset.quantization[bandName];
    if (!q || !Number.isFinite(q.offsetHours) || !Number.isFinite(q.scaleHours)) return null;
    return q.offsetHours + raw * q.scaleHours;
  }
  return raw;
}

function sampleLunarProfileContacts(dataset, lat, lon) {
  const p = lonLatToWebMercator(lon, lat);
  const col = (p.x - dataset.tieX) / dataset.scaleX;
  const row = (dataset.tieY - p.y) / dataset.scaleY;

  if (row < 0 || col < 0 || row > dataset.height - 1 || col > dataset.width - 1) {
    return null;
  }

  const c1 = sampleProfileBilinear(dataset, "c1", row, col);
  const c2 = sampleProfileBilinear(dataset, "c2", row, col);
  const c3 = sampleProfileBilinear(dataset, "c3", row, col);
  const c4 = sampleProfileBilinear(dataset, "c4", row, col);
  if (![c1, c2, c3, c4].every((v) => Number.isFinite(v))) return null;

  // El dataset externo viene en horas UTC del día del eclipse. El resto de la
  // app usa horas relativas al t0 besseliano (dominio TDT/UT equivalente como
  // duración), así que convertimos aquí una sola vez para evitar desfases.
  const c1Rel = c1 - ECLIPSE_T0_UTC_HOUR;
  const c2Rel = c2 - ECLIPSE_T0_UTC_HOUR;
  const c3Rel = c3 - ECLIPSE_T0_UTC_HOUR;
  const c4Rel = c4 - ECLIPSE_T0_UTC_HOUR;

  if (!(c1Rel < c2Rel && c2Rel < c3Rel && c3Rel < c4Rel)) return null;
  return { c1: c1Rel, c2: c2Rel, c3: c3Rel, c4: c4Rel };
}



async function getBestContacts(lat, lon, alt) {
  const profile = await resolveLunarProfileContacts(lat, lon);
  if (profile && profile.applied) {
    return {contacts:{...profile.contacts,total:profile.contacts.c2!==null&&profile.contacts.c3!==null},source:'ign-profile'};
  }
  return {contacts:computeContacts(lat, lon, alt),source:'geometric'};
}
async function resolveLunarProfileContacts(lat, lon) {
  const resolveOnce = async () => {
    const dataset = await loadLunarProfileDataset();
    const contacts = sampleLunarProfileContacts(dataset, lat, lon);
    if (!contacts) return { available: true, applied: false };
    return { available: true, applied: true, contacts };
  };

  try {
    return await resolveOnce();
  } catch (_) {
    // Reintento único para evitar falsos negativos por timeout/transición de red.
    try {
      return await resolveOnce();
    } catch (_retryErr) {
      return { available: false, applied: false };
    }
  }
}

function destinationPoint(latDeg, lonDeg, bearingDeg, distanceM) {
  const angular = distanceM / 6378137;
  const brng = bearingDeg * D2R;
  const lat1 = latDeg * D2R;
  const lon1 = lonDeg * D2R;

  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAngular = Math.sin(angular);
  const cosAngular = Math.cos(angular);

  const lat2 = Math.asin(sinLat1 * cosAngular + cosLat1 * sinAngular * Math.cos(brng));
  const lon2 = lon1 + Math.atan2(
    Math.sin(brng) * sinAngular * cosLat1,
    cosAngular - sinLat1 * Math.sin(lat2)
  );

  let lonOut = lon2 * R2D;
  while (lonOut > 180) lonOut -= 360;
  while (lonOut < -180) lonOut += 360;
  return { lat: lat2 * R2D, lon: lonOut };
}

function profileKey(lat, lon, moments, observerAlt) {
  const geoKey = moments
    .map((m) => `${m.id}:${m.geo.az.toFixed(1)}:${m.geo.alt.toFixed(1)}`)
    .join("|");
  return [lat.toFixed(4), lon.toFixed(4), Math.round(observerAlt), geoKey].join("|");
}

function parseElevationArray(payload) {
  if (!payload) return null;
  if (Array.isArray(payload.elevation)) return payload.elevation;
  if (Array.isArray(payload.elevations)) return payload.elevations;
  return null;
}

async function fetchTerrainProfile(points) {
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat.toFixed(6)).join(","),
    longitude: points.map((p) => p.lon.toFixed(6)).join(",")
  });
  const response = await fetchWithTimeout(`https://api.open-meteo.com/v1/elevation?${params.toString()}`, VIS_PROFILE_FETCH_TIMEOUT_MS);
  if (!response.ok) throw new Error("terrain profile unavailable");
  const data = await response.json();
  const values = parseElevationArray(data);
  if (!Array.isArray(values) || values.length !== points.length) throw new Error("invalid terrain profile payload");
  const parsed = values.map((v) => Number(v));
  if (!parsed.every(Number.isFinite)) throw new Error("invalid terrain profile values");
  return parsed;
}

function maximumEclipseTime(c) {
  if (!c || c.c1 === null || c.c4 === null) return null;
  if (c.total && c.c2 !== null && c.c3 !== null) return (c.c2 + c.c3) / 2;
  if (!c.obs) return (c.c1 + c.c4) / 2;

  let lo = c.c1;
  let hi = c.c4;
  for (let i = 0; i < 48; i += 1) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const f1 = circumstances(m1, c.obs).m;
    const f2 = circumstances(m2, c.obs).m;
    if (f1 < f2) hi = m2;
    else lo = m1;
  }
  return (lo + hi) / 2;
}

function buildVisibilityMoments(c, lat, lon) {
  if (!c || c.c1 === null || c.c4 === null) return [];

  const moments = [];
  if (Number.isFinite(c.c1)) {
    moments.push({ id: "C1", label: "C1", time: c.c1 });
  }

  const midTotality = c.total && Number.isFinite(c.c2) && Number.isFinite(c.c3)
    ? (c.c2 + c.c3) / 2
    : maximumEclipseTime(c);
  if (Number.isFinite(midTotality)) {
    moments.push({ id: "CM", label: "Máx.", time: midTotality });
  }

  if (Number.isFinite(c.c4)) {
    moments.push({ id: "C4", label: "C4", time: c.c4 });
  }

  return moments.map((m) => ({
    ...m,
    geo: sunAltAz(m.time, lat, lon)
  }));
}

function buildVisibilityPath(points, xScale, yScale) {
  return points.map((p, idx) => `${idx === 0 ? "M" : "L"}${xScale(p.x).toFixed(2)},${yScale(p.y).toFixed(2)}`).join(" ");
}

function formatDistanceM(meters) {
  if (meters >= 1000) return `${(meters / 1000).toFixed(0)} km`;
  return `${Math.round(meters)} m`;
}

function renderVisibilityProfileUnavailable(msg) {
  const wrap = $("visibility-profile");
  const summary = $("visibility-profile-summary");
  const chart = $("visibility-profile-svg");
  const note = $("visibility-profile-note");
  if (!wrap || !summary || !chart || !note) return;

  wrap.hidden = false;
  summary.textContent = msg;
  chart.innerHTML = "";
  note.textContent = "";
}

function renderVisibilityProfile(data) {
  const wrap = $("visibility-profile");
  const summary = $("visibility-profile-summary");
  const chart = $("visibility-profile-svg");
  const note = $("visibility-profile-note");
  if (!wrap || !summary || !chart || !note) return;

  wrap.hidden = false;
  const ns = "http://www.w3.org/2000/svg";
  chart.innerHTML = "";

  const width = 320;
  const height = 170;
  const mLeft = 38;
  const mRight = 12;
  const mTop = 12;
  const mBottom = 28;
  const plotW = width - mLeft - mRight;
  const plotH = height - mTop - mBottom;

  const allTerrain = data.moments.flatMap((m) => m.terrainElev);
  const allLines = data.moments.flatMap((m) => m.lineElev);
  const yMinRaw = Math.min(...allTerrain, ...allLines, data.observerAlt);
  const yMaxRaw = Math.max(...allTerrain, ...allLines, data.observerAlt);
  let yMin = Math.floor((yMinRaw - 20) / 50) * 50;
  let yMax = Math.ceil((yMaxRaw + 20) / 50) * 50;
  if (yMax - yMin < 180) yMax = yMin + 180;

  const xScale = (x) => mLeft + (x / data.maxDistanceM) * plotW;
  const yScale = (y) => mTop + (1 - (y - yMin) / (yMax - yMin)) * plotH;

  const primaryMoment = data.moments[data.primaryMomentIndex] || data.moments[0];
  const horizonPath = data.distances.map((d, i) => ({ x: d, y: primaryMoment.terrainElev[i] }));

  const axis = document.createElementNS(ns, "path");
  axis.setAttribute("d", `M${mLeft},${mTop} V${mTop + plotH} H${mLeft + plotW}`);
  axis.setAttribute("stroke", "rgba(220,220,220,0.55)");
  axis.setAttribute("stroke-width", "1");
  axis.setAttribute("fill", "none");
  chart.appendChild(axis);

  const yTicks = 4;
  for (let i = 0; i <= yTicks; i += 1) {
    const yVal = yMin + ((yMax - yMin) * i) / yTicks;
    const y = yScale(yVal);
    const grid = document.createElementNS(ns, "line");
    grid.setAttribute("x1", String(mLeft));
    grid.setAttribute("x2", String(mLeft + plotW));
    grid.setAttribute("y1", String(y));
    grid.setAttribute("y2", String(y));
    grid.setAttribute("stroke", "rgba(220,220,220,0.18)");
    grid.setAttribute("stroke-width", "1");
    chart.appendChild(grid);

    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", String(mLeft - 6));
    label.setAttribute("y", String(y + 3));
    label.setAttribute("text-anchor", "end");
    label.setAttribute("font-size", "10");
    label.setAttribute("fill", "#b8b5aa");
    label.textContent = String(Math.round(yVal));
    chart.appendChild(label);
  }

  const xTicks = [0, data.maxDistanceM * 0.5, data.maxDistanceM];
  xTicks.forEach((xVal, idx) => {
    const x = xScale(xVal);
    const tick = document.createElementNS(ns, "line");
    tick.setAttribute("x1", String(x));
    tick.setAttribute("x2", String(x));
    tick.setAttribute("y1", String(mTop + plotH));
    tick.setAttribute("y2", String(mTop + plotH + 4));
    tick.setAttribute("stroke", "rgba(220,220,220,0.45)");
    chart.appendChild(tick);

    const label = document.createElementNS(ns, "text");
    const isFirst = idx === 0;
    const isLast = idx === xTicks.length - 1;
    label.setAttribute("x", String(isFirst ? x + 1 : (isLast ? x - 1 : x)));
    label.setAttribute("y", String(mTop + plotH + 16));
    label.setAttribute("text-anchor", isFirst ? "start" : (isLast ? "end" : "middle"));
    label.setAttribute("font-size", "10");
    label.setAttribute("fill", "#b8b5aa");
    label.textContent = xVal === 0 ? "0" : formatDistanceM(xVal);
    chart.appendChild(label);
  });

  const terrain = document.createElementNS(ns, "path");
  terrain.setAttribute("d", buildVisibilityPath(horizonPath, xScale, yScale));
  terrain.setAttribute("stroke", "#949083");
  terrain.setAttribute("stroke-width", "2");
  terrain.setAttribute("fill", "none");
  chart.appendChild(terrain);

  // C1 y C4 comparten exactamente el mismo color y trazo (son los dos
  // contactos parciales) con un 50% de opacidad; Máx. (CM) queda con su
  // propio estilo, opaco, para distinguirse de ambas.
  const lineStyleMap = {
    C1: { stroke: "#6f6c63", dash: "3 3", opacity: "0.5" },
    CM: { stroke: "#8f8b7f", dash: "4 3", opacity: "1" },
    C4: { stroke: "#6f6c63", dash: "3 3", opacity: "0.5" }
  };

  data.moments.forEach((moment) => {
    const pathPoints = data.distances.map((d, i) => ({ x: d, y: moment.lineElev[i] }));
    const line = document.createElementNS(ns, "path");
    const style = lineStyleMap[moment.id] || lineStyleMap.CM;
    line.setAttribute("d", buildVisibilityPath(pathPoints, xScale, yScale));
    line.setAttribute("stroke", style.stroke);
    line.setAttribute("stroke-width", "1.8");
    line.setAttribute("stroke-dasharray", style.dash);
    line.setAttribute("stroke-opacity", style.opacity);
    line.setAttribute("fill", "none");
    chart.appendChild(line);
  });

  const observer = document.createElementNS(ns, "circle");
  observer.setAttribute("cx", String(xScale(0)));
  observer.setAttribute("cy", String(yScale(data.observerAlt)));
  observer.setAttribute("r", "4");
  observer.setAttribute("fill", "#a8a396");
  chart.appendChild(observer);

  const momentLabelsSorted = [...data.moments]
    .map((m) => ({ ...m, endY: yScale(m.lineEndElev) }))
    .sort((a, b) => a.endY - b.endY);

  momentLabelsSorted.forEach((moment, idx) => {
    const sunStyle = lineStyleMap[moment.id] || lineStyleMap.CM;
    const sun = document.createElementNS(ns, "circle");
    sun.setAttribute("cx", String(xScale(data.maxDistanceM)));
    sun.setAttribute("cy", String(moment.endY));
    sun.setAttribute("r", "3.8");
    sun.setAttribute("fill", "#e0ac5c");
    sun.setAttribute("fill-opacity", sunStyle.opacity);
    chart.appendChild(sun);

    const label = document.createElementNS(ns, "text");
    const yOffset = idx * 10;
    label.setAttribute("x", String(xScale(data.maxDistanceM) - 24));
    label.setAttribute("y", String(moment.endY - 4 - yOffset));
    label.setAttribute("text-anchor", "end");
    label.setAttribute("font-size", "9");
    label.setAttribute("fill", "#8b8779");
    label.textContent = moment.label;
    chart.appendChild(label);
  });

  const blockedMoments = data.moments.filter((m) => m.minClearanceM < 0).map((m) => m.label);
  summary.textContent = blockedMoments.length === 0
    ? "El eclipse es visible desde este punto en C1, Máx. y C4."
    : `El relieve bloquea la visibilidad en ${blockedMoments.join(", ")}.`;

  note.textContent = "";
}

async function updateVisibilityProfile(contacts, lat, lon, observerAlt) {
  const requestId = ++visibilityProfileRequestId;
  if (!contacts || contacts.c1 === null || contacts.c4 === null) {
    const wrap = $("visibility-profile");
    if (wrap) wrap.hidden = true;
    return;
  }

  const moments = buildVisibilityMoments(contacts, lat, lon);
  if (!moments.length) {
    renderVisibilityProfileUnavailable("Perfil no disponible para esta ubicación.");
    return;
  }

  const key = profileKey(lat, lon, moments, observerAlt);
  if (visibilityProfileCache.has(key)) {
    if (requestId !== visibilityProfileRequestId) return;
    renderVisibilityProfile(visibilityProfileCache.get(key));
    return;
  }

  renderVisibilityProfileUnavailable("Calculando perfil de visibilidad...");

  const distances = [];
  const step = VIS_PROFILE_MAX_DISTANCE_M / (VIS_PROFILE_SAMPLE_COUNT - 1);
  for (let i = 0; i < VIS_PROFILE_SAMPLE_COUNT; i += 1) {
    const d = i * step;
    distances.push(d);
  }

  const pointsByMoment = moments.map((moment) => distances.map((d) => (
    d === 0 ? { lat, lon } : destinationPoint(lat, lon, moment.geo.az, d)
  )));
  const allPoints = pointsByMoment.flat();

  try {
    const terrainAll = await fetchTerrainProfile(allPoints);
    if (requestId !== visibilityProfileRequestId) return;

    const momentPayloads = moments.map((moment, idx) => {
      const start = idx * VIS_PROFILE_SAMPLE_COUNT;
      const end = start + VIS_PROFILE_SAMPLE_COUNT;
      const terrain = terrainAll.slice(start, end);
      const lineElev = distances.map((d) => observerAlt + Math.tan(moment.geo.alt * D2R) * d);
      const clearance = terrain.map((e, i) => lineElev[i] - e);
      return {
        id: moment.id,
        label: moment.label,
        azDeg: moment.geo.az,
        altDeg: moment.geo.alt,
        terrainElev: terrain,
        lineElev,
        lineEndElev: lineElev[lineElev.length - 1],
        minClearanceM: Math.min(...clearance)
      };
    });

    const primaryMomentIndex = Math.max(0, momentPayloads.findIndex((m) => m.id === "CM"));

    const payload = {
      distances,
      observerAlt,
      moments: momentPayloads,
      primaryMomentIndex,
      maxDistanceM: VIS_PROFILE_MAX_DISTANCE_M,
      lastUpdatedMs: Date.now()
    };

    visibilityProfileCache.set(key, payload);
    if (visibilityProfileCache.size > 10) {
      const firstKey = visibilityProfileCache.keys().next().value;
      visibilityProfileCache.delete(firstKey);
    }

    renderVisibilityProfile(payload);
  } catch (_) {
    if (requestId !== visibilityProfileRequestId) return;
    renderVisibilityProfileUnavailable("No se pudo cargar el perfil de terreno (sin conexión o servicio no disponible).");
  }
}

async function loadAlertCopyConfig() {
  if (typeof fetch !== "function") return;
  try {
    const response = await fetchWithTimeout("alerts.json", CONFIG_FETCH_TIMEOUT_MS);
    if (!response.ok) return;
    alertCopy = mergeAlertCopyConfig(await response.json());
  } catch (_) {
    alertCopy = DEFAULT_ALERT_COPY;
  }
}

function mergePaypalConfig(config) {
  if (!config || typeof config !== "object") return DEFAULT_PAYPAL_CONFIG;
  return {
    ...DEFAULT_PAYPAL_CONFIG,
    enabled: typeof config.enabled === "boolean" ? config.enabled : DEFAULT_PAYPAL_CONFIG.enabled,
    label: typeof config.label === "string" ? config.label : DEFAULT_PAYPAL_CONFIG.label,
    url: typeof config.url === "string" ? config.url.trim() : ""
  };
}

async function loadPaypalConfig() {
  if (typeof fetch !== "function") return;
  try {
    const response = await fetchWithTimeout("paypal.json", CONFIG_FETCH_TIMEOUT_MS);
    if (!response.ok) return;
    paypalConfig = mergePaypalConfig(await response.json());
  } catch (_) {
    paypalConfig = DEFAULT_PAYPAL_CONFIG;
  }
}

function eventCopy(key) {
  return alertCopy.events[key] || DEFAULT_ALERT_COPY.events[key];
}

function photoSummaryText(key) {
  return alertCopy.photoSummary.rows[key] || DEFAULT_ALERT_COPY.photoSummary.rows[key];
}

function loadAlertPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (typeof parsed.photoEnabled === "boolean") {
      state.photoEnabled = parsed.photoEnabled;
    }
  } catch (_) {
    // ignore malformed local storage
  }
}

function saveAlertPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const existing = raw ? JSON.parse(raw) : {};
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      ...existing,
      photoEnabled: state.photoEnabled
    }));
  } catch (_) {
    // ignore storage failures
  }
}

// Guarda la última ubicación válida para no depender de volver a pedirla
// (GPS) o teclearla a mano el día del eclipse.
function saveLastLocation(lat, lon, sourceLabel) {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const existing = raw ? JSON.parse(raw) : {};
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      ...existing,
      lastLat: lat,
      lastLon: lon,
      lastSourceLabel: sourceLabel || "manual",
      lastSourceKind: LOCATION_SOURCE_REAL
    }));
  } catch (_) {
    // ignore storage failures
  }
}

function clearLastLocation() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const existing = JSON.parse(raw);
    delete existing.lastLat;
    delete existing.lastLon;
    delete existing.lastSourceLabel;
    delete existing.lastSourceKind;
    localStorage.setItem(PREFS_KEY, JSON.stringify(existing));
  } catch (_) {
    // ignore storage failures
  }
}

function isLeonPresetLocation(parsed) {
  if (!parsed) return false;
  if (parsed.lastSourceKind === LOCATION_SOURCE_PRESET) return true;
  return parsed.lastSourceLabel === LEON_PRESET.sourceLabel;
}

function loadLastLocation() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (isLeonPresetLocation(parsed)) {
      clearLastLocation();
      return null;
    }
    if (typeof parsed.lastLat === "number" && typeof parsed.lastLon === "number") {
      return {
        lat: parsed.lastLat,
        lon: parsed.lastLon,
        sourceLabel: parsed.lastSourceLabel || "manual"
      };
    }
  } catch (_) {
    // ignore malformed local storage
  }
  return null;
}

function syncAlertControlsFromState() {
  const master = $("chk-photo-master");
  if (master) master.checked = state.photoEnabled;
  const photoSubsection = $("photo-subsection");
  if (photoSubsection) photoSubsection.classList.toggle("is-disabled", !state.photoEnabled);
  renderAlertSummaries();
}

function stripComputedAltitudeSuffix(sourceText) {
  if (typeof sourceText !== "string") return "";
  return sourceText.replace(/\s·\salt\s(?:n\/d|-?\d+\s*m)$/i, "");
}

function bindAlertControls() {
  const master = $("chk-photo-master");
  if (!master) return;
  master.addEventListener("change", () => {
    state.photoEnabled = !!master.checked;
    // Photo events depend on photoEnabled, so the cached event list must be
    // rebuilt to reflect the new setting (done lazily on the next tick).
    if (state.contacts) state.contacts.events = null;
    syncAlertControlsFromState();
    saveAlertPrefs();
  });
}

function poly(c, t) {
  return c[0] + c[1] * t + c[2] * t * t + c[3] * t * t * t;
}

function besselAt(t) {
  return {
    x: poly(COEFF.x, t),
    y: poly(COEFF.y, t),
    d: poly(COEFF.d, t),
    l1: poly(COEFF.l1, t),
    l2: poly(COEFF.l2, t),
    mu: poly(COEFF.mu, t)
  };
}

// Refracción atmosférica estándar (Bennett/Saemundsson): se suma a la
// altitud geométrica para mostrar altitud aparente cerca del horizonte.
function atmosphericRefractionDeg(altTrueDeg) {
  if (!Number.isFinite(altTrueDeg)) return 0;
  if (altTrueDeg < -1 || altTrueDeg > 89.9) return 0;
  const argDeg = altTrueDeg + 10.3 / (altTrueDeg + 5.11);
  const tanArg = Math.tan(argDeg * D2R);
  if (!Number.isFinite(tanArg) || Math.abs(tanArg) < 1e-6) return 0;
  return (1.02 / tanArg) / 60;
}

function sunAltAz(t, latDeg, lonEastDeg) {
  const b = besselAt(t);
  const dec = b.d * D2R;
  const lat = latDeg * D2R;
  const H = (b.mu + lonEastDeg) * D2R;

  const sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
  const altTrueDeg = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * R2D;
  const alt = altTrueDeg + atmosphericRefractionDeg(altTrueDeg);
  const azY = -Math.cos(dec) * Math.sin(H);
  const azX = Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.sin(lat) * Math.cos(H);

  let az = Math.atan2(azY, azX) * R2D;
  if (az < 0) az += 360;
  return { alt, altTrue: altTrueDeg, az };
}

function observerGeocentric(latDeg, lonEastDeg, heightM) {
  const lat = latDeg * D2R;
  const flat = 0.99664719;
  const u = Math.atan(flat * Math.tan(lat));
  const rho_sinphi1 = flat * Math.sin(u) + (heightM / 6378140) * Math.sin(lat);
  const rho_cosphi1 = Math.cos(u) + (heightM / 6378140) * Math.cos(lat);
  return { rho_sinphi1, rho_cosphi1, lonEastDeg };
}

function circumstances(t, obs) {
  const b = besselAt(t);
  const dRad = b.d * D2R;
  const H = (b.mu + obs.lonEastDeg) * D2R;
  const xi = obs.rho_cosphi1 * Math.sin(H);
  const eta = obs.rho_sinphi1 * Math.cos(dRad) - obs.rho_cosphi1 * Math.cos(H) * Math.sin(dRad);
  const zeta = obs.rho_sinphi1 * Math.sin(dRad) + obs.rho_cosphi1 * Math.cos(H) * Math.cos(dRad);
  const u = b.x - xi;
  const v = b.y - eta;
  const L1 = b.l1 - zeta * TAN_F1;
  const L2 = b.l2 - zeta * TAN_F2;
  const m = Math.sqrt(u * u + v * v);
  return { m, L1, L2, u, v, zeta };
}

function findRoot(f, tlo, thi) {
  let flo = f(tlo);
  let fhi = f(thi);
  if (flo * fhi > 0) return null;

  for (let i = 0; i < 80; i += 1) {
    const tmid = (tlo + thi) / 2;
    const fmid = f(tmid);
    if (Math.abs(thi - tlo) < 1e-9) return tmid;
    if (flo * fmid <= 0) {
      thi = tmid;
      fhi = fmid;
    } else {
      tlo = tmid;
      flo = fmid;
    }
  }
  return (tlo + thi) / 2;
}

function computeContacts(latDeg, lonEastDeg, heightM) {
  const obs = observerGeocentric(latDeg, lonEastDeg, heightM);
  const fm1 = (t) => {
    const c = circumstances(t, obs);
    return c.m - c.L1;
  };
  const fm2 = (t) => {
    const c = circumstances(t, obs);
    return c.m - Math.abs(c.L2);
  };

  const step = 0.00125;
  let f1roots = [];
  let f2roots = [];
  const pushRoot = (roots, root) => {
    if (root === null) return;
    const last = roots[roots.length - 1];
    if (last === undefined || Math.abs(root - last) > 1e-5) roots.push(root);
  };
  let prevT = -3;
  let prevF1 = fm1(prevT);
  let prevF2 = fm2(prevT);

  for (let t = -3 + step; t <= 3; t += step) {
    const f1 = fm1(t);
    const f2 = fm2(t);
    if (prevF1 === 0) pushRoot(f1roots, prevT);
    else if (prevF1 * f1 < 0) pushRoot(f1roots, findRoot(fm1, prevT, t));
    if (prevF2 === 0) pushRoot(f2roots, prevT);
    else if (prevF2 * f2 < 0) pushRoot(f2roots, findRoot(fm2, prevT, t));
    prevT = t;
    prevF1 = f1;
    prevF2 = f2;
  }

  const res = { c1: null, c2: null, c3: null, c4: null, total: false, obs };
  if (f1roots.length >= 2) {
    res.c1 = f1roots[0];
    res.c4 = f1roots[f1roots.length - 1];
  }
  if (f2roots.length >= 2) {
    res.c2 = f2roots[0];
    res.c3 = f2roots[f2roots.length - 1];
    res.total = true;
  }
  return res;
}

function tToDate(tTDT) {
  // baseUTC ya es el instante UTC de t0 (18:00:00 TDT − ΔT). tTDT es una
  // DURACION transcurrida desde t0, y una duración vale lo mismo en TDT que
  // en UT (solo cambia la época/lectura del reloj, no el ritmo). Por tanto
  // se suma tal cual, sin restar ΔT una segunda vez.
  const baseUTC = Date.UTC(2026, 7, 12, T0_TDT, 0, 0) - DELTA_T * 1000;
  return new Date(baseUTC + tTDT * 3600 * 1000);
}

// Antes se forzaba "Europe/Madrid" (fmtMadrid), pero la totalidad del 12 de
// agosto de 2026 también cruza Groenlandia e Islandia: alguien viendo el
// eclipse desde allí vería su hora local mal etiquetada como CEST. Usamos la
// zona horaria real del dispositivo (la que ya usa Intl por defecto).
function fmtLocal(date) {
  return new Intl.DateTimeFormat("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function localTZLabel() {
  try {
    const parts = new Intl.DateTimeFormat("es-ES", { timeZoneName: "short" }).formatToParts(new Date());
    const tz = parts.find((p) => p.type === "timeZoneName");
    if (tz && tz.value) return tz.value;
  } catch (_) {
    // fall through
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "hora local";
  } catch (_) {
    return "hora local";
  }
}

function resetAlerts() {
  state.alertsFired = {};
  state.prevTickTUTC = null;
  clearSpeechQueue();
  clearAlertDisplayQueue();
}

function setLocStatus(msg, cls) {
  const el = $("loc-status");
  el.textContent = msg;
  el.className = `coord-status${cls ? ` ${cls}` : ""}`;
}

function setOfflineStatus(msg, cls, timeoutMs = 0) {
  const el = $("offline-status");
  if (!el) return;
  if (offlineStatusTimeout) {
    clearTimeout(offlineStatusTimeout);
    offlineStatusTimeout = null;
  }
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    el.className = "offline-status";
    return;
  }
  el.textContent = msg;
  el.className = `offline-status${cls ? ` ${cls}` : ""}`;
  el.hidden = false;
  if (timeoutMs > 0) {
    offlineStatusTimeout = setTimeout(() => {
      offlineStatusTimeout = null;
      setOfflineStatus("");
    }, timeoutMs);
  }
}

let clockStatusTimeout = null;
function setClockStatus(msg, cls, timeoutMs = 0) {
  const el = $("clock-status");
  if (!el) return;
  if (clockStatusTimeout) {
    clearTimeout(clockStatusTimeout);
    clockStatusTimeout = null;
  }
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    el.className = "offline-status";
    return;
  }
  el.textContent = msg;
  el.className = `offline-status${cls ? ` ${cls}` : ""}`;
  el.hidden = false;
  if (timeoutMs > 0) {
    clockStatusTimeout = setTimeout(() => {
      clockStatusTimeout = null;
      setClockStatus("");
    }, timeoutMs);
  }
}

function setHemiButton(btn, value, defaultValue) {
  btn.dataset.value = value;
  btn.textContent = value;
  btn.setAttribute("aria-pressed", value !== defaultValue ? "true" : "false");
}

function setupHemiToggle(btnId, pair) {
  const btn = $(btnId);
  setHemiButton(btn, btn.dataset.value || pair[0], pair[0]);
  btn.addEventListener("click", () => {
    const next = btn.dataset.value === pair[0] ? pair[1] : pair[0];
    setHemiButton(btn, next, pair[0]);
    markManualLocationInput();
  });
}

function markManualLocationInput() {
  state.locationSourceKind = LOCATION_SOURCE_REAL;
  const source = $("loc-source");
  if (source && stripComputedAltitudeSuffix(source.textContent) === LEON_PRESET.sourceLabel) {
    source.textContent = "manual";
    source.classList.remove("warn");
  }
}

function readLat() {
  const mag = Math.abs(parseDecimal($("in-lat").value));
  if (Number.isNaN(mag)) return NaN;
  return $("lat-hemi").dataset.value === "S" ? -mag : mag;
}

function readLon() {
  const mag = Math.abs(parseDecimal($("in-lon").value));
  if (Number.isNaN(mag)) return NaN;
  return $("lon-hemi").dataset.value === "O" ? -mag : mag;
}

function writeLat(val) {
  // Coma para que coincida con lo que se le pide al usuario que escriba
  // (ver parseDecimal): mismo formato al leer y al mostrar.
  $("in-lat").value = Math.abs(val).toFixed(4).replace(".", ",");
  setHemiButton($("lat-hemi"), val < 0 ? "S" : "N", "N");
}

function writeLon(val) {
  $("in-lon").value = Math.abs(val).toFixed(4).replace(".", ",");
  setHemiButton($("lon-hemi"), val < 0 ? "O" : "E", "O");
}

async function acquireWakeLock() {
  if (!("wakeLock" in navigator)) return;
  if (wakeLockRef) return;
  try {
    wakeLockRef = await navigator.wakeLock.request("screen");
    wakeLockRef.addEventListener("release", () => {
      wakeLockRef = null;
    });
  } catch (_) {
    wakeLockRef = null;
  }
}

async function releaseWakeLock() {
  if (!wakeLockRef) return;
  try {
    await wakeLockRef.release();
  } catch (_) {
    // ignore
  }
  wakeLockRef = null;
}

function applyViewportMetrics() {
  viewportUpdateFrame = null;
  const viewport = window.visualViewport;
  const height = viewport ? viewport.height : window.innerHeight;
  if (!height) return;

  document.documentElement.style.setProperty("--viewport-height", `${height}px`);
  document.body.classList.toggle("kiosk-compact-height", height <= 720);
  document.body.classList.toggle("kiosk-tight-height", height <= 640);
  document.body.classList.toggle("kiosk-ultra-height", height <= 590);
}

function queueViewportMetricsUpdate() {
  if (viewportUpdateFrame !== null) return;
  viewportUpdateFrame = requestAnimationFrame(applyViewportMetrics);
}

function updateLocateButton() {
  const btn = $("btn-locate");
  btn.disabled = state.locating;
  btn.textContent = state.locating ? "Buscando..." : "Usar mi ubicación";
}

function setSectionOpen(sectionId, isOpen) {
  const section = $(sectionId);
  if (!section) return;

  const toggle = section.querySelector(".section-toggle");
  const body = section.querySelector(".section-body");
  section.classList.toggle("is-open", isOpen);
  section.classList.toggle("is-collapsed", !isOpen);

  if (toggle) toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
  if (body) body.hidden = !isOpen;
}

function revealResultSections() {
  RESULT_SECTION_IDS.forEach((sectionId) => {
    $(sectionId).hidden = false;
  });
}

function applyPostLocationLayout(skipScroll) {
  revealResultSections();
  setSectionOpen("loc-section", false);
  COLLAPSIBLE_POST_LOCATION_IDS.forEach((sectionId) => {
    setSectionOpen(sectionId, false);
  });

  if (skipScroll) return;

  const main = $("main-section");
  if (main && !main.hidden) {
    requestAnimationFrame(() => {
      main.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
}

function cancelLocateRequest(statusMsg, statusClass) {
  if (!state.locating) return;
  state.locationRequestId += 1;
  state.locating = false;
  updateLocateButton();
  if ($("loc-source").textContent === "buscando...") {
    $("loc-source").textContent = "sin ubicación";
  }
  if (statusMsg) {
    setLocStatus(statusMsg, statusClass);
  }
}

function isLikelyIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function requestCurrentPosition(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

function applyGeolocationPosition(pos, sourcePrefix) {
  state.lat = pos.coords.latitude;
  state.lon = pos.coords.longitude;
  state.locationSourceKind = LOCATION_SOURCE_REAL;
  writeLat(state.lat);
  writeLon(state.lon);

  const accuracy = Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null;
  const source = $("loc-source");
  source.textContent = accuracy === null ? sourcePrefix : `${sourcePrefix} · ±${accuracy} m`;
  source.classList.remove("warn");
  if (accuracy !== null && accuracy > 100) {
    setLocStatus("GPS con precisión baja. Revisa coordenadas si estás cerca del límite de totalidad.", "warn");
  } else {
    setLocStatus("Ubicación obtenida.", "ok");
  }
}

function handleLocateError(err) {
  const iosHint = "Ubicación bloqueada. Actívala en Ajustes > Privacidad y seguridad > Localización para este navegador, y recarga.";

  if (isLikelyIOS() && err && err.code === 1) {
    setLocStatus(iosHint, "err");
  } else if (err && err.code === 1) {
    setLocStatus("Bloqueada por el navegador. Usa coordenadas manuales o 'León'.", "err");
  } else if (err && err.code === 3) {
    setLocStatus("GPS tardó demasiado. Prueba de nuevo o usa coordenadas manuales.", "err");
  } else {
    setLocStatus("No se pudo obtener la ubicación. Introduce coordenadas a mano.", "err");
  }
  $("loc-source").textContent = "sin ubicación";
}

function locateUser() {
  if (!navigator.geolocation) {
    setLocStatus("Sin geolocalización. Introduce coordenadas a mano.", "err");
    return;
  }
  if (state.locating) return;

  const requestId = ++state.locationRequestId;
  state.locating = true;
  updateLocateButton();
  setLocStatus("Buscando señal GPS...");
  $("loc-source").textContent = "buscando...";

  requestCurrentPosition({ enableHighAccuracy: true, timeout: 12000, maximumAge: 10000 })
    .catch((err) => {
      if (requestId !== state.locationRequestId) throw err;
      if (!err || err.code === 1) throw err;
      setLocStatus("Señal GPS débil. Probando ubicación aproximada...", "warn");
      return requestCurrentPosition({ enableHighAccuracy: false, timeout: 6000, maximumAge: 600000 });
    })
    .then((pos) => {
      if (requestId !== state.locationRequestId) return;
      state.locating = false;
      updateLocateButton();

      applyGeolocationPosition(pos, "GPS");
      recalc();
    })
    .catch((err) => {
      if (requestId !== state.locationRequestId) return;
      state.locating = false;
      updateLocateButton();
      handleLocateError(err);
    });
}

function restoreLastLocation() {
  const saved = loadLastLocation();
  if (!saved) return;

  writeLat(saved.lat);
  writeLon(saved.lon);
  state.locationSourceKind = LOCATION_SOURCE_REAL;
  $("loc-source").textContent = saved.sourceLabel;
  $("loc-source").classList.remove("warn");
  setLocStatus("Última ubicación guardada recuperada. Recalculando...", "ok");
  // No pedimos permisos de audio/notificaciones aquí: no es un gesto de
  // usuario real, así que en iOS no serviría de nada intentarlo en
  // silencio. En su lugar, si de verdad hace falta un gesto, mostramos un
  // botón para que el usuario lo dé explícitamente.
  recalc({ skipScroll: true });
  if (audioChannelsNeedRealGesture()) {
    showAudioArmBanner();
  }
}

async function recalc(options = {}) {
  cancelLocateRequest("Usando coordenadas actuales.", "ok");

  const lat = readLat();
  const lon = readLon();

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    setLocStatus("Introduce latitud y longitud válidas.", "err");
    return;
  }

  const sourceEl = $("loc-source");
  const sourceBase = stripComputedAltitudeSuffix(sourceEl?.textContent || "") || "manual";
  const altitudeRequestId = ++state.altitudeRequestId;
  setLocStatus("Actualizando cálculo...", "");

  // Perfil lunar y altitud se consultan en paralelo para reducir latencia.
  const altitudePromise = fetchAltitudeMeters(lat, lon)
    .then((value) => ({ ok: true, value }))
    .catch(() => ({ ok: false, value: 0 }));
  const lunarProfilePromise = resolveLunarProfileContacts(lat, lon);

  const altitudeResult = await altitudePromise;
  let alt = altitudeResult.value;
  const altitudeResolved = altitudeResult.ok;

  if (altitudeRequestId !== state.altitudeRequestId) return;

  state.lat = lat;
  state.lon = lon;
  state.alt = alt;
  state.contacts = computeContacts(lat, lon, alt);
  const lunarProfile = await lunarProfilePromise;
  if (altitudeRequestId !== state.altitudeRequestId) return;
  state.lunarProfileApplied = !!lunarProfile.applied;
  if (lunarProfile.applied) {
    state.contacts.c1 = lunarProfile.contacts.c1;
    state.contacts.c2 = lunarProfile.contacts.c2;
    state.contacts.c3 = lunarProfile.contacts.c3;
    state.contacts.c4 = lunarProfile.contacts.c4;
    state.contacts.total = state.contacts.c2 !== null && state.contacts.c3 !== null;
  }
  state.contacts.sunset = computeSunsetDuringEclipse(state.contacts, lat, lon);

  if (sourceEl) {
    sourceEl.classList.toggle("warn", !altitudeResolved || !lunarProfile.applied);
    sourceEl.textContent = sourceBase;
  }
  if (altitudeResolved && lunarProfile.applied) {
    setLocStatus("Cálculo actualizado.", "ok");
  } else if (altitudeResolved && lunarProfile.available && !lunarProfile.applied) {
    setLocStatus("Cálculo actualizado. Perfil lunar fuera de cobertura local.", "warn");
  } else if (altitudeResolved) {
    setLocStatus("Cálculo actualizado. Perfil lunar no disponible.", "warn");
  } else if (lunarProfile.applied) {
    setLocStatus("Cálculo actualizado. Altitud no disponible (se usa 0 m).", "warn");
  } else {
    setLocStatus("Cálculo aproximado: sin altitud y sin perfil lunar.", "warn");
  }

  state.contacts.events = buildTimedEvents(state.contacts);
  state.testMode = false;
  state.testStartWallMs = null;
  state.testStartVirtualT = null;
  resetAlerts();

  $("test-status").textContent = "Inactivo.";
  if (["sin ubicación", "buscando..."].includes($("loc-source").textContent)) {
    $("loc-source").textContent = "manual";
  }

  if (state.locationSourceKind === LOCATION_SOURCE_REAL) {
    saveLastLocation(lat, lon, sourceBase);
  } else {
    clearLastLocation();
  }
  saveAlertPrefs();
  renderContacts();
  updateVisibilityProfile(state.contacts, lat, lon, alt);
  updateAlertReadiness();
  applyPostLocationLayout(!!options.skipScroll);

  acquireWakeLock();
  restartLoop();
  if (audioChannelsNeedRealGesture()) showAudioArmBanner();
}

// Heurística simple: si el Sol está bajo el horizonte tanto al principio
// como al final del evento, lo más probable es que todo el eclipse ocurra
// de noche en estas coordenadas (no cubre el caso de que salga o se ponga
// a mitad del evento, pero para eso ya se muestra alt/az en cada contacto).
function eclipseMostlyBelowHorizon(c) {
  if (c.c1 === null || c.c4 === null) return false;
  const altStart = sunAltAz(c.c1, state.lat, state.lon).alt;
  const altEnd = sunAltAz(c.c4, state.lat, state.lon).alt;
  return altStart <= 0 && altEnd <= 0;
}

function computeSunsetDuringEclipse(c, lat, lon) {
  if (!c || c.c1 === null || c.c4 === null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  // Ocaso oficial: el borde superior del Sol toca el horizonte. Como
  // sunAltAz() devuelve la altitud aparente del centro solar, el umbral
  // correcto es el semidiámetro solar por debajo del horizonte.
  const sunsetThreshold = -SUN_SEMI_DIAMETER_DEG;
  const altStart = sunAltAz(c.c1, lat, lon).alt;
  const altEnd = sunAltAz(c.c4, lat, lon).alt;
  if (!(altStart > sunsetThreshold && altEnd <= sunsetThreshold)) return null;

  return findRoot((t) => sunAltAz(t, lat, lon).alt - sunsetThreshold, c.c1, c.c4);
}

function visibleEndTime(c) {
  if (!c || c.c4 === null) return null;
  if (c.sunset === null || c.sunset === undefined) return c.c4;
  if (c.c1 === null) return c.c4;
  if (c.sunset <= c.c1) return null;
  return Math.min(c.c4, c.sunset);
}

function hasSunsetDuringEclipse(c) {
  return Boolean(c && c.c1 !== null && c.c4 !== null && c.sunset !== null && c.sunset !== undefined && c.sunset > c.c1 && c.sunset < c.c4);
}

function sunsetBeforeContactStart(c) {
  return Boolean(c && c.c1 !== null && c.sunset !== null && c.sunset !== undefined && c.sunset <= c.c1);
}

function formatDurationClock(durationSec) {
  const sec = Math.max(0, Math.round(durationSec));
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min} min ${rem} s`;
}

function renderContacts() {
  const c = state.contacts;
  if (!c) return;

  const contactsTitle = document.querySelector("#contacts-section .section-title");
  if (contactsTitle) contactsTitle.textContent = `Contactos (${localTZLabel()})`;

  const list = $("contacts-list");
  list.replaceChildren();
  activeRowNodes = null; // las filas de abajo son nodos nuevos; invalida la caché de updateActiveRows

  const rows = [
    { tag: "C1", desc: "Inicio eclipse", t: c.c1 },
    { tag: "C2", desc: "Inicio totalidad", t: c.c2 },
    { tag: "C3", desc: "Fin totalidad", t: c.c3 },
    { tag: "C4", desc: "Fin eclipse", t: c.c4 }
  ];

  rows.forEach((r) => {
    const div = document.createElement("div");
    div.className = `contact${r.t === null ? " na" : ""}`;
    div.id = `row-${r.tag}`;
    const tag = document.createElement("div");
    tag.className = "tag";
    tag.textContent = r.tag;
    const desc = document.createElement("div");
    desc.className = "desc";
    desc.textContent = r.desc;
    const time = document.createElement("div");
    time.className = "time";
    time.textContent = r.t !== null ? fmtLocal(tToDate(r.t)) : "No visible aquí";
    div.append(tag, desc, time);
    list.appendChild(div);

    if (r.t !== null) {
      const geo = sunAltAz(r.t, state.lat, state.lon);
      const geoDiv = document.createElement("div");
      geoDiv.className = "contact-geo";
      geoDiv.id = `geo-${r.tag}`;
      geoDiv.textContent = `Alt ${geo.alt.toFixed(1)}° · Az ${geo.az.toFixed(1)}°`;
      list.appendChild(geoDiv);
    }
  });

  const note = $("duration-note");
  if (c.c1 === null) {
    const line = document.createElement("div");
    line.textContent = "No visible desde estas coordenadas: fuera de la franja del eclipse.";
    note.replaceChildren(line, createCopyTimesButton());
  } else {
    const totalDurSec = (c.c4 - c.c1) * 3600;
    const visEnd = visibleEndTime(c);
    const visibleDurSec = visEnd !== null ? (visEnd - c.c1) * 3600 : null;
    const fields = [];
    if (c.total) {
      const durSec = (c.c3 - c.c2) * 3600;
      fields.push({ title: "Totalidad", value: formatDurationClock(durSec), primary: true });
      fields.push({ title: "Eclipse completo (parcial + total)", value: formatDurationClock(totalDurSec) });
    } else {
      fields.push({ title: "Solo parcial (fuera de la franja de totalidad)", value: formatDurationClock(totalDurSec) });
    }
    if (hasSunsetDuringEclipse(c)) {
      fields.push({ title: "Ocaso del Sol", value: fmtLocal(tToDate(c.sunset)), warning: true });
      if (visibleDurSec !== null) {
        fields.push({ title: "Duración visible hasta ocaso", value: formatDurationClock(visibleDurSec) });
      }
    } else if (sunsetBeforeContactStart(c)) {
      fields.push({ title: "Ocaso del Sol", value: fmtLocal(tToDate(c.sunset)), warning: true });
      fields.push({ title: "Visibilidad", value: "El Sol se pone antes de C1; no habrá eclipse visible desde aquí.", warning: true });
    }
    const nodes = fields.map((field) => createDurationLine(field));
    nodes.push(createCopyTimesButton());
    if (eclipseMostlyBelowHorizon(c)) {
      const warning = document.createElement("div");
      warning.textContent = "Aviso: el Sol está bajo el horizonte todo el evento; no se verá desde aquí.";
      nodes.push(warning);
    }
    note.replaceChildren(...nodes);
  }
}

function contactLine(label, time) {
  return `${label}: ${time !== null ? fmtLocal(tToDate(time)) : "No visible aquí"}`;
}

function durationLines(c) {
  if (!c || c.c1 === null) return ["No visible desde estas coordenadas."];

  const fullSec = (c.c4 - c.c1) * 3600;
  const lines = [];
  if (!c.total) {
    lines.push(`Duración parcial: ${formatDurationClock(fullSec)}`);
  } else {
    const totalitySec = (c.c3 - c.c2) * 3600;
    lines.push(`Totalidad: ${formatDurationClock(totalitySec)}`);
    lines.push(`Eclipse completo: ${formatDurationClock(fullSec)}`);
  }

  if (hasSunsetDuringEclipse(c)) {
    lines.push(`Ocaso del Sol: ${fmtLocal(tToDate(c.sunset))}`);
    lines.push(`Duración visible hasta ocaso: ${formatDurationClock((c.sunset - c.c1) * 3600)}`);
  } else if (sunsetBeforeContactStart(c)) {
    lines.push(`Ocaso del Sol: ${fmtLocal(tToDate(c.sunset))}`);
    lines.push(`Visibilidad: el Sol se pone antes de C1; no habrá eclipse visible desde aquí.`);
  }

  return lines;
}

function buildTimesClipboardText() {
  const c = state.contacts;
  if (!c) return "";

  const source = $("loc-source")?.textContent || "ubicación actual";
  return [
    "Eclipse solar - 12 agosto 2026",
    `Ubicación: ${source}`,
    `Zona horaria: ${localTZLabel()}`,
    contactLine("C1 inicio parcial", c.c1),
    contactLine("C2 inicio totalidad", c.c2),
    contactLine("C3 fin totalidad", c.c3),
    contactLine("C4 fin eclipse", c.c4),
    ...durationLines(c)
  ].join("\n");
}

function createDurationLine(field) {
  const div = document.createElement("div");
  div.className = "duration-line";
  if (field.primary) div.classList.add("is-primary");
  if (field.warning) div.classList.add("is-warning");

  const title = document.createElement("span");
  title.className = "duration-title";
  title.textContent = field.title;

  const value = document.createElement("span");
  value.className = "duration-value";
  value.textContent = field.value;

  div.append(title, value);
  return div;
}

function createCopyTimesButton() {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "btn-copy-times";
  btn.className = "copy-times-button";
  btn.textContent = "Copiar horarios";
  btn.addEventListener("click", () => {
    unlockAlertAudio();
    copyTimes();
  });
  return btn;
}

async function copyTextToClipboard(text) {
  if (!text) return false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // fall through to the textarea fallback
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.className = "clipboard-fallback";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch (_) {
    return false;
  } finally {
    textarea.remove();
  }
}

function flashCopyButton(message) {
  const btn = $("btn-copy-times");
  if (!btn) return;
  const original = btn.dataset.originalText || btn.textContent;
  btn.dataset.originalText = original;
  btn.textContent = message;
  setTimeout(() => {
    btn.textContent = original;
  }, 1800);
}

async function copyTimes() {
  const ok = await copyTextToClipboard(buildTimesClipboardText());
  flashCopyButton(ok ? "Copiado" : "No copiado");
}

function currentTUTC() {
  if (state.testMode && state.testStartWallMs !== null) {
    const elapsedRealSec = (Date.now() - state.testStartWallMs) / 1000;
    const elapsedVirtualHours = (elapsedRealSec * state.testSpeed) / 3600;
    return state.testStartVirtualT + elapsedVirtualHours;
  }

  const now = new Date();
  const baseUTC = Date.UTC(2026, 7, 12, T0_TDT, 0, 0) - DELTA_T * 1000;
  // Horas transcurridas desde el instante UTC de t0 = t en el dominio TDT
  // usado por los elementos besselianos (ver nota en tToDate). No se sube
  // ni resta ΔT aquí otra vez.
  return (now.getTime() - baseUTC) / 3600000;
}

function getSharedAudioContext() {
  if (!sharedAudioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    sharedAudioCtx = new Ctx();
  }
  if (sharedAudioCtx.state === "suspended") {
    sharedAudioCtx.resume().catch(() => {
      // ignore resume errors on restricted autoplay states
    });
  }
  return sharedAudioCtx;
}

// iOS/Safari solo permite crear o reanudar un AudioContext dentro de un gesto
// de usuario real (click/tap). Esta función debe llamarse de forma síncrona
// al principio de cualquier manejador de click que pueda derivar en alertas
// sonoras, para "desbloquear" el audio antes de que haga falta en tick().
function unlockAudioContext() {
  try {
    const ctx = getSharedAudioContext();
    // Reproduce un buffer silencioso de 1 frame: en iOS esto es lo que de
    // verdad marca el contexto como "desbloqueado" para reproducciones
    // posteriores que no ocurran dentro de un gesto de usuario.
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    if (source.start) {
      source.start(0);
    } else if (source.noteOn) {
      source.noteOn(0);
    }
    alertAudioUnlocked = true;
  } catch (_) {
    // Si el navegador no soporta AudioContext, los beeps ya fallarán en
    // silencio dentro de beep(); aquí no hay nada más que hacer.
  }
}

function beep(freq, times = 1) {
  try {
    const ctx = getSharedAudioContext();
    let t = ctx.currentTime;

    for (let i = 0; i < times; i += 1) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.start(t);
      osc.stop(t + 0.24);
      t += 0.32;
    }
  } catch (_) {
    // ignore unsupported audio context issues
  }
}

function speak(text, options = {}) {
  if (!("speechSynthesis" in window) || !text) return false;

  const synth = window.speechSynthesis;
  if (typeof synth.resume === "function") {
    synth.resume();
  }
  if (options.interrupt) {
    synth.cancel();
  } else if (synth.speaking || synth.pending) {
    return false;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "es-ES";
  utterance.rate = typeof options.rate === "number" ? options.rate : 1.0;
  synth.speak(utterance);
  return true;
}

// Chrome en Android lanza "Illegal constructor" si se usa `new Notification()`
// directamente: solo soporta notificaciones vía ServiceWorkerRegistration.
// showNotification(). Desktop y Safari sí soportan el constructor directo,
// así que lo dejamos como último recurso si no hay service worker listo.
// El beep() y la voz dependen de que la pestaña siga ejecutando JS: en
// segundo plano, Chrome/Android puede llegar a congelarla del todo. La
// notificación del sistema, en cambio, sigue sonando y vibrando aunque la
// pestaña esté congelada, porque una vez pedida al service worker la
// gestiona el propio sistema operativo. Por eso aquí se apoya el aviso
// sonoro/háptico en el propio sonido y patrón de vibración de la
// notificación (silent:false, vibrate) en vez de depender de beep()/speak().
function notify(title, body, vibrate) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  const options = { body, silent: false };
  if (Array.isArray(vibrate) && vibrate.length) options.vibrate = vibrate;

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready
      .then((reg) => reg.showNotification(title, options))
      .catch(() => {
        // Sin service worker activo todavía: no hay nada más que intentar
        // en plataformas que exigen la ruta del SW (p. ej. Android).
      });
    return;
  }

  try {
    new Notification(title, options);
  } catch (_) {
    // ignore notification failures
  }
}

// El permiso de notificaciones también debe pedirse dentro de un gesto de
// usuario. Se llama junto a unlockAudioContext() en los mismos botones.
function requestNotificationPermission() {
  if (!("Notification" in window) || Notification.permission !== "default") {
    return Promise.resolve(window.Notification ? Notification.permission : "unsupported");
  }

  if (Notification.requestPermission.length === 0) {
    try {
      return Notification.requestPermission().catch(() => Notification.permission);
    } catch (_) {
      return Promise.resolve(Notification.permission);
    }
  }

  return new Promise((resolve) => {
    try {
      Notification.requestPermission((permission) => resolve(permission));
    } catch (_) {
      resolve(Notification.permission);
    }
  });
}

function notificationPermissionLabel() {
  if (!("Notification" in window)) return "Notificaciones no disponibles";
  if (Notification.permission === "granted") return "Notificaciones activas";
  if (Notification.permission === "denied") return "Notificaciones bloqueadas";
  return "Notificaciones pendientes";
}

function alertReadinessLabel() {
  const audioReady = !alertAudioNeedsGesture();
  const notificationsGranted = !!window.Notification && window.Notification.permission === "granted";
  if (audioReady && notificationsGranted) return "Avisos preparados · sonido y notificaciones";
  if (audioReady) return "Avisos preparados · sonido";
  return "Avisos pendientes · toca Activar avisos";
}

function updateAlertReadiness() {
  const el = $("alert-readiness");
  if (!el) return;
  const ready = !alertAudioNeedsGesture();
  el.textContent = alertReadinessLabel();
  el.className = `alert-readiness${ready ? " ok" : " warn"}`;
}

function updateAlertChannelStatus() {
  const status = $("alert-channel-status");
  if (!status) return;
  const audioStatus = sharedAudioCtx && sharedAudioCtx.state === "running"
    ? "Sonido activo"
    : (alertAudioUnlocked ? "Sonido preparado" : "Sonido pendiente");
  status.textContent = `${audioStatus} · ${notificationPermissionLabel()}`;
  updateAlertReadiness();
}

function unlockAlertAudio() {
  unlockAudioContext();
  updateAlertChannelStatus();
}

// Punto único para el botón explícito de avisos. Los demás botones solo
// desbloquean audio: no pedimos notificaciones sin contexto claro.
function armAlertChannels() {
  unlockAudioContext();
  return requestNotificationPermission().then((permission) => {
    updateAlertChannelStatus();
    if (!alertAudioNeedsGesture()) hideAudioArmBanner();
    return {
      audioReady: !alertAudioNeedsGesture(),
      notificationPermission: permission
    };
  });
}

function alertAudioNeedsGesture() {
  return !alertAudioUnlocked;
}

// Solo el audio es imprescindible para no perder avisos en primer plano. Las
// notificaciones quedan como mejora opcional para no insistir al usuario si
// prefiere no conceder ese permiso.
function audioChannelsNeedRealGesture() {
  return alertAudioNeedsGesture();
}

function alertActivationMessage(result) {
  if (!result.audioReady) return "Sonido pendiente. Toca de nuevo si el navegador lo bloqueó.";
  if (result.notificationPermission === "granted") return "Sonido y notificaciones activados.";
  if (result.notificationPermission === "denied") return "Sonido activo. Notificaciones bloqueadas.";
  if (result.notificationPermission === "unsupported") return "Sonido activo. Notificaciones no disponibles.";
  return "Sonido activo. Notificaciones pendientes.";
}

function showAudioArmBanner() {
  const banner = $("audio-arm-banner");
  if (banner) banner.hidden = false;
  updateAlertChannelStatus();
}

function hideAudioArmBanner() {
  const banner = $("audio-arm-banner");
  if (banner) banner.hidden = true;
}

function hideBanner() {
  const banner = $("alert-banner");
  banner.classList.remove("show");
  banner.setAttribute("aria-hidden", "true");
}

function showCountdownFlash(num, color) {
  let flash = $("countdown-flash");
  if (!flash) {
    flash = document.createElement("div");
    flash.id = "countdown-flash";
    document.body.appendChild(flash);
  }

  flash.style.borderColor = color;
  flash.style.color = color;
  flash.textContent = String(num);
  flash.style.opacity = "1";

  if (countdownFlashTimer) {
    clearTimeout(countdownFlashTimer);
  }
  countdownFlashTimer = setTimeout(() => {
    flash.style.opacity = "0";
  }, 560);
}

function renderAlertBanner(event) {
  const banner = $("alert-banner");

  $("alert-banner-tag").textContent = event.tag;
  $("alert-banner-tag").style.color = event.color;
  $("alert-banner-text").textContent = event.text;
  banner.style.borderTopColor = event.color;
  banner.classList.add("show");
  banner.setAttribute("aria-hidden", "false");
}

function pumpAlertDisplayQueue() {
  if (alertDisplayActive || !alertDisplayQueue.length) return;

  const next = alertDisplayQueue.shift();
  alertDisplayActive = true;
  renderAlertBanner(next);

  if (bannerTimeout) clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => {
    hideBanner();
    alertDisplayActive = false;
    pumpAlertDisplayQueue();
  }, next.quiet ? 900 : 4200);
}

function addTimedEvent(list, key, time, payload) {
  if (time === null || Number.isNaN(time)) return;
  list.push({ key, time, ...payload });
}

// Offsets base de los avisos de filtro fotográfico. "off" = quitar el
// filtro antes de C2; "on" = volver a ponerlo después de C3.
const CONTACT_WARNING_LEAD_SEC = 60;
const PHOTO_FILTER_OFF_LEAD_SEC = 20;
const PHOTO_FILTER_ON_LAG_SEC = 20;

// Única fuente de verdad para los instantes de "quita el filtro"/"pon el
// filtro". Antes buildTimedEvents() y checkSynchronizedCountdowns()
// calculaban estos instantes por separado con la misma fórmula duplicada:
// bastaba con tocar uno de los dos sitios para que la cuenta atrás hablada
// y el aviso real dejaran de coincidir. Ahora ambos llaman a esta función.
function photoFilterTimes(c) {
  if (c.c2 === null || c.c3 === null) return { off: null, on: null };
  return {
    off: c.c2 - PHOTO_FILTER_OFF_LEAD_SEC / 3600 + SAFETY_MARGIN_HOURS,
    on: c.c3 + PHOTO_FILTER_ON_LAG_SEC / 3600 - SAFETY_MARGIN_HOURS
  };
}

function formatRelativeContactTime(contact, seconds) {
  if (seconds === 0) return contact;
  const sign = seconds < 0 ? "-" : "+";
  return `${contact} ${sign} ${Math.abs(seconds)}s`;
}

function formatRelativeRange(contact, startSec, endSec) {
  const sign = startSec < 0 ? "-" : "+";
  return `${contact} ${sign} ${Math.abs(startSec)}..${Math.abs(endSec)}s`;
}

function appendAlertSummaryRow(parent, timeLabel, title) {
  const row = document.createElement("div");
  row.className = "alerts-mini-row";

  const time = document.createElement("span");
  time.className = "alerts-row-time";
  time.textContent = timeLabel;

  const label = document.createElement("span");
  label.className = "alerts-row-title";
  label.textContent = title;

  row.append(time, label);
  parent.appendChild(row);
}

function renderAlertSummaries() {
  const photoEvents = $("photo-events");
  if (!photoEvents) return;

  photoEvents.replaceChildren();

  const filterOffSec = PHOTO_FILTER_OFF_LEAD_SEC - SAFETY_MARGIN_SEC;
  const filterOnSec = PHOTO_FILTER_ON_LAG_SEC - SAFETY_MARGIN_SEC;

  appendAlertSummaryRow(photoEvents, formatRelativeContactTime("C2", -270), photoSummaryText("photo-refocus"));
  appendAlertSummaryRow(photoEvents, formatRelativeContactTime("C2", -40), photoSummaryText("photo-hand"));
  appendAlertSummaryRow(photoEvents, formatRelativeRange("C2", -(filterOffSec + 5), -filterOffSec), photoSummaryText("photo-remove-countdown"));
  appendAlertSummaryRow(photoEvents, formatRelativeContactTime("C2", -filterOffSec), photoSummaryText("photo-remove-filter"));
  appendAlertSummaryRow(photoEvents, formatRelativeContactTime("C2", 8), photoSummaryText("photo-mode-totality"));
  appendAlertSummaryRow(photoEvents, formatRelativeContactTime("C3", -8), photoSummaryText("photo-mode-partial"));
  appendAlertSummaryRow(photoEvents, formatRelativeRange("C3", filterOnSec - 5, filterOnSec), photoSummaryText("photo-filter-on-countdown"));
  appendAlertSummaryRow(photoEvents, formatRelativeContactTime("C3", filterOnSec), photoSummaryText("photo-filter-on"));
}

function buildTimedEvents(c) {
  const events = [];

  addTimedEvent(events, "c1-minus-60", c.c1 !== null ? c.c1 - CONTACT_WARNING_LEAD_SEC / 3600 : null, {
    ...eventCopy("c1-minus-60"),
    color: "#e0ac5c",
    beepFreq: 760,
    beepTimes: 1,
    vibrate: [100]
  });

  addTimedEvent(events, "c1-contact", c.c1, {
    ...eventCopy("c1-contact"),
    color: "#e0ac5c",
    rate: 1.05,
    forceVoice: true,
    lateGraceSec: ALERT_MAX_LATE_SEC,
    beepFreq: 720,
    beepTimes: 2,
    vibrate: [70, 70, 70]
  });

  if (c.c2 !== null && c.c3 !== null) {
    addTimedEvent(events, "c2-minus-60", c.c2 - CONTACT_WARNING_LEAD_SEC / 3600, {
      ...eventCopy("c2-minus-60"),
      color: "#e0ac5c",
      beepFreq: 760,
      beepTimes: 1,
      vibrate: [100]
    });

    addTimedEvent(events, "glasses-off", c.c2 + SAFETY_MARGIN_HOURS, {
      ...eventCopy("glasses-off"),
      color: "#5f7a5e",
      rate: 1.05,
      forceVoice: true,
      critical: true,
      lateGraceSec: SAFETY_ALERT_MAX_LATE_SEC,
      beepFreq: 660,
      beepTimes: 2,
      vibrate: [90, 80, 90]
    });

    addTimedEvent(events, "glasses-on", c.c3 - SAFETY_MARGIN_HOURS, {
      ...eventCopy("glasses-on"),
      color: "#9c4632",
      rate: 1.05,
      forceVoice: true,
      critical: true,
      lateGraceSec: PROTECTIVE_ALERT_MAX_LATE_SEC,
      beepFreq: 460,
      beepTimes: 2,
      vibrate: [90, 80, 90]
    });

    if (state.photoEnabled) {
      addTimedEvent(events, "photo-refocus", c.c2 - 270 / 3600, {
        ...eventCopy("photo-refocus"),
        color: "#e0ac5c",
        beepFreq: 820,
        beepTimes: 1,
        vibrate: [100]
      });

      addTimedEvent(events, "photo-hand", c.c2 - 40 / 3600, {
        ...eventCopy("photo-hand"),
        color: "#e0ac5c",
        beepFreq: 860,
        beepTimes: 1,
        vibrate: [100]
      });

      const pf = photoFilterTimes(c);

      addTimedEvent(events, "photo-remove-filter", pf.off, {
        ...eventCopy("photo-remove-filter"),
        color: "#5f7a5e",
        forceVoice: true,
        critical: true,
        lateGraceSec: SAFETY_ALERT_MAX_LATE_SEC,
        beepFreq: 680,
        beepTimes: 2,
        vibrate: [90, 80, 90]
      });

      addTimedEvent(events, "photo-mode-totality", c.c2 + 8 / 3600, {
        ...eventCopy("photo-mode-totality"),
        color: "#5f7a5e",
        beepFreq: 700,
        beepTimes: 1,
        vibrate: [100]
      });

      addTimedEvent(events, "photo-mode-partial", c.c3 - 8 / 3600, {
        ...eventCopy("photo-mode-partial"),
        color: "#9c4632",
        beepFreq: 500,
        beepTimes: 1,
        vibrate: [100]
      });

      addTimedEvent(events, "photo-filter-on", pf.on, {
        ...eventCopy("photo-filter-on"),
        color: "#9c4632",
        forceVoice: true,
        critical: true,
        lateGraceSec: PROTECTIVE_ALERT_MAX_LATE_SEC,
        beepFreq: 440,
        beepTimes: 3,
        vibrate: [90, 80, 90, 80, 90]
      });
    }
  }

  addTimedEvent(events, "c4-minus-60", c.c4 !== null ? c.c4 - CONTACT_WARNING_LEAD_SEC / 3600 : null, {
    ...eventCopy("c4-minus-60"),
    color: "#9c4632",
    beepFreq: 600,
    beepTimes: 1,
    vibrate: [100]
  });

  addTimedEvent(events, "c4-contact", c.c4, {
    ...eventCopy("c4-contact"),
    color: "#9c4632",
    rate: 1.05,
    forceVoice: true,
    lateGraceSec: ALERT_MAX_LATE_SEC,
    beepFreq: 520,
    beepTimes: 2,
    vibrate: [70, 70, 70]
  });

  return events.sort((a, b) => a.time - b.time);
}

function triggerTimedEvent(event) {
  if (event.beepFreq && event.beepTimes) beep(event.beepFreq, event.beepTimes);
  if (event.vibrate && navigator.vibrate) navigator.vibrate(event.vibrate);
  notify(`Eclipse · ${event.tag}`, event.text, event.vibrate);

  if (event.voice) {
    speak(event.voice, { interrupt: !!event.forceVoice, rate: event.rate });
  }

  if (event.quiet) return;
  alertDisplayQueue.push(event);
  pumpAlertDisplayQueue();
}

function triggerCountdownSpeech(key, sec, tag, color, freq) {
  if (state.alertsFired[key]) return;
  state.alertsFired[key] = true;

  beep(freq, 1);
  if (navigator.vibrate) navigator.vibrate([40]);
  showCountdownFlash(sec, color);
}

function checkSynchronizedCountdowns(t, c) {
  if (c.c2 === null || c.c3 === null) return;

  const tAudio = t + AUDIO_ADVANCE_HOURS;

  const c2ContactSec = Math.ceil((c.c2 - tAudio) * 3600);
  if (tAudio >= c.c2 - 10 / 3600 && c2ContactSec >= 1 && c2ContactSec <= 10) {
    triggerCountdownSpeech(`core-c2-count-${c2ContactSec}`, c2ContactSec, "C2", "#e0ac5c", 740);
  }

  const c3ContactSec = Math.ceil((c.c3 - tAudio) * 3600);
  if (tAudio >= c.c3 - 10 / 3600 && c3ContactSec >= 1 && c3ContactSec <= 10) {
    triggerCountdownSpeech(`core-c3-count-${c3ContactSec}`, c3ContactSec, "C3", "#9c4632", 600);
  }

  if (!state.photoEnabled) return;

  const pf = photoFilterTimes(c);
  if (pf.off === null) return;

  const c2Sec = Math.ceil((pf.off - tAudio) * 3600);
  if (tAudio >= pf.off - 5 / 3600 && c2Sec >= 1 && c2Sec <= 5) {
    triggerCountdownSpeech(`photo-c2-count-${c2Sec}`, c2Sec, "C2", "#e0ac5c", 760);
  }

  const c3PlusSec = Math.ceil((pf.on - tAudio) * 3600);
  if (tAudio >= pf.on - 5 / 3600 && c3PlusSec >= 1 && c3PlusSec <= 5) {
    triggerCountdownSpeech(`photo-c3plus-count-${c3PlusSec}`, c3PlusSec, "C3", "#9c4632", 620);
  }
}

function checkAlerts(t, prevT, c) {
  // tick() ya garantiza c.events antes de llamar aquí.
  c.events.forEach((event) => {
    const triggerAt = event.time - AUDIO_ADVANCE_HOURS;
    const crossed = prevT === null ? t >= triggerAt : (prevT < triggerAt && t >= triggerAt);
    if (!state.alertsFired[event.key] && crossed) {
      state.alertsFired[event.key] = true;
      const lateSec = (t - triggerAt) * 3600;
      const maxLate = typeof event.lateGraceSec === "number"
        ? event.lateGraceSec
        : (event.critical ? SAFETY_ALERT_MAX_LATE_SEC : ALERT_MAX_LATE_SEC);
      if (lateSec <= maxLate) {
        triggerTimedEvent(event);
      }
    }
  });
}

function initDiskNodes() {
  const svg = $("disk-svg");
  if (diskNodes && diskNodes.svg === svg) return;

  const ns = "http://www.w3.org/2000/svg";
  svg.textContent = "";

  const defs = document.createElementNS(ns, "defs");
  const gradient = document.createElementNS(ns, "radialGradient");
  gradient.setAttribute("id", "corona");
  gradient.setAttribute("cx", "50%");
  gradient.setAttribute("cy", "50%");
  gradient.setAttribute("r", "50%");

  const stop1 = document.createElementNS(ns, "stop");
  stop1.setAttribute("offset", "70%");
  stop1.setAttribute("stop-color", "#e0ac5c");
  stop1.setAttribute("stop-opacity", "0");

  const stop2 = document.createElementNS(ns, "stop");
  stop2.setAttribute("offset", "100%");
  stop2.setAttribute("stop-color", "#e0ac5c");
  stop2.setAttribute("stop-opacity", "0.35");

  gradient.appendChild(stop1);
  gradient.appendChild(stop2);
  defs.appendChild(gradient);
  svg.appendChild(defs);

  const corona = document.createElementNS(ns, "circle");
  corona.setAttribute("cx", "90");
  corona.setAttribute("cy", "90");
  corona.setAttribute("r", String(60 * 1.45));
  corona.setAttribute("fill", "url(#corona)");
  corona.setAttribute("display", "none");

  const sun = document.createElementNS(ns, "circle");
  sun.setAttribute("cx", "90");
  sun.setAttribute("cy", "90");
  sun.setAttribute("r", "60");
  sun.setAttribute("fill", "#e0ac5c");

  const moon = document.createElementNS(ns, "circle");
  moon.setAttribute("cy", "90");
  moon.setAttribute("r", String(60 * 1.02));
  moon.setAttribute("fill", "#000000");

  const outline = document.createElementNS(ns, "circle");
  outline.setAttribute("cx", "90");
  outline.setAttribute("cy", "90");
  outline.setAttribute("r", "60");
  outline.setAttribute("fill", "none");
  outline.setAttribute("stroke", "#5c584d");
  outline.setAttribute("stroke-width", "0.5");

  svg.appendChild(corona);
  svg.appendChild(sun);
  svg.appendChild(moon);
  svg.appendChild(outline);

  diskNodes = { svg, corona, moon };
}

function drawDisk(fraction, insideTotality) {
  initDiskNodes();

  const r = 60;
  const cx = 90;
  const moonR = r * 1.02;
  const maxOffset = r + moonR;
  const minOffset = insideTotality ? 0 : Math.max(0, moonR - r) * 0.3;
  const offset = maxOffset - fraction * (maxOffset - minOffset);
  const moonX = cx + offset;

  diskNodes.moon.setAttribute("cx", String(moonX));
  diskNodes.corona.setAttribute("display", insideTotality ? "block" : "none");
}

function updateCountdown(t, c) {
  const nodes = getTickNodes();
  const events = (c.countdownEvents || (c.countdownEvents = [
    { name: "C1 · Inicio eclipse", t: c.c1 },
    { name: "C2 · Inicio totalidad", t: c.c2 },
    { name: "C3 · Fin totalidad", t: c.c3 },
    { name: "C4 · Fin eclipse", t: c.c4 }
  ].filter((e) => e.t !== null)));

  const next = events.find((e) => e.t > t);
  if (next) {
    // Use ceil to keep second transitions aligned with the device clock
    // and avoid displaying the next second too early.
    const diffSec = Math.max(0, Math.ceil((next.t - t) * 3600));
    const hh = Math.floor(diffSec / 3600);
    const mm = Math.floor((diffSec % 3600) / 60);
    const ss = diffSec % 60;
    setText(nodes.cdClock, `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`);
    setText(nodes.cdEvent, next.name);
    setText(nodes.cdLabel, "faltan");
  } else if (events.length) {
    setText(nodes.cdClock, "00:00:00");
    setText(nodes.cdEvent, "Eclipse finalizado");
    setText(nodes.cdLabel, "—");
  } else {
    nodes.cdClock.textContent = "—:—:—";
    nodes.cdEvent.textContent = "No visible: fuera de la franja del eclipse";
  }
}

// Cachea las 8 referencias (row-C1..C4, geo-C1..C4) para no hacer
// getElementById en cada tick. renderContacts() reconstruye esas filas con
// replaceChildren() en cada recálculo de ubicación, así que invalida esta
// caché ahí (activeRowNodes = null) para no quedarse con nodos obsoletos.
let activeRowNodes = null;
function getActiveRowNodes() {
  if (!activeRowNodes) {
    activeRowNodes = ["C1", "C2", "C3", "C4"].map((tag) => ({
      row: $(`row-${tag}`),
      geo: $(`geo-${tag}`)
    }));
  }
  return activeRowNodes;
}

function updateActiveRows(t, c) {
  const nodes = getActiveRowNodes();
  nodes.forEach(({ row, geo }) => {
    row?.classList.remove("active");
    geo?.classList.remove("active");
  });

  let idx = -1;
  if (c.c1 !== null && c.c2 !== null && t >= c.c1 && t < c.c2) idx = 0;
  else if (c.c2 !== null && c.c3 !== null && t >= c.c2 && t <= c.c3) idx = 1;
  else if (c.c3 !== null && c.c4 !== null && t > c.c3 && t <= c.c4) idx = 2;
  else if (c.c4 !== null && t > c.c4) idx = 3;

  if (idx >= 0) {
    nodes[idx].row?.classList.add("active");
    nodes[idx].geo?.classList.add("active");
  }
}

// Evita reescribir el DOM cuando el valor no ha cambiado (a 1-10 Hz, escribir
// siempre textContent fuerza trabajo de layout/estilo innecesario).
function setText(el, value) {
  if (el && el.textContent !== value) el.textContent = value;
}

// Segundos hasta el próximo contacto o aviso programado (o null si no queda
// ninguno). Se usa para decidir la frecuencia de refresco y para saber
// cuándo despertar/dormir el AudioContext.
function secondsToNextEvent(t, c) {
  let best = null;
  const consider = (time) => {
    if (time === null || time === undefined) return;
    const diffSec = (time - t) * 3600;
    if (diffSec >= -2 && (best === null || diffSec < best)) best = diffSec;
  };
  consider(c.c1);
  consider(c.c2);
  consider(c.c3);
  consider(c.c4);
  if (c.events) {
    c.events.forEach((e) => {
      if (!state.alertsFired[e.key]) consider(e.time);
    });
  }
  return best;
}

function desiredTickIntervalMs(secToNext) {
  if (secToNext === null) return IDLE_TICK_MS;
  if (document.visibilityState === "hidden" && secToNext > AUDIO_MEDIUM_WINDOW_SEC) {
    return BACKGROUND_TICK_MS;
  }
  if (secToNext <= AUDIO_FAST_WINDOW_SEC) return FAST_TICK_MS;
  if (secToNext <= AUDIO_MEDIUM_WINDOW_SEC) return MEDIUM_TICK_MS;
  return SLOW_TICK_MS;
}

function nextTimedEventDelayMs(t, c, maxDelayMs) {
  if (!c || !c.events) return maxDelayMs;
  let delayMs = maxDelayMs;
  c.events.forEach((event) => {
    if (state.alertsFired[event.key]) return;
    const triggerAt = event.time - AUDIO_ADVANCE_HOURS;
    const diffMs = (triggerAt - t) * 3600 * 1000;
    if (diffMs > 0 && diffMs < delayMs) {
      delayMs = Math.max(20, Math.floor(diffMs));
    }
  });
  return delayMs;
}

// Mantener el AudioContext "running" indefinidamente gasta batería aunque no
// suene nada. Lo suspendemos cuando no hay ningún evento cerca y lo
// reanudamos justo antes de que haga falta un beep.
function manageAudioContextPower(secToNext) {
  if (!sharedAudioCtx) return;
  const needsToBeAwake = secToNext !== null && secToNext <= AUDIO_SUSPEND_MARGIN_SEC;
  if (needsToBeAwake) {
    if (sharedAudioCtx.state === "suspended") {
      sharedAudioCtx.resume().catch(() => {});
    }
  } else if (sharedAudioCtx.state === "running") {
    sharedAudioCtx.suspend().catch(() => {});
  }
}

function tick() {
  const c = state.contacts;
  if (!c) return;

  const t = currentTUTC();
  const prevT = state.prevTickTUTC;
  const circ = circumstances(t, c.obs);

  if (!c.events) c.events = buildTimedEvents(c);
  const secToNext = secondsToNextEvent(t, c);
  tickIntervalMs = desiredTickIntervalMs(secToNext);
  manageAudioContextPower(secToNext);

  checkAlerts(t, prevT, c);
  checkSynchronizedCountdowns(t, c);

  let phaseText = "Sin eclipse visible aquí";
  let fraction = 0;
  let insideTotality = false;

  if (c.c1 !== null && c.c4 !== null) {
    if (t < c.c1) {
      phaseText = "Antes del eclipse";
      fraction = 0;
    } else if (c.total && t >= c.c2 && t <= c.c3) {
      phaseText = "Totalidad";
      fraction = 1;
      insideTotality = true;
    } else if (t > c.c4) {
      phaseText = "Eclipse finalizado";
      fraction = 0;
    } else {
      const L = Math.max(circ.L1, 1e-6);
      fraction = Math.min(1, Math.max(0, 1 - circ.m / L));
      phaseText = t < (c.c2 || c.c1 + (c.c4 - c.c1) / 2) ? "Fase parcial (creciente)" : "Fase parcial (menguante)";
    }
  }

  const nodes = getTickNodes();
  setText(nodes.phaseName, phaseText);
  if (nodes.phaseName) nodes.phaseName.classList.toggle("is-totality", insideTotality);
  drawDisk(fraction, insideTotality);

  let magPct = 0;
  if (c.c1 !== null && t >= c.c1 && t <= c.c4) {
    magPct = insideTotality ? 100 : Math.round(fraction * 100);
  }
  setText(nodes.magNum, `${magPct}%`);

  if (c.c1 !== null) {
    const geo = sunAltAz(t, state.lat, state.lon);
    setText(nodes.sunGeo, geo.alt > 0 ? `Alt ${geo.alt.toFixed(1)}° · Az ${geo.az.toFixed(1)}°` : "Sol bajo el horizonte");
  }

  updateCountdown(t, c);
  updateActiveRows(t, c);
  state.prevTickTUTC = t;
}

function safeTick() {
  try {
    tick();
  } catch (err) {
    // Un fallo puntual (p. ej. un DOM node inesperado) no debe congelar el
    // reloj para siempre: lo registramos y dejamos que el bucle siga.
    console.error("EclipseTimer: error en tick()", err);
  }
}

function scheduleTick() {
  let delayMs = tickIntervalMs;
  if (state.contacts) {
    if (!state.contacts.events) state.contacts.events = buildTimedEvents(state.contacts);
    delayMs = nextTimedEventDelayMs(currentTUTC(), state.contacts, tickIntervalMs);
  }
  tickTimerId = window.setTimeout(() => {
    tickTimerId = null;
    safeTick();
    if (state.contacts) scheduleTick();
  }, delayMs);
}

function startLoop() {
  if (tickTimerId) return;
  scheduleTick();
}

function restartLoop() {
  if (tickTimerId) {
    clearTimeout(tickTimerId);
    tickTimerId = null;
  }
  safeTick();
  if (state.contacts) scheduleTick();
}

function enterKiosk() {
  queueViewportMetricsUpdate();
  document.body.classList.add("kiosk");
  $("btn-exit-kiosk").hidden = false;
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
}

function exitKiosk() {
  document.body.classList.remove("kiosk");
  $("btn-exit-kiosk").hidden = true;
  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
}

function getAboutFocusableNodes() {
  return Array.from($("about-panel").querySelectorAll(
    "a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])"
  )).filter((el) => el.offsetParent !== null);
}

function bindEvents() {
  const aboutPanel = $("about-panel");
  const openAbout = () => {
    previousFocusBeforeAbout = document.activeElement;
    aboutPanel.hidden = false;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => {
      const focusTarget = $("btn-about-close") || getAboutFocusableNodes()[0] || aboutPanel;
      focusTarget.focus();
    });
  };
  const closeAbout = () => {
    aboutPanel.hidden = true;
    document.body.style.overflow = "";
    if (previousFocusBeforeAbout && typeof previousFocusBeforeAbout.focus === "function") {
      previousFocusBeforeAbout.focus();
    }
    previousFocusBeforeAbout = null;
  };
  $("btn-about").addEventListener("click", openAbout);
  $("btn-about-close").addEventListener("click", closeAbout);
  aboutPanel.addEventListener("click", (ev) => {
    if (ev.target === aboutPanel) closeAbout();
  });
  document.addEventListener("keydown", (ev) => {
    if (aboutPanel.hidden) return;
    if (ev.key === "Escape") {
      closeAbout();
      return;
    }
    if (ev.key !== "Tab") return;

    const focusable = getAboutFocusableNodes();
    if (!focusable.length) {
      ev.preventDefault();
      aboutPanel.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  });

  setupHemiToggle("lat-hemi", ["N", "S"]);
  setupHemiToggle("lon-hemi", ["O", "E"]);

  document.querySelectorAll(".section-toggle").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const sectionId = toggle.dataset.section;
      const section = $(sectionId);
      if (!section || section.hidden) return;
      setSectionOpen(sectionId, !section.classList.contains("is-open"));
    });
  });

  $("btn-locate").addEventListener("click", () => {
    unlockAlertAudio();
    locateUser();
  });
  $("btn-recalc").addEventListener("click", () => {
    unlockAlertAudio();
    recalc();
  });
  $("btn-leon").addEventListener("click", () => {
    unlockAlertAudio();
    cancelLocateRequest("Búsqueda interrumpida. Se usarán coordenadas de León.", "ok");
    state.locationSourceKind = LOCATION_SOURCE_PRESET;
    writeLat(LEON_PRESET.lat);
    writeLon(LEON_PRESET.lon);
    $("loc-source").textContent = LEON_PRESET.sourceLabel;
    $("loc-source").classList.remove("warn");
    setLocStatus("Coordenadas de León cargadas.", "ok");
    recalc();
  });

  $("btn-fullscreen").addEventListener("click", () => {
    unlockAlertAudio();
    enterKiosk();
  });
  $("btn-exit-kiosk").addEventListener("click", exitKiosk);

  const btnArmAudio = $("btn-arm-audio");
  if (btnArmAudio) {
    btnArmAudio.addEventListener("click", async () => {
      const result = await armAlertChannels();
      speak(alertActivationMessage(result), { interrupt: true });
    });
  }

  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) {
      document.body.classList.remove("kiosk");
      $("btn-exit-kiosk").hidden = true;
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (state.contacts) acquireWakeLock();
      if ("speechSynthesis" in window && typeof window.speechSynthesis.resume === "function") {
        window.speechSynthesis.resume();
      }
    } else {
      releaseWakeLock();
    }
  });

  $("alert-banner-dismiss").addEventListener("click", () => {
    if (bannerTimeout) {
      clearTimeout(bannerTimeout);
      bannerTimeout = null;
    }
    hideBanner();
    alertDisplayActive = false;
    pumpAlertDisplayQueue();
  });

  $("btn-test-voice").addEventListener("click", () => {
    unlockAlertAudio();
    if (!("speechSynthesis" in window)) {
      alert("Este navegador no soporta síntesis de voz.");
      return;
    }
    beep(700, 2);
    if (navigator.vibrate) navigator.vibrate([60, 60, 60]);
    speak("Prueba de sonido y voz. Si oyes esto, todo funciona correctamente.", { interrupt: false, priority: "normal" });
  });

  $("btn-test-start").addEventListener("click", () => {
    unlockAlertAudio();
    const c = state.contacts;
    if (!c || c.c2 === null || c.c3 === null) {
      $("test-status").textContent = "Necesita totalidad. Prueba con León: 42.5987 N / 5.5671 O.";
      return;
    }
    state.testMode = true;
    state.testSpeed = 1;
    state.testStartWallMs = Date.now();
    state.testStartVirtualT = c.c2 - 70 / 3600;
    resetAlerts();
    $("test-status").textContent = `En marcha ×${state.testSpeed}.`;
  });

  $("btn-test-stop").addEventListener("click", () => {
    state.testMode = false;
    state.testStartWallMs = null;
    state.testStartVirtualT = null;
    resetAlerts();
    $("test-status").textContent = "Inactivo.";
    hideBanner();
  });

  ["in-lat", "in-lon"].forEach((id) => {
    $(id).addEventListener("input", markManualLocationInput);
  });

  ["in-lat", "in-lon"].forEach((id) => {
    $(id).addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") recalc();
    });
  });
}

// Instalación guiada: Chrome/Android (y similares) disparan este evento; iOS
// usa el menú Compartir > Añadir a pantalla de inicio, también desde algunos
// navegadores de terceros en versiones modernas.
let deferredInstallPrompt = null;

function isStandaloneDisplay() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function showInstallHelp(message) {
  const text = $("install-help-text");
  if (text && message) text.textContent = message;
  const help = $("ios-install-help");
  if (help) help.hidden = false;
}

function hideIOSInstallHelp() {
  const help = $("ios-install-help");
  if (help) help.hidden = true;
}

function bindInstallPrompt() {
  const btn = $("btn-install");
  if (!btn) return;

  // Ya instalada (standalone): no hace falta ofrecer instalarla de nuevo.
  if (isStandaloneDisplay()) return;

  const isIOS = isLikelyIOS();
  btn.hidden = false;

  window.addEventListener("beforeinstallprompt", (ev) => {
    ev.preventDefault();
    deferredInstallPrompt = ev;
    btn.hidden = false;
  });

  // iOS no ofrece beforeinstallprompt: mostramos instrucciones manuales.
  btn.addEventListener("click", async () => {
    if (deferredInstallPrompt) {
      btn.disabled = true;
      try {
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
      } catch (_) {
        // ignore
      } finally {
        deferredInstallPrompt = null;
        btn.hidden = true;
        btn.disabled = false;
      }
      return;
    }

    if (isIOS) {
      showInstallHelp("Toca Compartir y luego «Añadir a pantalla de inicio».");
      return;
    }

    showInstallHelp("Si el aviso de instalación no aparece, usa el menú del navegador y elige «Instalar app» o «Añadir a pantalla de inicio».");
  });

  const closeHelpBtn = $("btn-ios-install-close");
  if (closeHelpBtn) {
    closeHelpBtn.addEventListener("click", hideIOSInstallHelp);
  }

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    btn.hidden = true;
  });
}

function reloadOnceForServiceWorkerVersion(version) {
  const marker = version || "unknown";
  try {
    if (sessionStorage.getItem(SW_RELOAD_KEY) === marker) return;
    sessionStorage.setItem(SW_RELOAD_KEY, marker);
  } catch (_) {
    // If sessionStorage is unavailable, reloading once on this message is
    // still preferable to leaving an old app shell running.
  }
  window.location.reload();
}

function bindServiceWorkerRefresh() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data && event.data.type === "ET_FORCE_RELOAD") {
      reloadOnceForServiceWorkerVersion(event.data.version);
    }
  });
}

function markOfflineReady() {
  try {
    if (localStorage.getItem(OFFLINE_READY_KEY) === "1") return;
    localStorage.setItem(OFFLINE_READY_KEY, "1");
  } catch (_) {
    // ignore storage failures
  }
  setOfflineStatus("Lista sin conexión.", "ok", 3600);
}

function bindNetworkStatus() {
  if ("onLine" in navigator && !navigator.onLine) {
    setOfflineStatus("Sin conexión: usando datos guardados.", "warn");
  }

  window.addEventListener("offline", () => {
    setOfflineStatus("Sin conexión: usando datos guardados.", "warn");
  });
  window.addEventListener("online", () => {
    setOfflineStatus("Conexión recuperada.", "ok", 2600);
    configureSupportButton();
    checkClockSkew();
  });
}

function isValidHttpsUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:";
  } catch (_) {
    return false;
  }
}

function configureSupportButton() {
  const section = $("support-section");
  const btn = $("btn-support");
  if (!section || !btn) return;

  const enabled = !!paypalConfig.enabled && isValidHttpsUrl(paypalConfig.url);
  section.hidden = !enabled;
  btn.hidden = !enabled;
  if (!enabled) return;

  btn.href = paypalConfig.url;
  btn.textContent = paypalConfig.label || DEFAULT_PAYPAL_CONFIG.label;
}

window.addEventListener("load", () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").then((reg) => {
      reg.update().catch(() => {});
      navigator.serviceWorker.ready.then(markOfflineReady).catch(() => {});
    }).catch(() => {
      // Ignore service worker registration failures.
    });
  }

  queueViewportMetricsUpdate();
  window.addEventListener("resize", queueViewportMetricsUpdate, { passive: true });
  window.addEventListener("orientationchange", queueViewportMetricsUpdate, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", queueViewportMetricsUpdate, { passive: true });
  }

  loadAlertPrefs();
  bindEvents();
  bindAlertControls();
  bindInstallPrompt();
  bindServiceWorkerRefresh();
  bindNetworkStatus();
  syncAlertControlsFromState();
  updateLocateButton();
  updateAlertReadiness();
  hideBanner();
  restoreLastLocation();
  configureSupportButton();

  // alerts.json y paypal.json son configuración opcional (textos de avisos,
  // botón de donación). Se cargan en paralelo y en segundo plano: la app ya
  // es interactiva con los valores por defecto, y si (cuando) llegan estos
  // ficheros, simplemente se refresca el texto correspondiente.
  loadAlertCopyConfig().then(() => renderAlertSummaries());
  loadPaypalConfig().then(() => configureSupportButton());
  checkClockSkew();
});