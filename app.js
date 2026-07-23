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
const UI_TICK_MS = 200;

const $ = (id) => document.getElementById(id);

let state = {
  lat: null,
  lon: null,
  alt: 0,
  contacts: null,
  alertsFired: { prep: false, remove: false, filterOn: false },
  voiceFired: { c1: false, c2: false, c3: false, c4: false },
  testMode: false,
  testStartReal: null,
  testStartVirtualT: null,
  testSpeed: 1,
  locating: false
};

let wakeLockRef = null;
let bannerTimeout = null;
let rafId = null;
let lastUiTick = 0;
let sharedAudioCtx = null;
let keepAliveCtx = null;
let keepAliveOsc = null;
let keepAliveTickId = null;
let diskNodes = null;
let hiddenAtMs = null;
let speechTimer = null;
let speechLastAtMs = 0;

const SPEECH_MIN_GAP_MS = 900;
const SPEECH_TEST_GAP_MS = 1400;

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
  state.alertsFired = { prep: false, remove: false, filterOn: false };
  state.voiceFired = { c1: false, c2: false, c3: false, c4: false };
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

function locateUser() {
  if (!navigator.geolocation) {
    setLocStatus("Sin geolocalización. Introduce coordenadas a mano.", "err");
    return;
  }
  if (state.locating) return;

  state.locating = true;
  updateLocateButton();
  setLocStatus("Buscando señal GPS...");
  $("loc-source").textContent = "buscando...";

  navigator.geolocation.getCurrentPosition(
    (pos) => {
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
      state.locating = false;
      updateLocateButton();

      if (err.code === 1) {
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
  state.testStartReal = null;
  state.testStartVirtualT = null;
  resetAlerts();

  $("test-status").textContent = "Inactivo.";
  if (["sin datos", "buscando..."].includes($("loc-source").textContent)) {
    $("loc-source").textContent = "manual";
  }

  renderContacts();
  ["disk-section", "countdown-section", "contacts-section", "announce-section", "alerts-section"].forEach((id) => {
    $(id).style.display = "";
  });

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
      geoDiv.textContent = `Sol: ${geo.alt.toFixed(0)}° alt · ${geo.az.toFixed(0)}° az`;
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
  if (state.testMode && state.testStartReal !== null) {
    const elapsedRealSec = (performance.now() - state.testStartReal) / 1000;
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

function speakNow(text, interrupt) {
  if (interrupt) window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "es-ES";
  u.rate = 1.0;
  window.speechSynthesis.speak(u);
  speechLastAtMs = performance.now();
}

function speak(text, interrupt = true) {
  if (!("speechSynthesis" in window)) return;

  const now = performance.now();
  const minGap = state.testMode ? SPEECH_TEST_GAP_MS : SPEECH_MIN_GAP_MS;
  const delta = now - speechLastAtMs;

  if (speechTimer) {
    clearTimeout(speechTimer);
    speechTimer = null;
  }

  if (delta >= minGap) {
    speakNow(text, interrupt);
    return;
  }

  speechTimer = setTimeout(() => {
    speakNow(text, interrupt);
    speechTimer = null;
  }, minGap - delta);
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
  speak(voiceText, true);

  if (bannerTimeout) clearTimeout(bannerTimeout);
  bannerTimeout = setTimeout(() => {
    hideBanner();
  }, 8000);
}

function checkAlerts(t, c) {
  if (c.c2 !== null) {
    if (!state.alertsFired.prep && t >= c.c2 - 30 / 3600) {
      fireAlert("C2 · faltan 30s", "Mano al filtro", "#e0ac5c", "Mano al filtro. Prepárate para quitarlo.", 880, 1, [120]);
      state.alertsFired.prep = true;
    }
    if (!state.alertsFired.remove && t >= c.c2 - 20 / 3600) {
      fireAlert("C2 · faltan 20s", "Quita el filtro", "#5f7a5e", "Quita el filtro ahora.", 660, 2, [90, 80, 90]);
      state.alertsFired.remove = true;
    }
  }

  if (c.c3 !== null) {
    if (!state.alertsFired.filterOn && t >= c.c3 - 10 / 3600) {
      fireAlert("C3 · faltan 10s", "Pon el filtro", "#9c4632", "Pon el filtro ya. Termina la totalidad.", 440, 3, [90, 80, 90, 80, 90]);
      state.alertsFired.filterOn = true;
    }
  }
}

function checkVoiceAnnouncements(t, c) {
  if (!$("chk-live-voice").checked) return;

  const voiceEvents = [
    { key: "c1", label: "C1", text: "Contacto uno. Comienza la fase parcial." },
    { key: "c2", label: "C2", text: "Contacto dos. Comienza la totalidad." },
    { key: "c3", label: "C3", text: "Contacto tres. Termina la totalidad." },
    { key: "c4", label: "C4", text: "Contacto cuatro. Termina el eclipse." }
  ];

  voiceEvents.forEach((ev) => {
    const et = c[ev.key];
    if (et !== null && !state.voiceFired[ev.key] && t >= et) {
      state.voiceFired[ev.key] = true;
      speak(ev.text, true);
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
  corona.setAttribute("r", String(60 * 1.6));
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
    const diffSec = Math.max(0, Math.round((next.t - t) * 3600));
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
  });

  if (c.c1 !== null && c.c2 !== null && t >= c.c1 && t < c.c2) {
    $("row-C1")?.classList.add("active");
  } else if (c.c2 !== null && c.c3 !== null && t >= c.c2 && t <= c.c3) {
    $("row-C2")?.classList.add("active");
  } else if (c.c3 !== null && c.c4 !== null && t > c.c3 && t <= c.c4) {
    $("row-C3")?.classList.add("active");
  } else if (c.c4 !== null && t > c.c4) {
    $("row-C4")?.classList.add("active");
  }
}

function tick() {
  const c = state.contacts;
  if (!c) return;

  const t = currentTUTC();
  const circ = circumstances(t, c.obs);
  checkAlerts(t, c);
  checkVoiceAnnouncements(t, c);

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
    $("sun-geo").textContent = geo.alt > -1 ? `Sol: ${geo.alt.toFixed(0)}° alt · ${geo.az.toFixed(0)}° az` : "Sol bajo el horizonte";
  }

  updateCountdown(t, c);
  updateActiveRows(t, c);
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

function startKeepAlive() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    keepAliveCtx = new Ctx();
    keepAliveOsc = keepAliveCtx.createOscillator();
    const gain = keepAliveCtx.createGain();
    keepAliveOsc.frequency.value = 30;
    gain.gain.value = 0.015;
    keepAliveOsc.connect(gain);
    gain.connect(keepAliveCtx.destination);
    keepAliveOsc.start();

    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
    acquireWakeLock();
    $("keepalive-status").textContent = "Activo. No cierres la pestaña, solo minimízala.";
  } catch (_) {
    $("keepalive-status").textContent = "No se pudo activar en este navegador.";
  }
}

function stopKeepAlive() {
  try {
    if (keepAliveOsc) keepAliveOsc.stop();
    if (keepAliveCtx) keepAliveCtx.close();
  } catch (_) {
    // ignore
  }
  keepAliveOsc = null;
  keepAliveCtx = null;
  if (keepAliveTickId) {
    clearInterval(keepAliveTickId);
    keepAliveTickId = null;
  }
  $("keepalive-status").textContent = "Desactivado. Actívalo si vas a cambiar de app.";
}

function startKeepAliveTick() {
  if (keepAliveTickId) return;
  keepAliveTickId = setInterval(() => {
    if (state.contacts) tick();
  }, 1000);
}

function stopKeepAliveTick() {
  if (!keepAliveTickId) return;
  clearInterval(keepAliveTickId);
  keepAliveTickId = null;
}

function bindEvents() {
  setupHemiToggle("lat-hemi", ["N", "S"]);
  setupHemiToggle("lon-hemi", ["O", "E"]);

  $("btn-locate").addEventListener("click", locateUser);
  $("btn-recalc").addEventListener("click", recalc);
  $("btn-leon").addEventListener("click", () => {
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
      stopKeepAliveTick();
      if (state.testMode && hiddenAtMs !== null) {
        const hiddenDuration = performance.now() - hiddenAtMs;
        state.testStartReal += hiddenDuration;
        hiddenAtMs = null;
      }
      if (state.contacts || $("chk-keepalive").checked) acquireWakeLock();
    } else {
      if (state.testMode) hiddenAtMs = performance.now();
      if ($("chk-keepalive").checked) {
        startKeepAliveTick();
      } else {
        releaseWakeLock();
      }
    }
  });

  $("alert-banner-dismiss").addEventListener("click", () => {
    if (bannerTimeout) clearTimeout(bannerTimeout);
    hideBanner();
  });

  $("btn-test-voice").addEventListener("click", () => {
    if (!("speechSynthesis" in window)) {
      alert("Este navegador no soporta síntesis de voz.");
      return;
    }
    speak("Prueba de voz. Si oyes esto, todo funciona correctamente.", true);
  });

  $("btn-test-start").addEventListener("click", () => {
    const c = state.contacts;
    if (!c || c.c2 === null || c.c3 === null) {
      $("test-status").textContent = "Necesita totalidad. Prueba con León: 42.5987 N / 5.5671 O / 838 m.";
      return;
    }
    state.testMode = true;
    state.testSpeed = 1;
    state.testStartReal = performance.now();
    state.testStartVirtualT = c.c2 - 40 / 3600;
    resetAlerts();
    $("test-status").textContent = `En marcha ×${state.testSpeed}.`;
  });

  $("btn-test-stop").addEventListener("click", () => {
    state.testMode = false;
    state.testStartReal = null;
    state.testStartVirtualT = null;
    resetAlerts();
    $("test-status").textContent = "Inactivo.";
    hideBanner();
  });

  $("chk-keepalive").addEventListener("change", (e) => {
    if (e.target.checked) {
      startKeepAlive();
    } else {
      stopKeepAlive();
      if (!state.contacts) releaseWakeLock();
    }
  });

  ["in-lat", "in-lon", "in-alt"].forEach((id) => {
    $(id).addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") recalc();
    });
  });
}

window.addEventListener("load", () => {
  bindEvents();
  updateLocateButton();
  hideBanner();
});
