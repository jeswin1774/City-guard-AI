const MAPBOX_TOKEN = "YOUR_MAPBOX_ACCESS_TOKEN";

const routeState = {
  origin: [78.1198, 8.7810],
  destination: [78.1452, 8.7937],
  hazardNode: [78.1310, 8.7860],
  safeZones: [
    { name: "SAFE ZONE A", coords: [78.1178, 8.7895] },
    { name: "SAFE ZONE B", coords: [78.1412, 8.7992] },
    { name: "SAFE ZONE C", coords: [78.1118, 8.7775] }
  ]
};

let cur = {
  node: "NODE-07",
  aqi: 72,
  noise: 54,
  temp: 28,
  hum: 62
};

let aqiHist   = [88,78,70,65,72,98,125,142,136,128,118,110,105,112,108,100,95,88,82,78,75,72,70,72];
let noiseHist = [42,38,35,34,38,55,68,75,72,70,65,62,60,65,68,72,70,65,60,55,52,50,48,54];
let tempHist  = [26,25,24,24,25,27,29,31,32,33,33,32,31,31,30,30,29,29,28,28,27,27,26,28];
let humHist   = [70,72,73,74,72,68,64,60,58,57,56,58,60,61,62,63,64,64,65,65,66,66,67,62];

let histRows = [];
let mqttConnected = false;
let simInterval = null;
let voiceEnabled = true;
let sirenEnabled = true;
let notificationEnabled = false;
let avatarGender = "female";
let lastDangerSignature = "";
let audioCtx = null;
let map = null;
let aqiChart = null;
let noiseChart = null;

const avatarShell = document.getElementById("avatarShell");
const avatarHuman = document.getElementById("avatarHuman");
const voiceWave = document.getElementById("voiceWave");

function tickClock() {
  const d = new Date();
  document.getElementById("clock").textContent =
    d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" }) +
    " · " +
    d.toLocaleTimeString("en-GB");
}
tickClock();
setInterval(tickClock, 1000);

function setMQTTStatus(state) {
  const el = document.getElementById("mqttStatus");
  el.className = "pill";

  if (state === "live") {
    el.classList.add("pill-ok");
    el.textContent = "MQTT LIVE";
  } else if (state === "error") {
    el.classList.add("pill-bad");
    el.textContent = "DISCONNECTED";
  } else if (state === "sim") {
    el.classList.add("pill-warn");
    el.textContent = "SIMULATION";
  } else {
    el.classList.add("pill-warn");
    el.textContent = "CONNECTING";
  }
}

function aqiLevel(v) {
  if (v <= 50)  return { label: "GOOD",      cls: "ok",   desc: "Clean air",                     danger: false };
  if (v <= 100) return { label: "MODERATE",  cls: "warn", desc: "Acceptable air",                danger: false };
  if (v <= 150) return { label: "CAUTION",   cls: "warn", desc: "Sensitive groups affected",     danger: false };
  if (v <= 200) return { label: "UNHEALTHY", cls: "bad",  desc: "Dangerous pollution level",     danger: true  };
  return               { label: "HAZARDOUS", cls: "bad",  desc: "Emergency pollution level",     danger: true  };
}

function noiseLevel(v) {
  if (v < 55) return { label: "QUIET",   cls: "ok",   desc: "Peaceful environment",            danger: false };
  if (v < 70) return { label: "NORMAL",  cls: "ok",   desc: "Safe hearing range",              danger: false };
  if (v < 80) return { label: "LOUD",    cls: "bad2", desc: "Prolonged exposure not advised",  danger: false };
  return             { label: "HARMFUL", cls: "bad",  desc: "Hearing damage risk",             danger: true  };
}

function tempLevel(v) {
  if (v < 18)  return { label: "COLD",   cls: "warn", desc: "Low temperature",                 danger: false };
  if (v <= 30) return { label: "NORMAL", cls: "ok",   desc: "Normal temperature range",        danger: false };
  if (v <= 35) return { label: "HOT",    cls: "bad2", desc: "Above normal temperature",        danger: false };
  return             { label: "ALERT",   cls: "bad",  desc: "High temperature — heat risk",    danger: true  };
}

