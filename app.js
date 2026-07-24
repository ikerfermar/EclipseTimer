"use strict";

const T0_TDT = 18.0;
const DELTA_T = 71.4;

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
// Margen de seguridad visual para los avisos de gafas y filtro fotográfico.
// Los tiempos de C2/C3 calculados tienen un error observado de hasta ~7 s
// frente a fuentes de referencia (NASA/IGN), por el perfil del limbo lunar y
// la propia precisión del cálculo. El aviso se retrasa/adelanta este margen
// respecto al contacto calculado, como sesgo intencionado hacia el lado
// seguro (se pierden unos segundos de totalidad "avisada", nunca al revés).
// AVISO: fijado a propósito en 2 s, POR DEBAJO del error máximo observado
// (~7 s). Con este valor el margen no cubre el peor caso: si el error real
// va en la dirección desfavorable, el aviso puede seguir llegando unos
// segundos antes de que la totalidad haya empezado de verdad. Si en algún
// momento se quiere una garantía real frente al peor caso medido, este valor
// debería subirse a ~7-8 s.
const SAFETY_MARGIN_SEC = 2;
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
  alt: 838,
  sourceLabel: "manual (León)"
});
const LOCATION_SOURCE_REAL = "real";
const LOCATION_SOURCE_PRESET = "preset";

const $ = (id) => document.getElementById(id);

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
    "photo-remove-filter": {
      tag: "Aviso",
      text: "Filtro fuera ahora",
      voice: "Filtro fuera ahora."
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
    title: "Avisos de fotografía",
    rows: {
      "photo-hand": "Prepara el filtro",
      "photo-remove-countdown": "Cuenta atrás filtro fuera",
      "photo-remove-filter": "Filtro fuera ahora",
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
  photoEnabled: true,
  manualOffsetSec: 0,
  testMode: false,
  testStartWallMs: null,
  testStartVirtualT: null,
  prevTickTUTC: null,
  testSpeed: 1,
  locating: false,
  locationRequestId: 0,
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

const ALERT_MAX_LATE_SEC = 0.9;
const RESULT_SECTION_IDS = ["main-section", "alerts-section", "ops-section"];
const COLLAPSIBLE_POST_LOCATION_IDS = ["alerts-section", "ops-section"];

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
      title: typeof config.photoSummary?.title === "string"
        ? config.photoSummary.title
        : DEFAULT_ALERT_COPY.photoSummary.title,
      rows: mergeStringMap(DEFAULT_ALERT_COPY.photoSummary.rows, config.photoSummary?.rows)
    }
  };
}

async function loadAlertCopyConfig() {
  if (typeof fetch !== "function") return;
  try {
    const response = await fetch("alerts.json", { cache: "no-cache" });
    if (!response.ok) return;
    alertCopy = mergeAlertCopyConfig(await response.json());
  } catch (_) {
    alertCopy = DEFAULT_ALERT_COPY;
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
    if (typeof parsed.manualOffsetSec === "number" && Number.isFinite(parsed.manualOffsetSec)) {
      state.manualOffsetSec = parsed.manualOffsetSec;
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
      photoEnabled: state.photoEnabled,
      manualOffsetSec: state.manualOffsetSec
    }));
  } catch (_) {
    // ignore storage failures
  }
}

