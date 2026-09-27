// แปลงข้อมูลดิบจาก ThaiWater (thailand_main ~9MB) ให้เหลือเฉพาะที่หน้าเว็บใช้
// ใช้ร่วมกันทั้งในเบราว์เซอร์ (app.js) และใน GitHub Actions (scripts/build-feed.js)
export const THAIWATER_URL = "https://api-v3.thaiwater.net/api/v1/thaiwater30/public/thailand_main";

// เก็บเฉพาะสถานีฝนตั้งแต่ระดับนี้ขึ้นไป (ฝนหนัก) เพื่อให้ไฟล์เล็ก
export const RAIN_MIN = 35;

const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
// API บางครั้งส่ง data กลับมาเป็น object แทน array — แปลงให้เป็น array เสมอ
const toArray = (x) => (Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x) : []);
const th = (o) => (o && (o.th || o.en)) || "";
const prov = (g) => th(g?.province_name);
const place = (g) => [th(g?.amphoe_name) && "อ." + th(g.amphoe_name), th(g?.province_name) && "จ." + th(g.province_name)].filter(Boolean).join(" ");

export function waterClass(pct) {
  if (pct === null) return "unknown";
  if (pct > 100) return "overflow";
  if (pct >= 70) return "high";
  return "normal";
}

export function parseThaiWater(json) {
  const water = toArray(json.waterlevel?.data?.data)
    .map((d) => {
      const pct = num(d.storage_percent);
      return {
        kind: "water",
        name: th(d.station?.tele_station_name),
        lat: d.station?.tele_station_lat, lng: d.station?.tele_station_long,
        pct, cls: waterClass(pct),
        wl: num(d.waterlevel_msl), prev: num(d.waterlevel_msl_previous),
        bank: num(d.station?.min_bank),
        diff: num(d.diff_wl_bank), diffText: d.diff_wl_bank_text || "",
        river: d.river_name || "",
        agency: th(d.agency?.agency_shortname),
        time: d.waterlevel_datetime, where: place(d.geocode), prov: prov(d.geocode),
      };
    })
    .filter((s) => s.lat && s.lng);

  const rain = toArray(json.rain?.data?.data)
    .map((d) => ({
      kind: "rain",
      name: th(d.station?.tele_station_name),
      lat: d.station?.tele_station_lat, lng: d.station?.tele_station_long,
      r24: num(d.rain_24h), r1: num(d.rain_1h),
      agency: th(d.agency?.agency_shortname),
      time: d.rainfall_datetime, where: place(d.geocode), prov: prov(d.geocode),
    }))
    .filter((s) => s.lat && s.lng && s.r24 !== null && s.r24 >= RAIN_MIN);

  const dams = toArray(json.dam?.data?.data)
    .map((d) => ({
      kind: "dam",
      name: th(d.dam?.dam_name),
      lat: d.dam?.dam_lat, lng: d.dam?.dam_long,
      pct: num(d.dam_storage_percent), storage: num(d.dam_storage),
      max: num(d.dam?.normal_storage),
      inflow: num(d.dam_inflow), released: num(d.dam_released),
      time: d.dam_date, where: place(d.geocode), prov: prov(d.geocode),
    }))
    .filter((s) => s.lat && s.lng);

  return { water, rain, dams };
}