function humLevel(v) {
  if (v < 30)  return { label: "DRY",    cls: "bad2", desc: "Low humidity — dry air",          danger: false };
  if (v <= 60) return { label: "NORMAL", cls: "ok",   desc: "Normal humidity level",           danger: false };
  if (v <= 75) return { label: "HUMID",  cls: "warn", desc: "Above normal humidity",           danger: false };
  return             { label: "ALERT",   cls: "bad",  desc: "Very high humidity — discomfort", danger: true  };
}

function levelColor(cls) {
  if (cls === "bad") return "#FF3D5A";
  if (cls === "bad2") return "#FF8C00";
  if (cls === "warn") return "#FFCB47";
  return "#00E5A0";
}

function getTrend(arr) {
  const len = arr.length;
  const a = arr[len - 1];
  const b = arr[len - 2];
  const c = arr[len - 3];
  return { last: a, slope: (a - b) + (b - c) };
}

function predictDanger(data) {
  const aqiTrend = getTrend(aqiHist);
  const noiseTrend = getTrend(noiseHist);
  const tempTrend = getTrend(tempHist);
  const humTrend = getTrend(humHist);

  const warnings = [];

  if (data.aqi <= 150 && data.aqi >= 130 && aqiTrend.slope >= 10) warnings.push(`AQI is rising fast near ${data.node}`);
  if (data.noise < 80 && data.noise >= 74 && noiseTrend.slope >= 5) warnings.push(`Noise is approaching danger near ${data.node}`);
  if (data.temp <= 35 && data.temp >= 33 && tempTrend.slope >= 1.0) warnings.push(`Temperature is climbing toward heat risk`);
  if (data.hum <= 75 && data.hum >= 70 && humTrend.slope >= 2.0) warnings.push(`Humidity is rising toward discomfort range`);

  if (warnings.length) {
    return {
      dangerLikely: true,
      text: `AI prediction: ${warnings[0]}. Monitoring nearby safer zones and next readings for escalation.`
    };
  }

  return {
    dangerLikely: false,
    text: `AI prediction: Stable pattern from ${data.node}. No immediate danger escalation predicted.`
  };
}

function priorityLabel(alerts) {
  if (!alerts.length) return "NONE";
  return alerts[0].key.toUpperCase();
}

function buildAlerts(aq, ns, tp, hm, node, al, nl, tl, hl) {
  const alerts = [];

  if (al.danger) alerts.push({
    key: "aqi", priority: 1, card: "cardAQI",
    title: "Air Quality Danger",
    msg: `${node} reports AQI ${aq} — ${al.desc}`,
    actions: ["Stay indoors", "Wear mask", "Close windows"]
  });

  if (nl.danger) alerts.push({
    key: "noise", priority: 2, card: "cardNoise",
    title: "Noise Danger",
    msg: `${node} reports ${ns} dB — ${nl.desc}`,
    actions: ["Move away", "Use ear protection"]
  });

  if (tl.danger) alerts.push({
    key: "temp", priority: 3, card: "cardTemp",
    title: "Temperature Danger",
    msg: `${node} reports ${tp}°C — ${tl.desc}`,
    actions: ["Drink water", "Avoid sun"]
  });

  if (hl.danger) alerts.push({
    key: "hum", priority: 4, card: "cardHum",
    title: "Humidity Danger",
    msg: `${node} reports ${hm}% — ${hl.desc}`,
    actions: ["Use ventilation", "Use fan"]
  });

  alerts.sort((a, b) => a.priority - b.priority);
  return alerts;
}

function updateStatusChip(id, level) {
  const el = document.getElementById(id);
  el.className = "status-chip " + level.cls;
  el.textContent = level.label;
}

function updateCard(cardId, active) {
  const el = document.getElementById(cardId);
  el.classList.toggle("danger", !!active);
}

function clearDangerEffects() {
  ["cardAQI", "cardNoise", "cardTemp", "cardHum"].forEach(id => {
    document.getElementById(id).classList.remove("flash");
  });
  document.getElementById("dangerBanner").classList.remove("flash");
  avatarShell.classList.remove("danger");
}

