// FloodAlert — แผนที่ระดับน้ำ ฝน 24 ชม. เขื่อน ข่าว และ GDACS
import { THAIWATER_URL, parseThaiWater } from "./parse.js";

const GDACS_URL = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=FL&country=Thailand";
const X_URL = "https://x.com/search?q=" + encodeURIComponent("#น้ำท่วม") + "&f=live";
const WATER_REFRESH_MS = 10 * 60 * 1000;
const FEED_REFRESH_MS = 5 * 60 * 1000;
// ถ้าไฟล์ data/water.json จาก GitHub Actions เก่ากว่านี้ ให้ดึงสดจาก ThaiWater แทน
const SNAPSHOT_STALE_MS = 45 * 60 * 1000;
const NEW_NEWS_MS = 60 * 60 * 1000;
const GDACS_RECENT_DAYS = 14;
const CACHE_KEY = "floodalert:data:v1";

const COLORS = {
  red: "#ff4d6d", orange: "#ffa53b", normal: "#4a6b76",
  violet: "#8b8cff", blue: "#6ea8ff", cyan: "#2bc4d9", gdacs: "#c77dff",
};
const GDACS_LEVEL = { Red: ["แดง", COLORS.red], Orange: ["ส้ม", COLORS.orange], Green: ["เขียว", "#22c55e"] };

// ---------- Map ----------
const map = L.map("map", { preferCanvas: true, zoomControl: true }).setView([13.2, 101.0], 6);
const esri = (layer) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_${layer}/MapServer/tile/{z}/{y}/{x}`;
L.tileLayer(esri("Base"), { maxZoom: 16, attribution: "Tiles © Esri" }).addTo(map);
L.tileLayer(esri("Reference"), { maxZoom: 16, pane: "overlayPane" }).addTo(map);

const layers = {
  waterNormal: L.layerGroup(),
  waterCritical: L.layerGroup(),
  rain: L.layerGroup(),
  dam: L.layerGroup(),
};
const gdacsLayer = L.layerGroup();

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "–" : v.toLocaleString("th-TH", { maximumFractionDigits: d, minimumFractionDigits: d }));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hhmm = (d) => d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
const dateTh = (d) => d.toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" });
function ago(iso) {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (min < 1) return "เมื่อสักครู่";
  if (min < 60) return `${min} นาทีที่แล้ว`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} ชั่วโมงที่แล้ว`;
  return `${Math.floor(min / 1440)} วันที่แล้ว`;
}
const colorFor = (s) => (s.cls === "overflow" ? COLORS.red : s.cls === "high" ? COLORS.orange : COLORS.normal);

// ---------- Popups ----------
function waterPopup(s) {
  const trend = s.wl !== null && s.prev !== null ? (s.wl > s.prev ? "▲ ขึ้น" : s.wl < s.prev ? "▼ ลง" : "ทรงตัว") : "";
  return `<b>${esc(s.name)}</b><br><span class="muted">${esc(s.where)}${s.river ? " · " + esc(s.river) : ""}</span><br>
    ความจุลำน้ำ <b style="color:${colorFor(s)}">${fmt(s.pct)}%</b> ${trend}<br>
    ระดับน้ำ ${fmt(s.wl, 2)} ม.รทก. · ตลิ่ง ${fmt(s.bank, 2)} ม.รทก.<br>
    ${s.diffText ? esc(s.diffText) + " " + fmt(s.diff, 2) + "<br>" : ""}
    <span class="muted">${esc(s.agency)} · ${esc(s.time)}</span>`;
}
function rainPopup(s) {
  return `<b>${esc(s.name)}</b><br><span class="muted">${esc(s.where)}</span><br>
    ฝน 24 ชม. <b style="color:${s.r24 > 90 ? COLORS.violet : COLORS.blue}">${fmt(s.r24)} มม.</b><br>
    ฝน 1 ชม. ${fmt(s.r1)} มม.<br><span class="muted">${esc(s.agency)} · ${esc(s.time)}</span>`;
}
function damPopup(s) {
  return `<b>เขื่อน${esc(s.name)}</b><br><span class="muted">${esc(s.where)}</span><br>
    ปริมาตรน้ำ <b style="color:${s.pct > 80 ? COLORS.red : COLORS.cyan}">${fmt(s.pct)}%</b> (${fmt(s.storage)} / ${fmt(s.max, 0)} ล้าน ลบ.ม.)<br>
    น้ำไหลเข้า ${fmt(s.inflow, 2)} · ระบาย ${fmt(s.released, 2)} ล้าน ลบ.ม.<br>
    <span class="muted">ข้อมูลวันที่ ${esc(s.time)}</span>`;
}
function gdacsPopup(e) {
  const [lvl, color] = GDACS_LEVEL[e.level] || [e.level, COLORS.gdacs];
  return `<b>${esc(e.name)}</b><br>
    ระดับเตือน <b style="color:${color}">${esc(lvl)}</b>${e.current ? " · ยังดำเนินอยู่" : ""}<br>
    ${dateTh(new Date(e.from))} – ${dateTh(new Date(e.to))}<br>
    <a href="${esc(e.report)}" target="_blank" rel="noopener">รายงาน GDACS ↗</a>`;
}

