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
const PREFS_KEY = "eclipsetimer-alert-prefs-v1";
const AUDIO_ADVANCE_SEC = 0.5;
const AUDIO_ADVANCE_HOURS = AUDIO_ADVANCE_SEC / 3600;

const $ = (id) => document.getElementById(id);

let state = {
  lat: null,
  lon: null,
  alt: 0,
  contacts: null,
  alertsFired: {},
  voiceFired: { c1: false, c2: false, c3: false, c4: false },
  photoEnabled: true,
  testMode: false,
  testStartWallMs: null,
  testStartVirtualT: null,
  prevTickTUTC: null,
  testSpeed: 1,
  locating: false,
  locationRequestId: 0
};

let wakeLockRef = null;
let bannerTimeout = null;
let tickTimerId = null;
let tickIntervalMs = SLOW_TICK_MS;
let sharedAudioCtx = null;
let diskNodes = null;
let tickNodes = null;

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
function saveLastLocation(lat, lon, alt, sourceLabel) {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const existing = raw ? JSON.parse(raw) : {};
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      ...existing,
      lastLat: lat,
      lastLon: lon,
      lastAlt: alt,
      lastSourceLabel: sourceLabel || "manual"
    }));
  } catch (_) {
    // ignore storage failures
  }
}

function loadLastLocation() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
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
}

function bindAlertControls() {
  const master = $("chk-photo-master");
  if (!master) return;
  master.addEventListener("change", () => {
    state.photoEnabled = !!master.checked;
    if (!state.photoEnabled) {
      hideBanner();
      clearSpeechQueue();
    }
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

  const step = 0.01;
  let f1roots = [];
  let f2roots = [];
  let prevT = -3;
  let prevF1 = fm1(prevT);
  let prevF2 = fm2(prevT);

  for (let t = -3 + step; t <= 3; t += step) {
    const f1 = fm1(t);
    const f2 = fm2(t);
    if (prevF1 * f1 < 0) f1roots.push(findRoot(fm1, prevT, t));
    if (prevF2 * f2 < 0) f2roots.push(findRoot(fm2, prevT, t));
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
  const utHours = tTDT - DELTA_T / 3600;
  const baseUTC = Date.UTC(2026, 7, 12, 18, 0, 0) - DELTA_T * 1000;
  return new Date(baseUTC + utHours * 3600 * 1000);
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
  state.voiceFired = { c1: false, c2: false, c3: false, c4: false };
  state.prevTickTUTC = null;
  clearSpeechQueue();
  clearAlertDisplayQueue();
}

function setLocStatus(msg, cls) {
  const el = $("loc-status");
  el.textContent = msg;
  el.className = `coord-status${cls ? ` ${cls}` : ""}`;
}

function setupHemiToggle(btnId, pair) {
  const btn = $(btnId);
  btn.addEventListener("click", () => {
    btn.dataset.value = btn.dataset.value === pair[0] ? pair[1] : pair[0];
    btn.textContent = btn.dataset.value;
  });
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
  $("lat-hemi").dataset.value = val < 0 ? "S" : "N";
  $("lat-hemi").textContent = $("lat-hemi").dataset.value;
}

function writeLon(val) {
  $("in-lon").value = Math.abs(val).toFixed(4);
  $("lon-hemi").dataset.value = val < 0 ? "O" : "E";
  $("lon-hemi").textContent = $("lon-hemi").dataset.value;
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
    $("loc-source").textContent = "sin datos";
  }
  if (statusMsg) {
    setLocStatus(statusMsg, statusClass);
  }
}

function isLikelySafariIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) && /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);
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

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (requestId !== state.locationRequestId) return;
      state.locating = false;
      updateLocateButton();

      state.lat = pos.coords.latitude;
      state.lon = pos.coords.longitude;
      state.alt = pos.coords.altitude || 0;
      writeLat(state.lat);
      writeLon(state.lon);
      $("in-alt").value = Math.round(state.alt);
      $("loc-source").textContent = `GPS · ±${Math.round(pos.coords.accuracy)} m`;
      setLocStatus("Ubicación obtenida.", "ok");
      recalc();
    },
    (err) => {
      if (requestId !== state.locationRequestId) return;
      state.locating = false;
      updateLocateButton();

      const safariHint = "Safari ha bloqueado la ubicación. Revisa Ajustes del sitio web > Ubicación > Permitir, comprueba Ajustes de iPhone > Privacidad y seguridad > Localización > Safari Websites y recarga la página.";

      if (isLikelySafariIOS()) {
        setLocStatus(safariHint, "err");
      } else if (err.code === 1) {
        setLocStatus("Bloqueada por el navegador. Usa coordenadas manuales o 'Usar León'.", "err");
      } else {
        setLocStatus("No se pudo obtener la ubicación. Introduce coordenadas a mano.", "err");
      }
      $("loc-source").textContent = "sin datos";
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 30000 }
  );
}