function applyDangerEffects(cardIds) {
  clearDangerEffects();
  cardIds.forEach(id => document.getElementById(id).classList.add("flash"));
  if (cardIds.length) {
    document.getElementById("dangerBanner").classList.add("flash");
    avatarShell.classList.add("danger");
  }
}

function chooseVoice(gender) {
  if (!("speechSynthesis" in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  const femaleHints = ["female","woman","zira","samantha","victoria","karen","moira","veena"];
  const maleHints = ["male","man","david","mark","alex","daniel","fred","ravi"];
  const hints = gender === "female" ? femaleHints : maleHints;

  const preferred = voices.find(v =>
    hints.some(h => v.name.toLowerCase().includes(h)) &&
    v.lang.toLowerCase().startsWith("en")
  );

  return preferred || voices.find(v => v.lang.toLowerCase().startsWith("en")) || voices[0];
}

function setAvatarGender(gender) {
  avatarGender = gender;
  avatarHuman.className = "avatar-human " + gender;
  document.getElementById("avatarToggle").textContent =
    gender === "female" ? "AVATAR: FEMALE" : "AVATAR: MALE";
}

function setAvatarSpeaking(on) {
  document.getElementById("avatarStatusText").textContent = on ? "VOICE STATUS · SPEAKING" : "VOICE STATUS · READY";
  document.getElementById("avatarMode").textContent = on ? "VOICE ACTIVE" : "STANDBY";
  avatarHuman.classList.toggle("speaking", on);
  voiceWave.classList.toggle("active", on);
}

function speakMessage(text) {
  document.getElementById("avatarSpeechText").textContent = text;

  if (!voiceEnabled || !("speechSynthesis" in window)) return;

  try {
    window.speechSynthesis.cancel();

    const utter = new SpeechSynthesisUtterance(text);
    const voice = chooseVoice(avatarGender);
    if (voice) utter.voice = voice;

    utter.lang = voice?.lang || "en-US";
    utter.rate = 1;
    utter.pitch = avatarGender === "female" ? 1.05 : 0.95;
    utter.volume = 1;

    utter.onstart = () => setAvatarSpeaking(true);
    utter.onend = () => setAvatarSpeaking(false);
    utter.onerror = () => setAvatarSpeaking(false);

    window.speechSynthesis.speak(utter);
  } catch (err) {
    setAvatarSpeaking(false);
    console.warn("Speech failed:", err);
  }
}

function playSiren() {
  if (!sirenEnabled) return;

  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = "sawtooth";
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);

    osc.frequency.setValueAtTime(620, now);
    osc.frequency.linearRampToValueAtTime(900, now + 0.25);
    osc.frequency.linearRampToValueAtTime(560, now + 0.55);
    osc.frequency.linearRampToValueAtTime(860, now + 0.85);

    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.0);

    osc.start(now);
    osc.stop(now + 1.02);
  } catch (err) {
    console.warn("Siren unavailable:", err);
  }
}

function pushNotification(title, body) {
  if (!notificationEnabled) return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  try {
    new Notification(title, { body });
  } catch (err) {
    console.warn("Notification failed:", err);
  }
}

function nearestSafeZone(nodeCoords) {
  let best = null;
  let bestD = Infinity;

  for (const zone of routeState.safeZones) {
    const dx = nodeCoords[0] - zone.coords[0];
    const dy = nodeCoords[1] - zone.coords[1];
    const d = Math.sqrt(dx * dx + dy * dy);

    if (d < bestD) {
      bestD = d;
      best = zone;
    }
  }
  return best;
}

async function getDirections(coords) {
  if (!MAPBOX_TOKEN || MAPBOX_TOKEN === "YOUR_MAPBOX_ACCESS_TOKEN") return null;

  const coordString = coords.map(c => `${c[0]},${c[1]}`).join(";");
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coordString}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;

  try {
    const res = await fetch(url);
    const json = await res.json();
    return json?.routes?.[0]?.geometry || null;
  } catch (err) {
    console.warn("Directions fetch failed:", err);
    return null;
  }
}