// ---------- Render water data ----------
const markerIndex = new Map();

function renderWater(data) {
  Object.values(layers).forEach((g) => g.clearLayers());
  [...markerIndex.keys()].filter((k) => k.kind !== "gdacs").forEach((k) => markerIndex.delete(k));

  // ฝนหนัก (วาดก่อนให้อยู่ใต้จุดระดับน้ำ)
  data.rain.forEach((s) => {
    const heavy = s.r24 > 90;
    const m = L.circleMarker([s.lat, s.lng], {
      radius: heavy ? 8 : 6, weight: 2,
      color: heavy ? COLORS.violet : COLORS.blue,
      fillColor: COLORS.violet, fillOpacity: heavy ? 0.35 : 0.05, opacity: 0.85,
    }).bindPopup(() => rainPopup(s));
    layers.rain.addLayer(m);
    markerIndex.set(s, m);
  });

  // ระดับน้ำ: สถานีปกติแยก layer เพื่อซ่อนด้วยตัวกรอง "เฉพาะน้ำมาก/ล้นตลิ่ง"
  [...data.water].sort((a, b) => (a.pct ?? -1) - (b.pct ?? -1)).forEach((s) => {
    const critical = s.cls === "overflow" || s.cls === "high";
    const m = L.circleMarker([s.lat, s.lng], {
      radius: s.cls === "overflow" ? 7 : critical ? 6 : 4,
      weight: critical ? 1.5 : 1, color: critical ? "#0b1418" : COLORS.normal,
      fillColor: colorFor(s), fillOpacity: critical ? 0.95 : 0.5,
    }).bindPopup(() => waterPopup(s));
    (critical ? layers.waterCritical : layers.waterNormal).addLayer(m);
    markerIndex.set(s, m);
  });

  data.dams.forEach((s) => {
    const icon = L.divIcon({ className: "", html: `<div class="dam-icon${s.pct > 80 ? " hot" : ""}"></div>`, iconSize: [12, 12] });
    const m = L.marker([s.lat, s.lng], { icon, zIndexOffset: 500 }).bindPopup(() => damPopup(s));
    layers.dam.addLayer(m);
    markerIndex.set(s, m);
  });

  applyToggles();
  renderCards(data);

  lists.stations = data.water.filter((s) => s.cls === "overflow" || s.cls === "high").sort((a, b) => b.pct - a.pct);
  lists.dams = [...data.dams].sort((a, b) => b.pct - a.pct);
  lists.rain = [...data.rain].sort((a, b) => b.r24 - a.r24);
  updateCounts();
}

function renderCards(data) {
  const reporting = data.water.filter((s) => s.pct !== null);
  const overflow = reporting.filter((s) => s.cls === "overflow");
  const high = reporting.filter((s) => s.cls === "high");
  const rising = [...overflow, ...high].filter((s) => s.wl !== null && s.prev !== null && s.wl > s.prev);

  $("k-overflow").textContent = overflow.length.toLocaleString();
  $("k-overflow-sub").textContent = `จาก ${reporting.length.toLocaleString()} สถานีที่รายงานล่าสุด`;
  $("k-high").textContent = high.length.toLocaleString();
  $("k-high-sub").textContent = `${rising.length} สถานี (มาก+ล้นตลิ่ง) ระดับน้ำกำลังขึ้น`;

  const top = data.rain.reduce((a, b) => (b.r24 > (a?.r24 ?? -1) ? b : a), null);
  $("k-rainmax").innerHTML = top ? `${fmt(top.r24)}<small>มม.</small>` : "–";
  $("k-rainmax-sub").textContent = top ? `${top.name} ${top.where}` : "ไม่มีฝนหนัก";

  const veryHeavy = data.rain.filter((s) => s.r24 > 90).length;
  $("k-heavy").textContent = veryHeavy.toLocaleString();
  $("k-heavy-sub").textContent = `ฝนหนัก 35–90 มม. อีก ${(data.rain.length - veryHeavy).toLocaleString()} สถานี`;

  const hot = data.dams.filter((d) => d.pct > 80);
  const topDam = data.dams.reduce((a, b) => (b.pct > (a?.pct ?? -1) ? b : a), null);
  $("k-dam").textContent = `${hot.length}/${data.dams.length}`;
  $("k-dam-sub").textContent = topDam ? `สูงสุด: ${topDam.name} ${fmt(topDam.pct)}%` : "";
}

