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
const UI_TICK_MS = 100;
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
let rafId = null;
let lastUiTick = 0;
let sharedAudioCtx = null;
let diskNodes = null;
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
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      photoEnabled: state.photoEnabled
    }));
  } catch (_) {
    // ignore storage failures
  }
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

function fmtMadrid(date) {
  return new Intl.DateTimeFormat("es-ES", {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
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

function applyPostLocationLayout() {
  revealResultSections();
  setSectionOpen("loc-section", false);
  COLLAPSIBLE_POST_LOCATION_IDS.forEach((sectionId) => {
    setSectionOpen(sectionId, false);
  });

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

function recalc() {
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
  state.testMode = false;
  state.testStartWallMs = null;
  state.testStartVirtualT = null;
  resetAlerts();

  $("test-status").textContent = "Inactivo.";
  if (["sin datos", "buscando..."].includes($("loc-source").textContent)) {
    $("loc-source").textContent = "manual";
  }

  renderContacts();
  applyPostLocationLayout();

  acquireWakeLock();
  startLoop();
  tick();
}

function renderContacts() {
  const c = state.contacts;
  if (!c) return;

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
    div.innerHTML = `<div class="tag">${r.tag}</div><div class="desc">${r.desc}</div><div class="time">${r.t !== null ? fmtMadrid(tToDate(r.t)) : "No visible"}</div>`;
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
  if (c.total) {
    const durSec = (c.c3 - c.c2) * 3600;
    const mm = Math.floor(durSec / 60);
    const ss = Math.round(durSec % 60);
    note.textContent = `Totalidad: ${mm} min ${ss} s.`;
  } else if (c.c1 !== null) {
    note.textContent = "Fuera de la franja de totalidad: solo parcial.";
  } else {
    note.textContent = "No visible desde estas coordenadas.";
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
    flash.style.fontFamily = "Consolas, 'Courier New', monospace";
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
  const events = buildTimedEvents(c);
  events.forEach((event) => {
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
    { key: "c1", label: "C1", text: "Contacto uno. Comienza la fase parcial." },
    { key: "c2", label: "C2", text: "Contacto dos. Comienza la totalidad, puedes quitar las gafas." },
    { key: "c3", label: "C3", text: "Contacto tres. Termina la totalidad, vuelve a poner las gafas." },
    { key: "c4", label: "C4", text: "Contacto cuatro. Termina el eclipse." }
  ];

  voiceEvents.forEach((ev) => {
    const et = c[ev.key];
    if (et === null || state.voiceFired[ev.key]) return;

    const triggerAt = et - AUDIO_ADVANCE_HOURS;
    const crossed = prevT === null ? false : (prevT < triggerAt && t >= triggerAt);
    if (crossed) {
      state.voiceFired[ev.key] = true;
      speak(ev.text, { interrupt: true, rate: 1.05 });
      notify(`Eclipse · ${ev.label}`, ev.text);
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
  const events = [
    { name: "C1 · Inicio parcial", t: c.c1 },
    { name: "C2 · Inicio totalidad", t: c.c2 },
    { name: "C3 · Fin totalidad", t: c.c3 },
    { name: "C4 · Fin eclipse", t: c.c4 }
  ].filter((e) => e.t !== null);

  const next = events.find((e) => e.t > t);
  if (next) {
    // Use ceil to keep second transitions aligned with the device clock
    // and avoid displaying the next second too early.
    const diffSec = Math.max(0, Math.ceil((next.t - t) * 3600));
    const hh = Math.floor(diffSec / 3600);
    const mm = Math.floor((diffSec % 3600) / 60);
    const ss = diffSec % 60;
    $("cd-clock").textContent = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    $("cd-event").textContent = next.name;
    $("cd-label").textContent = "faltan para";
  } else if (events.length) {
    $("cd-clock").textContent = "00:00:00";
    $("cd-event").textContent = "Eclipse finalizado";
    $("cd-label").textContent = "—";
  } else {
    $("cd-clock").textContent = "—:—:—";
    $("cd-event").textContent = "No visible desde aquí";
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

function tick() {
  const c = state.contacts;
  if (!c) return;

  const t = currentTUTC();
  const prevT = state.prevTickTUTC;
  const circ = circumstances(t, c.obs);
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

  $("phase-name").textContent = phaseText;
  drawDisk(fraction, insideTotality);

  let magPct = 0;
  if (c.c1 !== null && t >= c.c1 && t <= c.c4) {
    magPct = insideTotality ? 100 : Math.round(fraction * 100);
  }
  $("mag-num").textContent = `${magPct}%`;

  if (c.c1 !== null) {
    const geo = sunAltAz(t, state.lat, state.lon);
    $("sun-geo").textContent = geo.alt > -1 ? `${geo.alt.toFixed(0)}° alt · ${geo.az.toFixed(0)}° az` : "Sol bajo el horizonte";
  }

  updateCountdown(t, c);
  updateActiveRows(t, c);
  state.prevTickTUTC = t;
}

function startLoop() {
  if (rafId) return;
  const loop = (ts) => {
    if (state.contacts && (!lastUiTick || ts - lastUiTick >= UI_TICK_MS)) {
      lastUiTick = ts;
      tick();
    }
    rafId = window.requestAnimationFrame(loop);
  };
  rafId = window.requestAnimationFrame(loop);
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

  $("btn-locate").addEventListener("click", locateUser);
  $("btn-recalc").addEventListener("click", recalc);
  $("btn-leon").addEventListener("click", () => {
    cancelLocateRequest("Búsqueda interrumpida. Se usarán coordenadas de León.", "ok");
    writeLat(42.5987);
    writeLon(-5.5671);
    $("in-alt").value = 838;
    $("loc-source").textContent = "manual (León)";
    setLocStatus("Coordenadas de León cargadas.", "ok");
    recalc();
  });

  $("btn-fullscreen").addEventListener("click", enterKiosk);
  $("btn-exit-kiosk").addEventListener("click", exitKiosk);

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
    if (!("speechSynthesis" in window)) {
      alert("Este navegador no soporta síntesis de voz.");
      return;
    }
    speak("Prueba de voz. Si oyes esto, todo funciona correctamente.", { interrupt: false, priority: "normal" });
  });

  $("btn-test-start").addEventListener("click", () => {
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

window.addEventListener("load", () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {
      // Ignore service worker registration failures.
    });
  }

  loadAlertPrefs();
  bindEvents();
  bindAlertControls();
  syncAlertControlsFromState();
  updateLocateButton();
  hideBanner();
});