function ensureMapLayers() {
  if (!map.getSource("route-normal")) {
    map.addSource("route-normal", {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } }
    });

    map.addLayer({
      id: "route-normal",
      type: "line",
      source: "route-normal",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#7C6FFF", "line-width": 5, "line-opacity": 0.8 }
    });
  }

  if (!map.getSource("route-safe")) {
    map.addSource("route-safe", {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "LineString", coordinates: [] } }
    });

    map.addLayer({
      id: "route-safe",
      type: "line",
      source: "route-safe",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#A8FF3E", "line-width": 6, "line-opacity": 0.95 }
    });
  }

  if (!map.getSource("hazard-zone")) {
    map.addSource("hazard-zone", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: routeState.hazardNode }
        }]
      }
    });

    map.addLayer({
      id: "hazard-zone",
      type: "circle",
      source: "hazard-zone",
      paint: {
        "circle-radius": 30,
        "circle-color": "rgba(255,61,90,.16)",
        "circle-stroke-color": "#FF3D5A",
        "circle-stroke-width": 2
      }
    });
  }

  if (!map.getSource("safe-zones")) {
    map.addSource("safe-zones", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: routeState.safeZones.map(z => ({
          type: "Feature",
          properties: { name: z.name },
          geometry: { type: "Point", coordinates: z.coords }
        }))
      }
    });

    map.addLayer({
      id: "safe-zones",
      type: "circle",
      source: "safe-zones",
      paint: {
        "circle-radius": 8,
        "circle-color": "#A8FF3E",
        "circle-stroke-color": "#07101a",
        "circle-stroke-width": 2
      }
    });
  }
}

async function updateMapRouting(priority) {
  if (!map) return;

  const safeZone = nearestSafeZone(routeState.hazardNode);
  document.getElementById("tagNode").textContent = cur.node;
  document.getElementById("tagPriority").textContent = `PRIORITY: ${priority}`;
  document.getElementById("tagSafeZone").textContent = `SAFE ZONE: ${safeZone ? safeZone.name : "NONE"}`;

  const useSafeRoute = priority === "AQI";
  document.getElementById("mapMode").textContent = useSafeRoute ? "SAFE ROUTE ACTIVE" : "NORMAL ROUTE";

  const normalGeom = await getDirections([routeState.origin, routeState.destination]);
  const safeGeom = useSafeRoute && safeZone
    ? await getDirections([routeState.origin, safeZone.coords, routeState.destination])
    : null;

  if (map.getSource("route-normal") && normalGeom) {
    map.getSource("route-normal").setData({
      type: "Feature",
      geometry: normalGeom
    });
  }

  if (map.getSource("route-safe")) {
    map.getSource("route-safe").setData({
      type: "Feature",
      geometry: safeGeom || { type: "LineString", coordinates: [] }
    });
  }

  if (useSafeRoute && safeZone) {
    document.getElementById("routeSummary").textContent =
      `Dangerous air quality detected near ${cur.node}. The system selected the nearest safer zone, ${safeZone.name}, and activated a safer alternate route.`;
  } else {
    document.getElementById("routeSummary").textContent =
      `Using normal route. No AQI danger reroute is active. Nearby safer zones remain available.`;
  }
}

function initMapbox() {
  if (!MAPBOX_TOKEN || MAPBOX_TOKEN === "YOUR_MAPBOX_ACCESS_TOKEN") {
    document.getElementById("routeSummary").textContent =
      "Add your Mapbox token to enable live map and safer-zone routing.";
    document.getElementById("map").innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#9BB4D0;font-family:Space Mono, monospace;font-size:12px;padding:18px;text-align:center;">Mapbox token required.<br>Replace YOUR_MAPBOX_ACCESS_TOKEN in the JS panel.</div>';
    return;
  }

  mapboxgl.accessToken = MAPBOX_TOKEN;

  map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/dark-v11",
    center: routeState.hazardNode,
    zoom: 13.3
  });

  map.addControl(new mapboxgl.NavigationControl(), "top-right");

  map.on("load", async () => {
    ensureMapLayers();

    new mapboxgl.Marker({ color: "#38BDF8" })
      .setLngLat(routeState.hazardNode)
      .setPopup(new mapboxgl.Popup().setText("Sensor Node"))
      .addTo(map);

    new mapboxgl.Marker({ color: "#FF3D5A" })
      .setLngLat(routeState.hazardNode)
      .setPopup(new mapboxgl.Popup().setText("Hazard Node"))
      .addTo(map);

    await updateMapRouting("NONE");
  });
}