// Guarda la última ubicación válida para no depender de volver a pedirla
// (GPS) o teclearla a mano el día del eclipse.
function saveLastLocation(lat, lon, alt, sourceLabel) {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const existing = raw ? JSON.parse(raw) : {};
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      ...existing,
      lastLat: lat,
      lastLon: lon,
      lastAlt: alt,
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
    delete existing.lastAlt;
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
        alt: typeof parsed.lastAlt === "number" ? parsed.lastAlt : 0,
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
  const offsetInput = $("in-manual-offset");
  if (offsetInput) offsetInput.value = state.manualOffsetSec;
  renderAlertSummaries();
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

function sunAltAz(t, latDeg, lonEastDeg) {
  const b = besselAt(t);
  const dec = b.d * D2R;
  const lat = latDeg * D2R;
  const H = (b.mu + lonEastDeg) * D2R;

  const sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const azY = -Math.cos(dec) * Math.sin(H);
  const azX = Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.sin(lat) * Math.cos(H);

  let az = Math.atan2(azY, azX) * R2D;
  if (az < 0) az += 360;
  return { alt: alt * R2D, az };
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

  const step = 0.0025;
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
  if (source && source.textContent === LEON_PRESET.sourceLabel) {
    source.textContent = "manual";
  }
}

function readLat() {
  const mag = Math.abs(parseFloat($("in-lat").value));
  if (Number.isNaN(mag)) return NaN;
  return $("lat-hemi").dataset.value === "S" ? -mag : mag;
}

function readLon() {
  const mag = Math.abs(parseFloat($("in-lon").value));
  if (Number.isNaN(mag)) return NaN;
  return $("lon-hemi").dataset.value === "O" ? -mag : mag;
}

function writeLat(val) {
  $("in-lat").value = Math.abs(val).toFixed(4);
  setHemiButton($("lat-hemi"), val < 0 ? "S" : "N", "N");
}

function writeLon(val) {
  $("in-lon").value = Math.abs(val).toFixed(4);
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

function isLikelySafariIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) && /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
}