function restoreLastLocation() {
  const saved = loadLastLocation();
  if (!saved) return;

  writeLat(saved.lat);
  writeLon(saved.lon);
  $("in-alt").value = Math.round(saved.alt);
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
  state.contacts.events = buildTimedEvents(state.contacts);
  state.testMode = false;
  state.testStartWallMs = null;
  state.testStartVirtualT = null;
  resetAlerts();

  $("test-status").textContent = "Inactivo.";
  if (["sin datos", "buscando..."].includes($("loc-source").textContent)) {
    $("loc-source").textContent = "manual";
  }

  saveLastLocation(lat, lon, alt, $("loc-source").textContent);
  renderContacts();
  applyPostLocationLayout(!!options.skipScroll);

  acquireWakeLock();
  startLoop();
  safeTick();
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
  list.innerHTML = "";

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
    div.innerHTML = `<div class="tag">${r.tag}</div><div class="desc">${r.desc}</div><div class="time">${r.t !== null ? fmtLocal(tToDate(r.t)) : "No visible"}</div>`;
    list.appendChild(div);

    if (r.t !== null) {
      const geo = sunAltAz(r.t, state.lat, state.lon);
      const geoDiv = document.createElement("div");
      geoDiv.className = "contact-geo";
      geoDiv.id = `geo-${r.tag}`;
      geoDiv.textContent = `${geo.alt.toFixed(0)}° alt · ${geo.az.toFixed(0)}° az`;
      list.appendChild(geoDiv);
    }
  });

  const note = $("duration-note");
  if (c.c1 === null) {
    note.textContent = "No visible desde estas coordenadas: quedan fuera de la franja de penumbra del eclipse (ni siquiera se ve como fase parcial).";
  } else {
    const totalDurSec = (c.c4 - c.c1) * 3600;
    const totalMin = Math.floor(totalDurSec / 60);
    const totalS = Math.round(totalDurSec % 60);
    let msg;
    if (c.total) {
      const durSec = (c.c3 - c.c2) * 3600;
      const mm = Math.floor(durSec / 60);
      const ss = Math.round(durSec % 60);
      msg = `Totalidad: ${mm} min ${ss} s · Eclipse completo (parcial + total): ${totalMin} min ${totalS} s.`;
    } else {
      msg = `Fuera de la franja de totalidad: solo parcial · Duración: ${totalMin} min ${totalS} s.`;
    }
    if (eclipseMostlyBelowHorizon(c)) {
      msg += " Aviso: el Sol está bajo el horizonte durante todo el evento en estas coordenadas, así que no podrás verlo aunque el cálculo sea correcto.";
    }
    note.textContent = msg;
  }
}

function currentTUTC() {
  if (state.testMode && state.testStartWallMs !== null) {
    const elapsedRealSec = (Date.now() - state.testStartWallMs) / 1000;
    const elapsedVirtualHours = (elapsedRealSec * state.testSpeed) / 3600;
    return state.testStartVirtualT + elapsedVirtualHours;
  }

  const now = new Date();
  const baseUTC = Date.UTC(2026, 7, 12, 18, 0, 0) - DELTA_T * 1000;
  const utHours = (now.getTime() - baseUTC) / 3600000;
  return utHours + DELTA_T / 3600;
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

function notify(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(title, { body });
    } catch (_) {
      // ignore notification failures
    }
  }
}