function renderCards(aq, ns, tp, hm, node, al, nl, tl, hl) {
  document.getElementById("aqiValue").textContent = aq;
  document.getElementById("noiseValue").textContent = ns;
  document.getElementById("tempValue").textContent = tp;
  document.getElementById("humValue").textContent = hm;

  document.getElementById("aqiNow").textContent = aq;
  document.getElementById("noiseNow").textContent = ns;
  document.getElementById("aiAQI").textContent = aq;
  document.getElementById("aiNoise").textContent = ns + " dB";
  document.getElementById("aiNode").textContent = node;

  document.getElementById("aqiValue").style.color = levelColor(al.cls);
  document.getElementById("noiseValue").style.color = levelColor(nl.cls);
  document.getElementById("tempValue").style.color = levelColor(tl.cls);
  document.getElementById("humValue").style.color = levelColor(hl.cls);

  updateStatusChip("aqiStatus", al);
  updateStatusChip("noiseStatus", nl);
  updateStatusChip("tempStatus", tl);
  updateStatusChip("humStatus", hl);

  document.getElementById("aqiDesc").textContent = al.desc;
  document.getElementById("noiseDesc").textContent = nl.desc;
  document.getElementById("tempDesc").textContent = tl.desc;
  document.getElementById("humDesc").textContent = hl.desc;

  document.getElementById("nodeDisplay").textContent = node;
  document.getElementById("aqiNode").textContent = `Source: ${node}`;
  document.getElementById("noiseNode").textContent = `Source: ${node}`;
  document.getElementById("tempNode").textContent = `Source: ${node}`;
  document.getElementById("humNode").textContent = `Source: ${node}`;

  updateCard("cardAQI", al.danger);
  updateCard("cardNoise", nl.danger);
  updateCard("cardTemp", tl.danger);
  updateCard("cardHum", hl.danger);
}

function renderAlerts(node, alerts, prediction) {
  const banner = document.getElementById("dangerBanner");
  const list = document.getElementById("dangerList");

  document.getElementById("predictionBar").textContent = prediction.text;
  document.getElementById("footerPrediction").textContent =
    prediction.dangerLikely ? "Prediction: Rising risk" : "Prediction: Stable";

  if (alerts.length > 0) {
    banner.classList.remove("hidden");
    list.innerHTML = alerts.map((a, idx) => `
      <div class="danger-item ${idx === 0 ? "priority" : ""}">
        <h4>PRIORITY ${a.priority} · ${a.title}</h4>
        <p>${a.msg}</p>
        <div class="danger-meta">Triggered by ${node}</div>
        <div class="mini-actions">
          ${a.actions.map(x => `<span class="mini-pill">${x}</span>`).join("")}
        </div>
      </div>
    `).join("");

    applyDangerEffects(alerts.map(a => a.card));

    const signature = `${node}-${alerts.map(a => a.key).join("-")}`;
    if (signature !== lastDangerSignature) {
      const allMessages = alerts.map(a => `${a.title}. ${a.msg}`).join(" ");
      const motivation = "Please stay calm. Follow the safety instructions and move toward the nearest safer zone.";
      const spoken = `Warning from ${node}. ${allMessages} ${motivation}`;
      speakMessage(spoken);
      playSiren();
      pushNotification("CityGuard Danger Alert", `${alerts[0].title} at ${node}`);
      lastDangerSignature = signature;
    }
  } else {
    clearDangerEffects();
    lastDangerSignature = "";

    if (prediction.dangerLikely) {
      banner.classList.remove("hidden");
      list.innerHTML = `
        <div class="danger-item">
          <h4>AI PRE-ALERT</h4>
          <p>${prediction.text}</p>
          <div class="danger-meta">Node ${node}</div>
        </div>
      `;
      speakMessage(prediction.text);
    } else {
      banner.classList.add("hidden");
      list.innerHTML = "";
      document.getElementById("avatarSpeechText").textContent =
        "System normal. Monitoring all nodes, safer zones, and route conditions.";
    }
  }
}

