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

// ---------- Province filter ----------
// ชื่อที่ข่าวมักใช้แทนชื่อเต็มของจังหวัด
const PROV_ALIASES = { "กรุงเทพมหานคร": ["กรุงเทพ", "กทม"], "พระนครศรีอยุธยา": ["อยุธยา"] };
let rawData = null;
let province = new URLSearchParams(location.search).get("prov") || "";
let allNews = [];

// ข้อมูลเก่า (ก่อนมีฟิลด์ prov) ดึงชื่อจังหวัดจากข้อความ "อ.X จ.Y"
const provOf = (s) => s.prov || (s.where?.match(/จ\.(\S+)$/) || [])[1] || "";
const byProv = (arr) => (province ? arr.filter((s) => provOf(s) === province) : arr);

function renderWater(data) {
  const first = !rawData;
  rawData = data;
  buildProvinceOptions(data);
  drawWater({ water: byProv(data.water), rain: byProv(data.rain), dams: byProv(data.dams) });
  // เปิดจากลิงก์ที่มี ?prov= → ซูมไปจังหวัดนั้นตอนโหลดข้อมูลครั้งแรก
  if (first && province) fitProvince();
}

function buildProvinceOptions(data) {
  const stats = new Map();
  for (const s of [...data.water, ...data.rain, ...data.dams]) {
    const p = provOf(s);
    if (!p) continue;
    if (!stats.has(p)) stats.set(p, 0);
    if (s.cls === "overflow" || s.cls === "high") stats.set(p, stats.get(p) + 1);
  }
  if (province && !stats.has(province)) province = "";
  const opt = (p, n) => `<option value="${esc(p)}"${p === province ? " selected" : ""}>${esc(p)}${n ? ` · วิกฤต ${n}` : ""}</option>`;
  const all = [...stats].sort((a, b) => a[0].localeCompare(b[0], "th"));
  const hot = all.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  $("prov").innerHTML = `<option value="">ทั้งประเทศ</option>
    ${hot.length ? `<optgroup label="มีจุดน้ำมาก/ล้นตลิ่ง">${hot.map(([p, n]) => opt(p, n)).join("")}</optgroup>` : ""}
    <optgroup label="ทุกจังหวัด (ก–ฮ)">${all.map(([p]) => opt(p, 0)).join("")}</optgroup>`;
  // จังหวัดเดียวกันอยู่ได้ทั้งสองกลุ่ม — ให้ตัวที่เลือกเป็นอันแรกเสมอ
  $("prov").value = province;
}

function applyNewsFilter() {
  if (!province) { lists.news = allNews; return; }
  const names = [province, ...(PROV_ALIASES[province] || [])];
  lists.news = allNews.filter((n) => names.some((k) => n.title.includes(k)));
}

function setProvince(p) {
  province = p;
  const url = new URL(location.href);
  if (p) url.searchParams.set("prov", p); else url.searchParams.delete("prov");
  history.replaceState(null, "", url);
  $("prov").classList.toggle("active", !!p);
  applyNewsFilter();
  if (rawData) renderWater(rawData);
  else updateCounts();
  fitProvince();
}

function fitProvince() {
  const p = province;
  // กรองจากการ์ดค้างอยู่ → ซูมไปที่จุดของการ์ดในจังหวัดใหม่ ไม่งั้นซูมทั้งจังหวัด
  const pts = focus?.items.length ? focus.items
    : rawData ? [...rawData.water, ...rawData.rain, ...rawData.dams].filter((s) => p && provOf(s) === p) : [];
  if (pts.length === 1) map.flyTo([pts[0].lat, pts[0].lng], Math.max(map.getZoom(), 10), { duration: 0.8 });
  else if (pts.length) map.flyToBounds(L.latLngBounds(pts.map((s) => [s.lat, s.lng])).pad(0.2), { maxZoom: 10, duration: 0.8 });
  else if (!p) map.flyTo([13.2, 101.0], 6, { duration: 0.8 });
}
$("prov").addEventListener("change", (e) => setProvince(e.target.value));
$("prov").classList.toggle("active", !!province);