function requestCurrentPosition(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

function applyGeolocationPosition(pos, sourcePrefix) {
  state.lat = pos.coords.latitude;
  state.lon = pos.coords.longitude;
  state.alt = pos.coords.altitude || 0;
  state.locationSourceKind = LOCATION_SOURCE_REAL;
  writeLat(state.lat);
  writeLon(state.lon);
  $("in-alt").value = Math.round(state.alt);

  const accuracy = Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null;
  $("loc-source").textContent = accuracy === null ? sourcePrefix : `${sourcePrefix} · ±${accuracy} m`;
  if (accuracy !== null && accuracy > 100) {
    setLocStatus("GPS con precisión baja. Revisa coordenadas si estás cerca del límite de totalidad.", "warn");
  } else {
    setLocStatus("Ubicación obtenida.", "ok");
  }
}

function handleLocateError(err) {
  const safariHint = "Ubicación bloqueada. Actívala en Ajustes > Privacidad y seguridad > Localización > Safari, y recarga.";

  if (isLikelySafariIOS()) {
    setLocStatus(safariHint, "err");
  } else if (err && err.code === 1) {
    setLocStatus("Bloqueada por el navegador. Usa coordenadas manuales o 'León'.", "err");
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
  $("in-alt").value = Math.round(saved.alt);
  state.locationSourceKind = LOCATION_SOURCE_REAL;
  $("loc-source").textContent = saved.sourceLabel;
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

function recalc(options = {}) {
  cancelLocateRequest("Usando coordenadas actuales.", "ok");

  const lat = readLat();
  const lon = readLon();
  const alt = parseFloat($("in-alt").value) || 0;

  if (Number.isNaN(lat) || Number.isNaN(lon)) {
    setLocStatus("Introduce latitud y longitud válidas.", "err");
    return;
  }

  state.lat = lat;
  state.lon = lon;
  state.alt = alt;
  state.contacts = computeContacts(lat, lon, alt);

  // Corrección opcional (perfil del limbo lunar / fuente más precisa
  // para esta ubicación, p. ej. el mapa interactivo de Xavier Jubier). Se
  // aplica solo a C2/C3, que son los contactos sensibles a la forma real
  // del borde lunar; C1/C4 se dejan tal cual los da el cálculo besseliano.
  const offsetInput = $("in-manual-offset");
  const offsetSec = offsetInput ? (parseFloat(offsetInput.value) || 0) : 0;
  state.manualOffsetSec = offsetSec;
  if (offsetSec !== 0) {
    const offsetHours = offsetSec / 3600;
    if (state.contacts.c2 !== null) state.contacts.c2 += offsetHours;
    if (state.contacts.c3 !== null) state.contacts.c3 += offsetHours;
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
    saveLastLocation(lat, lon, alt, $("loc-source").textContent);
  } else {
    clearLastLocation();
  }
  saveAlertPrefs();
  renderContacts();
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
  return altStart <= -1 && altEnd <= -1;
}

function renderContacts() {
  const c = state.contacts;
  if (!c) return;

  const contactsTitle = document.querySelector("#contacts-section .section-title");
  if (contactsTitle) contactsTitle.textContent = `Contactos (${localTZLabel()})`;

  const list = $("contacts-list");
  list.replaceChildren();

  const rows = [
    { tag: "C1", desc: "Inicio parcial", t: c.c1 },
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
      geoDiv.textContent = `Alt ${geo.alt.toFixed(3)}° · Az ${geo.az.toFixed(3)}°`;
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
    const totalMin = Math.floor(totalDurSec / 60);
    const totalS = Math.round(totalDurSec % 60);
    const lines = [];
    if (c.total) {
      const durSec = (c.c3 - c.c2) * 3600;
      const mm = Math.floor(durSec / 60);
      const ss = Math.round(durSec % 60);
      lines.push(`Totalidad: ${mm} min ${ss} s.`);
      lines.push(`Eclipse completo (parcial + total): ${totalMin} min ${totalS} s.`);
    } else {
      lines.push(`Fuera de la franja de totalidad: solo parcial · Duración: ${totalMin} min ${totalS} s.`);
    }
    const nodes = lines.map((line) => {
      const div = document.createElement("div");
      div.textContent = line;
      return div;
    });
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
  const fullMin = Math.floor(fullSec / 60);
  const fullS = Math.round(fullSec % 60);
  if (!c.total) return [`Duración parcial: ${fullMin} min ${fullS} s`];

  const totalitySec = (c.c3 - c.c2) * 3600;
  const totalityMin = Math.floor(totalitySec / 60);
  const totalityS = Math.round(totalitySec % 60);
  return [
    `Totalidad: ${totalityMin} min ${totalityS} s`,
    `Eclipse completo: ${fullMin} min ${fullS} s`
  ];
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
function notify(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.ready
      .then((reg) => reg.showNotification(title, { body }))
      .catch(() => {
        // Sin service worker activo todavía: no hay nada más que intentar
        // en plataformas que exigen la ruta del SW (p. ej. Android).
      });
    return;
  }

  try {
    new Notification(title, { body });
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

// Offsets base de los avisos de filtro fotográfico (antes de aplicar el
// margen de seguridad). "off" = quitar el filtro antes de C2; "on" = volver
// a ponerlo después de C3.
const CONTACT_WARNING_LEAD_SEC = 60;
const PHOTO_FILTER_OFF_LEAD_SEC = 20;
const PHOTO_FILTER_ON_LAG_SEC = 15;

// Única fuente de verdad para los instantes de "quita el filtro"/"pon el
// filtro". Antes buildTimedEvents() y checkSynchronizedCountdowns()
// calculaban estos instantes por separado con la misma fórmula duplicada:
// bastaba con tocar uno de los dos sitios (como pasó con el margen de
// gafas) para que la cuenta atrás hablada y el aviso real dejaran de
// coincidir. Ahora ambos llaman a esta función.
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
  const title = document.createElement("div");
  title.className = "section-title";
  title.textContent = alertCopy.photoSummary.title;
  photoEvents.appendChild(title);

  const filterOffSec = PHOTO_FILTER_OFF_LEAD_SEC - SAFETY_MARGIN_SEC;
  const filterOnSec = PHOTO_FILTER_ON_LAG_SEC - SAFETY_MARGIN_SEC;

  appendAlertSummaryRow(photoEvents, formatRelativeContactTime("C2", -40), photoSummaryText("photo-hand"));
  appendAlertSummaryRow(photoEvents, formatRelativeRange("C2", -(filterOffSec + 5), -filterOffSec), photoSummaryText("photo-remove-countdown"));
  appendAlertSummaryRow(photoEvents, formatRelativeContactTime("C2", -filterOffSec), photoSummaryText("photo-remove-filter"));
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
  notify(`Eclipse · ${event.tag}`, event.text);

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
    { name: "C1 · Inicio parcial", t: c.c1 },
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
    setText(nodes.cdLabel, "faltan para");
  } else if (events.length) {
    setText(nodes.cdClock, "00:00:00");
    setText(nodes.cdEvent, "Eclipse finalizado");
    setText(nodes.cdLabel, "—");
  } else {
    nodes.cdClock.textContent = "—:—:—";
    nodes.cdEvent.textContent = "No visible: fuera de la franja del eclipse";
  }
}

function updateActiveRows(t, c) {
  ["C1", "C2", "C3", "C4"].forEach((tag) => {
    const row = $(`row-${tag}`);
    if (row) row.classList.remove("active");
    const geo = $(`geo-${tag}`);
    if (geo) geo.classList.remove("active");
  });

  if (c.c1 !== null && c.c2 !== null && t >= c.c1 && t < c.c2) {
    $("row-C1")?.classList.add("active");
    $("geo-C1")?.classList.add("active");
  } else if (c.c2 !== null && c.c3 !== null && t >= c.c2 && t <= c.c3) {
    $("row-C2")?.classList.add("active");
    $("geo-C2")?.classList.add("active");
  } else if (c.c3 !== null && c.c4 !== null && t > c.c3 && t <= c.c4) {
    $("row-C3")?.classList.add("active");
    $("geo-C3")?.classList.add("active");
  } else if (c.c4 !== null && t > c.c4) {
    $("row-C4")?.classList.add("active");
    $("geo-C4")?.classList.add("active");
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
      phaseText = "TOTALIDAD";
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
  drawDisk(fraction, insideTotality);

  let magPct = 0;
  if (c.c1 !== null && t >= c.c1 && t <= c.c4) {
    magPct = insideTotality ? 100 : Math.round(fraction * 100);
  }
  setText(nodes.magNum, `${magPct}%`);

  if (c.c1 !== null) {
    const geo = sunAltAz(t, state.lat, state.lon);
    setText(nodes.sunGeo, geo.alt > -1 ? `Alt ${geo.alt.toFixed(3)}° · Az ${geo.az.toFixed(3)}°` : "Sol bajo el horizonte");
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
    $("in-alt").value = LEON_PRESET.alt;
    $("loc-source").textContent = LEON_PRESET.sourceLabel;
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
      $("test-status").textContent = "Necesita totalidad. Prueba con León: 42.5987 N / 5.5671 O / 838 m.";
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

  ["in-lat", "in-lon", "in-alt"].forEach((id) => {
    $(id).addEventListener("input", markManualLocationInput);
  });

  ["in-lat", "in-lon", "in-alt", "in-manual-offset"].forEach((id) => {
    $(id).addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") recalc();
    });
  });
}

// Instalación guiada: Chrome/Android (y similares) disparan este evento en
// vez de dejar que el navegador muestre su propio banner genérico. Lo
// interceptamos para ofrecer un botón "Instalar app" bajo nuestro control.
// iOS Safari no dispara este evento (no soporta beforeinstallprompt), así
// que el botón simplemente no aparece ahí; conviven bien.
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

  const isIOS = isLikelySafariIOS();
  btn.hidden = false;

  window.addEventListener("beforeinstallprompt", (ev) => {
    ev.preventDefault();
    deferredInstallPrompt = ev;
    btn.hidden = false;
  });

  // iOS Safari nunca dispara beforeinstallprompt (no lo soporta), así que
  // ahí mostramos el botón igualmente: al tocarlo no hay prompt de sistema,
  // solo instrucciones manuales (Compartir > Añadir a pantalla de inicio).
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
      showInstallHelp("Toca compartir (el icono de Safari) y luego «Añadir a pantalla de inicio».");
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
  });
}

window.addEventListener("load", async () => {
  await loadAlertCopyConfig();

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
});