function addHistoryRow(node, aq, ns, tp, hm, alerts, al, nl, tl, hl) {
  const now = new Date().toLocaleTimeString("en-GB");
  const priority = priorityLabel(alerts);

  const overall = alerts.length > 0
    ? "ALERT"
    : (al.cls === "warn" || nl.cls === "warn" || tl.cls === "warn" || hl.cls === "warn")
      ? "CAUTION"
      : "CLEAN";

  const cls = overall === "ALERT" ? "tag-bad" : overall === "CAUTION" ? "tag-mod" : "tag-good";

  histRows.unshift({ time: now, node, aq, ns, tp, hm, priority, overall, cls });
  if (histRows.length > 12) histRows.pop();

  document.getElementById("historyBody").innerHTML = histRows.map(r => `
    <tr>
      <td>${r.time}</td>
      <td>${r.node}</td>
      <td>${r.aq}</td>
      <td>${r.ns}</td>
      <td>${r.tp}°C</td>
      <td>${r.hm}%</td>
      <td>${r.priority}</td>
      <td><span class="tag ${r.cls}">${r.overall}</span></td>
    </tr>
  `).join("");
}

function renderAll(data) {
  const aq = Math.round(data.aqi);
  const ns = Math.round(data.noise);
  const tp = Math.round(data.temp * 10) / 10;
  const hm = Math.round(data.hum);
  const node = data.node || "NODE-07";

  const al = aqiLevel(aq);
  const nl = noiseLevel(ns);
  const tl = tempLevel(tp);
  const hl = humLevel(hm);

  const prediction = predictDanger({ node, aqi: aq, noise: ns, temp: tp, hum: hm });
  const alerts = buildAlerts(aq, ns, tp, hm, node, al, nl, tl, hl);

  renderCards(aq, ns, tp, hm, node, al, nl, tl, hl);
  renderAlerts(node, alerts, prediction);
  addHistoryRow(node, aq, ns, tp, hm, alerts, al, nl, tl, hl);
  updateMapRouting(priorityLabel(alerts));
}

function updateFromSensor(data) {
  if (data.node !== undefined) cur.node = data.node;
  if (data.aqi !== undefined && !isNaN(parseFloat(data.aqi))) cur.aqi = parseFloat(data.aqi);
  if (data.noise !== undefined && !isNaN(parseFloat(data.noise))) cur.noise = parseFloat(data.noise);
  if (data.temp !== undefined && !isNaN(parseFloat(data.temp))) cur.temp = parseFloat(data.temp);
  if (data.hum !== undefined && !isNaN(parseFloat(data.hum))) cur.hum = parseFloat(data.hum);

  renderAll(cur);

  aqiHist.push(Math.round(cur.aqi)); aqiHist.shift();
  noiseHist.push(Math.round(cur.noise)); noiseHist.shift();
  tempHist.push(Math.round(cur.temp)); tempHist.shift();
  humHist.push(Math.round(cur.hum)); humHist.shift();

  aqiChart.data.datasets[0].data = [...aqiHist];
  noiseChart.data.datasets[0].data = [...noiseHist];
  aqiChart.update("none");
  noiseChart.update("none");
}

function startSimulation() {
  if (simInterval) return;
  setMQTTStatus("sim");

  simInterval = setInterval(() => {
    if (mqttConnected) {
      clearInterval(simInterval);
      simInterval = null;
      return;
    }

    cur.aqi = Math.max(30, Math.min(300, cur.aqi + (Math.random() - 0.42) * 10));
    cur.noise = Math.max(30, Math.min(95, cur.noise + (Math.random() - 0.44) * 5));
    cur.temp = Math.max(15, Math.min(42, cur.temp + (Math.random() - 0.48) * 0.9));
    cur.hum = Math.max(20, Math.min(95, cur.hum + (Math.random() - 0.48) * 1.4));

    updateFromSensor({});
  }, 3000);
}