// El permiso de notificaciones también debe pedirse dentro de un gesto de
// usuario. Se llama junto a unlockAudioContext() en los mismos botones.
function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    try {
      Notification.requestPermission().catch(() => {
        // ignore rejection; notify() seguirá comprobando el permiso
      });
    } catch (_) {
      // Safari antiguo usa la API basada en callback en vez de promesa
      try {
        Notification.requestPermission(() => {});
      } catch (_) {
        // ignore
      }
    }
  }
}

// Punto único a llamar desde cualquier click real de usuario que pueda
// desembocar en alertas (voz/beep/vibración/notificación) más adelante.
function armAlertChannels() {
  unlockAudioContext();
  requestNotificationPermission();
  hideAudioArmBanner();
}

// Comprueba si el audio y/o las notificaciones todavía no han pasado por un
// gesto de usuario real. Solo hace falta mostrar el aviso cuando algo de
// esto sigue pendiente; si ya se armó en una sesión anterior (o el usuario
// ya tocó algún botón), no hace falta molestar.
function audioChannelsNeedRealGesture() {
  const audioNeedsGesture = !sharedAudioCtx || sharedAudioCtx.state !== "running";
  const notifNeedsGesture = "Notification" in window && Notification.permission === "default";
  return audioNeedsGesture || notifNeedsGesture;
}

function showAudioArmBanner() {
  const banner = $("audio-arm-banner");
  if (banner) banner.hidden = false;
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
    flash.style.position = "fixed";
    flash.style.left = "50%";
    flash.style.top = "30%";
    flash.style.transform = "translate(-50%, -50%)";
    flash.style.zIndex = "1500";
    flash.style.minWidth = "72px";
    flash.style.padding = "0.5rem 0.8rem";
    flash.style.textAlign = "center";
    flash.style.fontFamily = "Inter, -apple-system, Roboto, sans-serif";
    flash.style.fontVariantNumeric = "tabular-nums";
    flash.style.fontSize = "2.1rem";
    flash.style.fontWeight = "700";
    flash.style.border = "2px solid #e0ac5c";
    flash.style.borderRadius = "6px";
    flash.style.background = "rgba(0, 0, 0, 0.86)";
    flash.style.color = "#e9e6dd";
    flash.style.opacity = "0";
    flash.style.pointerEvents = "none";
    flash.style.transition = "opacity 0.12s ease";
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
  banner.style.display = "flex";
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

function fireAlert(tag, text, color, voiceText, beepFreq, beepTimes, vibratePattern) {
  const banner = $("alert-banner");
  $("alert-banner-tag").textContent = tag;
  $("alert-banner-tag").style.color = color;
  $("alert-banner-text").textContent = text;
  banner.style.borderTopColor = color;
  banner.style.display = "flex";
  banner.classList.add("show");
  banner.setAttribute("aria-hidden", "false");

  beep(beepFreq, beepTimes);
  if (navigator.vibrate) navigator.vibrate(vibratePattern);
  notify(`Eclipse · ${tag}`, text);
  speak(voiceText, { interrupt: false, priority: "normal" });

  if (bannerTimeout) clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => {
    hideBanner();
  }, 8000);
}

function addTimedEvent(list, key, time, payload) {
  if (time === null || Number.isNaN(time)) return;
  list.push({ key, time, ...payload });
}