// ---------- GDACS ----------
function renderGdacs(geo) {
  gdacsLayer.clearLayers();
  const cutoff = Date.now() - GDACS_RECENT_DAYS * 86400000;
  const events = (geo.features || [])
    .map((f) => ({
      kind: "gdacs",
      name: f.properties.name,
      level: f.properties.alertlevel,
      current: f.properties.iscurrent === "true",
      from: f.properties.fromdate, to: f.properties.todate,
      report: f.properties.url?.report || "https://www.gdacs.org",
      lat: f.geometry?.coordinates?.[1], lng: f.geometry?.coordinates?.[0],
    }))
    .filter((e) => e.lat && e.lng)
    .sort((a, b) => b.to.localeCompare(a.to));

  // บนแผนที่แสดงเฉพาะเหตุการณ์ที่ยังดำเนินอยู่หรือเพิ่งจบไม่เกิน 14 วัน
  events.filter((e) => e.current || Date.parse(e.to) > cutoff).forEach((e) => {
    const icon = L.divIcon({ className: "", html: `<div class="gdacs-icon" style="--c:${(GDACS_LEVEL[e.level] || [])[1] || COLORS.gdacs}"></div>`, iconSize: [16, 16] });
    const m = L.marker([e.lat, e.lng], { icon, zIndexOffset: 800 }).bindPopup(() => gdacsPopup(e));
    gdacsLayer.addLayer(m);
    markerIndex.set(e, m);
  });
  lists.gdacs = events.slice(0, 30);
  updateCounts();
}

// ---------- Side panel ----------
let currentTab = "news";
const lists = { news: [], stations: [], dams: [], rain: [], gdacs: [] };
let newsGenerated = null;

function updateCounts() {
  for (const k of Object.keys(lists)) $("n-" + k).textContent = lists[k].length || "";
  drawList();
}

function drawList() {
  const head = $("list-head");
  if (currentTab === "news") {
    head.hidden = false;
    head.innerHTML = `<span>${newsGenerated ? "ดึงข่าวเมื่อ " + ago(newsGenerated) : "ข่าวจาก Google News"}</span>
      <a href="${X_URL}" target="_blank" rel="noopener">ดู #น้ำท่วม บน X ↗</a>`;
  } else if (currentTab === "gdacs") {
    head.hidden = false;
    head.innerHTML = `<span>เหตุการณ์น้ำท่วมจากระบบเตือนภัยโลก GDACS (แสดงบนแผนที่เฉพาะ ${GDACS_RECENT_DAYS} วันล่าสุด)</span>`;
  } else {
    head.hidden = true;
  }

  const items = lists[currentTab].slice(0, 300);
  const ul = $("list");
  if (!items.length) {
    ul.innerHTML = `<li class="empty">${currentTab === "news" ? "ยังไม่มีข่าว" : "ไม่มีรายการ"}</li>`;
    return;
  }
  if (currentTab === "news") {
    ul.innerHTML = items.map((n) => {
      const fresh = Date.now() - Date.parse(n.published) < NEW_NEWS_MS;
      return `<li class="news"><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a>
        <span class="meta">${fresh ? '<span class="badge">ใหม่</span>' : ""}${esc(n.source)} · ${ago(n.published)}</span></li>`;
    }).join("");
    return;
  }
  ul.innerHTML = items.map((s, i) => {
    let val, color, title = s.name, where = s.where;
    if (s.kind === "rain") { val = `${fmt(s.r24)} มม.`; color = s.r24 > 90 ? COLORS.violet : COLORS.blue; }
    else if (s.kind === "dam") { val = `${fmt(s.pct)}%`; color = s.pct > 80 ? COLORS.red : COLORS.cyan; title = "เขื่อน" + s.name; }
    else if (s.kind === "gdacs") {
      [val, color] = GDACS_LEVEL[s.level] || [s.level, COLORS.gdacs];
      where = `${dateTh(new Date(s.from))} – ${dateTh(new Date(s.to))}${s.current ? " · ยังดำเนินอยู่" : ""}`;
    }
    else { val = `${fmt(s.pct)}%`; color = colorFor(s); }
    return `<li data-i="${i}"><span class="name">${esc(title)}</span><span class="num" style="color:${color}">${esc(val)}</span><span class="where">${esc(where)}</span></li>`;
  }).join("");
}