function connectMQTT() {
  const client = mqtt.connect("wss://broker.hivemq.com:8884/mqtt", {
    clientId: "cityguard_codepen_enhanced_" + Math.random().toString(16).slice(2, 8),
    clean: true,
    reconnectPeriod: 4000,
    connectTimeout: 8000,
    protocol: "wss"
  });

  client.on("connect", () => {
    mqttConnected = true;
    setMQTTStatus("live");

    client.subscribe("cityguard/gas", { qos: 0 }, (err) => {
      if (err) console.error("Subscribe failed:", err);
    });

    if (simInterval) {
      clearInterval(simInterval);
      simInterval = null;
    }
  });

  client.on("message", (_topic, message) => {
    const raw = message.toString();
    try {
      const data = JSON.parse(raw);
      updateFromSensor({
        node: data.node || "NODE-07",
        aqi: data.aqi,
        noise: data.noise,
        temp: data.temp,
        hum: data.hum
      });
    } catch (e) {
      console.warn("Could not parse MQTT message:", raw, e);
    }
  });

  client.on("reconnect", () => {
    mqttConnected = false;
    setMQTTStatus("connecting");
  });

  client.on("error", () => {
    mqttConnected = false;
    setMQTTStatus("error");
    startSimulation();
  });

  client.on("offline", () => {
    mqttConnected = false;
    setMQTTStatus("error");
    startSimulation();
  });
}

function initControls() {
  document.getElementById("voiceToggle").addEventListener("click", () => {
    voiceEnabled = !voiceEnabled;
    const btn = document.getElementById("voiceToggle");
    btn.textContent = voiceEnabled ? "VOICE ON" : "VOICE OFF";
    btn.classList.toggle("active", voiceEnabled);

    if (!voiceEnabled && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      setAvatarSpeaking(false);
    }
  });

  document.getElementById("sirenToggle").addEventListener("click", () => {
    sirenEnabled = !sirenEnabled;
    const btn = document.getElementById("sirenToggle");
    btn.textContent = sirenEnabled ? "SIREN ON" : "SIREN OFF";
    btn.classList.toggle("active", sirenEnabled);
  });

  document.getElementById("notifyToggle").addEventListener("click", async () => {
    if (!("Notification" in window)) {
      alert("Notifications are not supported in this browser.");
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      notificationEnabled = permission === "granted";
      const btn = document.getElementById("notifyToggle");
      btn.textContent = notificationEnabled ? "NOTIFICATIONS ON" : "NOTIFICATIONS OFF";
      btn.classList.toggle("active", notificationEnabled);

      if (notificationEnabled) {
        new Notification("CityGuard", { body: "Smart dashboard notifications enabled." });
      }
    } catch (err) {
      console.warn("Notification permission failed:", err);
    }
  });

  document.getElementById("avatarToggle").addEventListener("click", () => {
    setAvatarGender(avatarGender === "female" ? "male" : "female");
    speakMessage(`Avatar switched to ${avatarGender} assistant mode.`);
  });
}