function buildTimedEvents(c) {
  const events = [];

  if (c.c2 !== null && c.c3 !== null) {
    addTimedEvent(events, "c2-minus-60", c.c2 - 60 / 3600, {
      tag: "Aviso",
      text: "Falta 1 minuto para C2",
      color: "#e0ac5c",
      voice: "Falta un minuto para C2.",
      beepFreq: 760,
      beepTimes: 1,
      vibrate: [100]
    });

    addTimedEvent(events, "glasses-off", c.c2, {
      tag: "Seguridad visual",
      text: "Puedes quitar las gafas",
      color: "#5f7a5e",
      voice: "Contacto dos. Comienza la totalidad, puedes quitar las gafas.",
      combineWithContact: true,
      forceVoice: true,
      beepFreq: 660,
      beepTimes: 2,
      vibrate: [90, 80, 90]
    });

    addTimedEvent(events, "glasses-on", c.c3, {
      tag: "Seguridad visual",
      text: "Vuelve a poner las gafas",
      color: "#9c4632",
      voice: "Contacto tres. Termina la totalidad, vuelve a poner las gafas.",
      combineWithContact: true,
      forceVoice: true,
      beepFreq: 460,
      beepTimes: 2,
      vibrate: [90, 80, 90]
    });

    if (state.photoEnabled) {
      addTimedEvent(events, "photo-hand", c.c2 - 40 / 3600, {
        tag: "Aviso",
        text: "Mano al filtro",
        color: "#e0ac5c",
        voice: "Mano al filtro.",
        beepFreq: 860,
        beepTimes: 1,
        vibrate: [100]
      });

      addTimedEvent(events, "photo-remove-filter", c.c2 - 20 / 3600, {
        tag: "Aviso",
        text: "Quita el filtro ahora",
        color: "#5f7a5e",
        voice: "Quita el filtro ahora.",
        forceVoice: true,
        beepFreq: 680,
        beepTimes: 2,
        vibrate: [90, 80, 90]
      });

      addTimedEvent(events, "photo-filter-on", c.c3 + 15 / 3600, {
        tag: "Aviso",
        text: "Pon el filtro ahora",
        color: "#9c4632",
        voice: "Pon el filtro ahora.",
        forceVoice: true,
        beepFreq: 440,
        beepTimes: 3,
        vibrate: [90, 80, 90, 80, 90]
      });
    }
  }

  return events.sort((a, b) => a.time - b.time);
}

function triggerTimedEvent(event) {
  if (event.beepFreq && event.beepTimes) beep(event.beepFreq, event.beepTimes);
  if (event.vibrate && navigator.vibrate) navigator.vibrate(event.vibrate);
  notify(`Eclipse · ${event.tag}`, event.text);

  if (event.voice && !event.combineWithContact) {
    speak(event.voice, { interrupt: !!event.forceVoice });
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

  const c2FilterTarget = c.c2 - 20 / 3600;
  const c2Sec = Math.ceil((c2FilterTarget - tAudio) * 3600);
  if (tAudio >= c.c2 - 25 / 3600 && c2Sec >= 1 && c2Sec <= 5) {
    triggerCountdownSpeech(`photo-c2-count-${c2Sec}`, c2Sec, "C2", "#e0ac5c", 760);
  }

  const c3Target = c.c3 + 15 / 3600;
  const c3PlusSec = Math.ceil((c3Target - tAudio) * 3600);
  if (tAudio >= c.c3 + 10 / 3600 && c3PlusSec >= 1 && c3PlusSec <= 5) {
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
      if (lateSec <= ALERT_MAX_LATE_SEC) {
        triggerTimedEvent(event);
      }
    }
  });
}