$("list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-i]");
  if (!li) return;
  const s = lists[currentTab][Number(li.dataset.i)];
  // เปิด layer ที่เกี่ยวข้องก่อน ถ้าผู้ใช้ปิดไว้
  const toggle = { water: "t-water", rain: "t-rain", dam: "t-dam", gdacs: "t-gdacs" }[s.kind];
  if (!$(toggle).checked) { $(toggle).checked = true; applyToggles(); }
  const m = markerIndex.get(s);
  if (s.kind === "gdacs" && !m) {
    window.open(s.report, "_blank", "noopener");
    return;
  }
  if (!m) return;
  map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 10), { duration: 0.8 });
  map.once("moveend", () => m.openPopup());
});

document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    currentTab = b.dataset.tab;
    drawList();
    $("list").scrollTop = 0;
  })
);

// ---------- Toggles ----------
function setLayer(group, on) {
  if (on && !map.hasLayer(group)) group.addTo(map);
  if (!on && map.hasLayer(group)) map.removeLayer(group);
}
function applyToggles() {
  setLayer(layers.rain, $("t-rain").checked);
  setLayer(layers.waterNormal, $("t-water").checked && !$("t-critical").checked);
  setLayer(layers.waterCritical, $("t-water").checked);
  setLayer(layers.dam, $("t-dam").checked);
  setLayer(gdacsLayer, $("t-gdacs").checked);
}
["t-water", "t-rain", "t-dam", "t-gdacs", "t-critical"].forEach((id) => $(id).addEventListener("change", applyToggles));

// ---------- Load ----------
function setStatus(state, text) {
  $("status").className = "status " + state;
  $("status-text").textContent = text;
}
async function getJson(url, opts) {
  const res = await fetch(url, { cache: "no-store", ...opts });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function loadWater() {
  // 1) ไฟล์ย่อจาก GitHub Actions (~400KB) โหลดเร็ว
  let snap = null;
  try {
    snap = await getJson(`data/water.json?t=${Date.now()}`);
    if (snap.water?.length) {
      renderWater(snap);
      setStatus("ok", `อัปเดต ${hhmm(new Date(snap.generated))}`);
    }
  } catch (err) {
    console.warn("ไม่มี data/water.json", err.message);
  }
  if (snap?.water?.length && Date.now() - Date.parse(snap.generated) < SNAPSHOT_STALE_MS) return;

  // 2) ไฟล์เก่าหรือไม่มี → ดึงสดจาก ThaiWater (~9MB)
  try {
    if (!snap) setStatus("", "กำลังโหลดข้อมูลสด…");
    const data = parseThaiWater(await getJson(THAIWATER_URL));
    if (!data.water.length) throw new Error("ข้อมูลว่าง");
    renderWater(data);
    setStatus("ok", `อัปเดต ${hhmm(new Date())}`);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), data })); } catch {}
  } catch (err) {
    console.error("โหลดข้อมูลสดไม่สำเร็จ", err);
    if (snap?.water?.length) {
      setStatus("err", `ข้อมูลเมื่อ ${hhmm(new Date(snap.generated))} (ดึงข้อมูลสดไม่ได้)`);
      return;
    }
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(CACHE_KEY)); } catch {}
    if (cached?.data) {
      renderWater(cached.data);
      setStatus("err", `ออฟไลน์ · ใช้ข้อมูลเมื่อ ${hhmm(new Date(cached.t))}`);
    } else {
      setStatus("err", "โหลดข้อมูลไม่สำเร็จ");
    }
  }
}

async function loadNews() {
  try {
    const feed = await getJson(`data/feed.json?t=${Date.now()}`);
    lists.news = feed.news || [];
    newsGenerated = feed.generated;
    updateCounts();
  } catch (err) {
    console.warn("โหลดข่าวไม่สำเร็จ", err.message);
  }
}

async function loadGdacs() {
  try {
    renderGdacs(await getJson(GDACS_URL));
  } catch (err) {
    console.warn("โหลด GDACS ไม่สำเร็จ", err.message);
  }
}

loadWater();
loadNews();
loadGdacs();
setInterval(loadWater, WATER_REFRESH_MS);
setInterval(() => { loadNews(); loadGdacs(); }, FEED_REFRESH_MS);
// อัปเดตข้อความ "x นาทีที่แล้ว" ทุกนาที
setInterval(() => { if (currentTab === "news") drawList(); }, 60000);