function drawWater(data) {
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
  // ข้อมูลรอบใหม่ → คำนวณจุดที่กรองไว้ใหม่ โดยไม่ขยับแผนที่
  if (focus) applyFocus(focus.key, false);
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
    head.innerHTML = `<span>${province ? `ข่าวที่กล่าวถึง จ.${esc(province)}` : newsGenerated ? "ดึงข่าวเมื่อ " + ago(newsGenerated) : "ข่าวจาก Google News"}</span>
      <a href="${X_URL}" target="_blank" rel="noopener">ดู #น้ำท่วม บน X ↗</a>`;
  } else if (currentTab === "gdacs") {
    head.hidden = false;
    head.innerHTML = `<span>เหตุการณ์น้ำท่วมจากระบบเตือนภัยโลก GDACS (แสดงบนแผนที่เฉพาะ ${GDACS_RECENT_DAYS} วันล่าสุด)</span>`;
  } else {
    head.hidden = true;
  }

  const items = currentItems().slice(0, 300);
  const ul = $("list");
  if (!items.length) {
    const where = province ? `ใน จ.${esc(province)}` : "";
    ul.innerHTML = `<li class="empty">${currentTab === "news" ? `ยังไม่มีข่าว${where ? "ที่กล่าวถึงจังหวัดนี้" : ""}` : `ไม่มีรายการ${where}`}</li>`;
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
  const s = currentItems()[Number(li.dataset.i)];
  // เปิด layer ที่เกี่ยวข้องก่อน ถ้าผู้ใช้ปิดไว้
  const toggle = { water: "t-water", rain: "t-rain", dam: "t-dam", gdacs: "t-gdacs" }[s.kind];
  if (!$(toggle).checked) { $(toggle).checked = true; applyToggles(); }
  const m = markerIndex.get(s);
  if (s.kind === "gdacs" && !m) {
    window.open(s.report, "_blank", "noopener");
    return;
  }
  if (!m) return;
  // จุดนี้ไม่อยู่ในตัวกรองจากการ์ด → ล้างตัวกรองก่อนให้จุดแสดงบนแผนที่
  if (focus && !focusLayer.hasLayer(m)) clearFocus();
  map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 10), { duration: 0.8 });
  map.once("moveend", () => m.openPopup());
});

function selectTab(tab) {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x.dataset.tab === tab));
  currentTab = tab;
  drawList();
  $("list").scrollTop = 0;
}
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));

// ---------- Toggles ----------
function setLayer(group, on) {
  if (on && !map.hasLayer(group)) group.addTo(map);
  if (!on && map.hasLayer(group)) map.removeLayer(group);
}
function applyToggles() {
  // โหมดกรองจากการ์ด: ซ่อนทุกชั้น แสดงเฉพาะจุดที่ตรงเงื่อนไข
  if (focus) {
    Object.values(layers).forEach((g) => setLayer(g, false));
    setLayer(gdacsLayer, false);
    setLayer(focusLayer, true);
    return;
  }
  setLayer(focusLayer, false);
  setLayer(layers.rain, $("t-rain").checked);
  setLayer(layers.waterNormal, $("t-water").checked && !$("t-critical").checked);
  setLayer(layers.waterCritical, $("t-water").checked);
  setLayer(layers.dam, $("t-dam").checked);
  setLayer(gdacsLayer, $("t-gdacs").checked);
}
// ผู้ใช้กดติ๊กชั้นข้อมูลระหว่างกรองจากการ์ด → ออกจากโหมดกรอง กลับไปใช้ checkbox ตามปกติ
["t-water", "t-rain", "t-dam", "t-gdacs", "t-critical"].forEach((id) =>
  $(id).addEventListener("change", () => (focus ? clearFocus() : applyToggles()))
);