function checkVoiceAnnouncements(t, prevT, c) {
  const voiceEvents = [
    { key: "c1", label: "C1", text: "Contacto uno. Comienza la fase parcial.", skipNotify: false },
    // C2 y C3 ya generan notificación propia en checkAlerts (eventos
    // "glasses-off"/"glasses-on"), así que aquí solo hace falta la voz;
    // notificar también aquí duplicaba el aviso en el sistema del móvil.
    { key: "c2", label: "C2", text: "Contacto dos. Comienza la totalidad, puedes quitar las gafas.", skipNotify: true },
    { key: "c3", label: "C3", text: "Contacto tres. Termina la totalidad, vuelve a poner las gafas.", skipNotify: true },
    { key: "c4", label: "C4", text: "Contacto cuatro. Termina el eclipse.", skipNotify: false }
  ];

  voiceEvents.forEach((ev) => {
    const et = c[ev.key];
    if (et === null || state.voiceFired[ev.key]) return;

    const triggerAt = et - AUDIO_ADVANCE_HOURS;
    const crossed = prevT === null ? t >= triggerAt : (prevT < triggerAt && t >= triggerAt);
    if (!crossed) return;

    state.voiceFired[ev.key] = true;
    // Igual que en checkAlerts: si llegamos muy tarde (pestaña en segundo
    // plano, pantalla bloqueada...) no anunciamos en voz alta una
    // instrucción de seguridad que ya no corresponde al momento actual.
    const lateSec = (t - triggerAt) * 3600;
    if (lateSec > ALERT_MAX_LATE_SEC) return;

    speak(ev.text, { interrupt: true, rate: 1.05 });
    if (!ev.skipNotify) notify(`Eclipse · ${ev.label}`, ev.text);
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
  if (secToNext === null) return SLOW_TICK_MS;
  if (secToNext <= AUDIO_FAST_WINDOW_SEC) return FAST_TICK_MS;
  if (secToNext <= AUDIO_MEDIUM_WINDOW_SEC) return MEDIUM_TICK_MS;
  return SLOW_TICK_MS;
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
  checkVoiceAnnouncements(t, prevT, c);

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
    setText(nodes.sunGeo, geo.alt > -1 ? `${geo.alt.toFixed(0)}° alt · ${geo.az.toFixed(0)}° az` : "Sol bajo el horizonte");
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
  tickTimerId = window.setTimeout(() => {
    tickTimerId = null;
    safeTick();
    if (state.contacts) scheduleTick();
  }, tickIntervalMs);
}

function startLoop() {
  if (tickTimerId) return;
  scheduleTick();
}

function enterKiosk() {
  document.body.classList.add("kiosk");
  $("btn-exit-kiosk").style.display = "block";
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
}

function exitKiosk() {
  document.body.classList.remove("kiosk");
  $("btn-exit-kiosk").style.display = "none";
  if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
}

function bindEvents() {
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
    armAlertChannels();
    locateUser();
  });
  $("btn-recalc").addEventListener("click", () => {
    armAlertChannels();
    recalc();
  });
  $("btn-leon").addEventListener("click", () => {
    armAlertChannels();
    cancelLocateRequest("Búsqueda interrumpida. Se usarán coordenadas de León.", "ok");
    writeLat(42.5987);
    writeLon(-5.5671);
    $("in-alt").value = 838;
    $("loc-source").textContent = "manual (León)";
    setLocStatus("Coordenadas de León cargadas.", "ok");
    recalc();
  });

  $("btn-fullscreen").addEventListener("click", () => {
    armAlertChannels();
    enterKiosk();
  });
  $("btn-exit-kiosk").addEventListener("click", exitKiosk);

  const btnArmAudio = $("btn-arm-audio");
  if (btnArmAudio) {
    btnArmAudio.addEventListener("click", () => {
      armAlertChannels();
      speak("Sonido y avisos activados.", { interrupt: true });
    });
  }

  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) {
      document.body.classList.remove("kiosk");
      $("btn-exit-kiosk").style.display = "none";
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (state.contacts) acquireWakeLock();
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
    armAlertChannels();
    if (!("speechSynthesis" in window)) {
      alert("Este navegador no soporta síntesis de voz.");
      return;
    }
    speak("Prueba de voz. Si oyes esto, todo funciona correctamente.", { interrupt: false, priority: "normal" });
  });

  $("btn-test-start").addEventListener("click", () => {
    armAlertChannels();
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

function bindInstallPrompt() {
  const btn = $("btn-install");
  if (!btn) return;

  window.addEventListener("beforeinstallprompt", (ev) => {
    ev.preventDefault();
    deferredInstallPrompt = ev;
    btn.style.display = "inline-block";
  });

  btn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    btn.disabled = true;
    try {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
    } catch (_) {
      // ignore
    } finally {
      deferredInstallPrompt = null;
      btn.style.display = "none";
      btn.disabled = false;
    }
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    btn.style.display = "none";
  });
}

window.addEventListener("load", () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      // Ignore service worker registration failures.
    });
  }

  loadAlertPrefs();
  bindEvents();
  bindAlertControls();
  bindInstallPrompt();
  syncAlertControlsFromState();
  updateLocateButton();
  hideBanner();
  restoreLastLocation();
});