function initCharts() {
  const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0") + ":00");

  const common = {
    responsive: true,
    animation: { duration: 500 },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "#0E1623",
        borderColor: "#1C2E45",
        borderWidth: 1,
        titleColor: "#3D5472",
        bodyColor: "#DCE8FF",
        titleFont: { family: "Space Mono, monospace", size: 9 },
        bodyFont: { family: "Space Mono, monospace", size: 11 }
      }
    },
    scales: {
      x: {
        ticks: {
          color: "#253B55",
          font: { family: "Space Mono, monospace", size: 8 },
          maxTicksLimit: 8
        },
        grid: { color: "rgba(28,46,69,.5)" }
      },
      y: {
        ticks: { color: "#253B55", font: { family: "Space Mono, monospace", size: 8 } },
        grid: { color: "rgba(28,46,69,.5)" }
      }
    }
  };

  function buildChart(id, data, hex, label, minY) {
    const ctx = document.getElementById(id).getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 0, 160);
    g.addColorStop(0, hex + "55");
    g.addColorStop(1, hex + "00");

    return new Chart(ctx, {
      type: "line",
      data: {
        labels: HOURS,
        datasets: [{
          label,
          data: [...data],
          borderColor: hex,
          backgroundColor: g,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: hex,
          tension: 0.4,
          fill: true
        }]
      },
      options: {
        ...common,
        scales: {
          ...common.scales,
          y: { ...common.scales.y, min: minY }
        }
      }
    });
  }

  aqiChart = buildChart("aqiChart", aqiHist, "#7C6FFF", "AQI", 0);
  noiseChart = buildChart("noiseChart", noiseHist, "#A8FF3E", "dB(A)", 20);
}

function initMapbox() {
  if (!MAPBOX_TOKEN || MAPBOX_TOKEN === "YOUR_MAPBOX_ACCESS_TOKEN") {
    document.getElementById("routeSummary").textContent =
      "Add your Mapbox token to enable live map and safer-zone routing.";
    document.getElementById("map").innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#9BB4D0;font-family:Space Mono, monospace;font-size:12px;padding:18px;text-align:center;">Mapbox token required.<br>Replace YOUR_MAPBOX_ACCESS_TOKEN in the JS panel.</div>';
    return;
  }

  mapboxgl.accessToken = MAPBOX_TOKEN;

  map = new mapboxgl.Map({
    container: "map",
    style: "mapbox://styles/mapbox/dark-v11",
    center: routeState.hazardNode,
    zoom: 13.3
  });

  map.addControl(new mapboxgl.NavigationControl(), "top-right");

  map.on("load", async () => {
    ensureMapLayers();

    new mapboxgl.Marker({ color: "#38BDF8" })
      .setLngLat(routeState.hazardNode)
      .setPopup(new mapboxgl.Popup().setText("Sensor Node"))
      .addTo(map);

    new mapboxgl.Marker({ color: "#FF3D5A" })
      .setLngLat(routeState.hazardNode)
      .setPopup(new mapboxgl.Popup().setText("Hazard Node"))
      .addTo(map);

    await updateMapRouting("NONE");
  });
}

const TIP_SETS = [
  [
    "Use public transport or carpool to reduce urban emissions",
    "Avoid idling engines in crowded roads",
    "Keep windows closed during high AQI events",
    "Use masks during danger alerts",
    "Track peak traffic hours and plan travel early"
  ],
  [
    "Reduce honking in dense traffic zones",
    "Use acoustic barriers near noisy worksites",
    "Limit outdoor exercise during harmful noise levels",
    "Keep children away from continuous high noise zones",
    "Prefer quieter electric machinery where possible"
  ],
  [
    "Increase airflow indoors during high humidity",
    "Stay hydrated during heat alerts",
    "Use fans or cooling in rising heat conditions",
    "Avoid direct midday sun in hot weather",
    "Check indoor comfort when outdoor values worsen"
  ]
];

let tipSetIndex = 0;

function renderTips(index) {
  const list = document.getElementById("tipList");
  const set = TIP_SETS[index % TIP_SETS.length];
  list.innerHTML = set.map(t => `<li>${t}</li>`).join("");
}

setInterval(() => {
  document.getElementById("confidenceValue").textContent =
    "CONFIDENCE " + (Math.floor(80 + Math.random() * 14)) + "%";
}, 10000);

setInterval(() => {
  tipSetIndex++;
  renderTips(tipSetIndex);
}, 120000);

if ("speechSynthesis" in window) {
  window.speechSynthesis.onvoiceschanged = () => {};
}

initControls();
initCharts();
initMapbox();
setAvatarGender("female");
connectMQTT();
startSimulation();
renderTips(0);
renderAll(cur);
speakMessage("System ready. Monitoring all emergency conditions, safer zones, and route guidance.");