// ---------- Card filters ----------
// กดการ์ดสรุป → แผนที่เหลือเฉพาะจุดของการ์ดนั้น และรายการด้านข้างกรองตาม กดซ้ำหรือ ✕ เพื่อล้าง
const FOCUS = {
  overflow: { label: "สถานีน้ำล้นตลิ่ง", tab: "stations", match: (s) => s.cls === "overflow" },
  high: { label: "น้ำมาก 70–100%", tab: "stations", match: (s) => s.cls === "high" },
  rainmax: { label: "ฝนสูงสุด 24 ชม.", tab: "rain", match: (s) => s === lists.rain[0] },
  heavy: { label: "ฝนหนักมาก >90 มม.", tab: "rain", match: (s) => s.r24 > 90 },
  dam: { label: "เขื่อนเกิน 80%", tab: "dams", match: (s) => s.pct > 80 },
};
const focusLayer = L.layerGroup();
let focus = null;

function currentItems() {
  return focus && focus.tab === currentTab ? focus.items : lists[currentTab];
}

function applyFocus(key, fly = true) {
  const def = FOCUS[key];
  const items = lists[def.tab].filter(def.match);
  focus = { key, ...def, items };
  focusLayer.clearLayers();
  items.forEach((s) => { const m = markerIndex.get(s); if (m) focusLayer.addLayer(m); });
  applyToggles();

  document.querySelectorAll(".card[data-focus]").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.focus === key)));
  $("focus-chip").hidden = false;
  $("focus-label").textContent = `${def.label} (${items.length})`;
  if (fly) selectTab(def.tab); else drawList();

  if (!fly || !items.length) return;
  if (items.length === 1) {
    const [s] = items;
    map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 10), { duration: 0.8 });
    map.once("moveend", () => markerIndex.get(s)?.openPopup());
  } else {
    map.flyToBounds(L.latLngBounds(items.map((s) => [s.lat, s.lng])).pad(0.15), { maxZoom: 9, duration: 0.8 });
  }
}

function clearFocus() {
  if (!focus) return;
  focus = null;
  setLayer(focusLayer, false);
  focusLayer.clearLayers();
  applyToggles();
  document.querySelectorAll(".card[data-focus]").forEach((c) => c.setAttribute("aria-pressed", "false"));
  $("focus-chip").hidden = true;
  drawList();
}

document.querySelectorAll(".card[data-focus]").forEach((card) => {
  const toggle = () => (focus?.key === card.dataset.focus ? clearFocus() : applyFocus(card.dataset.focus));
  card.addEventListener("click", toggle);
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });
});
$("focus-chip").addEventListener("click", clearFocus);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") clearFocus(); });

// ---------- Windy ----------
// Windy ให้ฝังได้เฉพาะแบบ iframe จึงแยกเป็นแผงของตัวเอง แล้วซิงก์ตำแหน่งกับแผนที่หลักเมื่อผู้ใช้กด
const windy = { overlay: "radar", lat: 13.2, lon: 101.0, zoom: 6 };

function updateWindy() {
  const { overlay, lat, lon, zoom } = windy;
  const p = new URLSearchParams({
    lat, lon, detailLat: lat, detailLon: lon, zoom,
    level: "surface", overlay, product: overlay === "radar" ? "radar" : "ecmwf",
    menu: "", message: "true", marker: "", calendar: "now", pressure: "", type: "map",
    location: "coordinates", detail: "", metricWind: "km/h", metricTemp: "°C", radarRange: "-1",
  });
  $("windy").src = `https://embed.windy.com/embed2.html?${p}`;
  $("windy-link").href = `https://www.windy.com/?${overlay},${lat},${lon},${zoom}`;
}

function syncWindyToMap() {
  const c = map.getCenter();
  windy.lat = +c.lat.toFixed(3);
  windy.lon = +c.lng.toFixed(3);
  // Windy ซูมได้ 3–11 และภาพดูใกล้กว่า Leaflet ราว 1 ระดับ
  windy.zoom = Math.min(11, Math.max(3, map.getZoom() - 1));
  updateWindy();
}

$("windy-overlay").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-overlay]");
  if (!btn || btn.dataset.overlay === windy.overlay) return;
  windy.overlay = btn.dataset.overlay;
  $("windy-overlay").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  updateWindy();
});
$("windy-sync").addEventListener("click", syncWindyToMap);
updateWindy();

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
    allNews = feed.news || [];
    applyNewsFilter();
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
