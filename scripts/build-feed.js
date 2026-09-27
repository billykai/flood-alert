// สร้างไฟล์ข้อมูลสำหรับหน้าเว็บ — รันโดย GitHub Actions ทุก 15 นาที หรือ `npm run build:feed`
//   data/water.json  ระดับน้ำ/ฝนหนัก/เขื่อน ที่ย่อจาก ThaiWater แล้ว (ไม่กี่ร้อย KB แทน ~9MB)
//   data/feed.json   ข่าวน้ำท่วมจาก Google News RSS
// ถ้าแหล่งไหนดึงไม่สำเร็จ จะคงไฟล์เดิมไว้ ไม่เขียนทับด้วยข้อมูลว่าง
import { mkdir, writeFile } from "node:fs/promises";
import { THAIWATER_URL, parseThaiWater } from "../parse.js";

const OUT = new URL("../data/", import.meta.url);
const NEWS_QUERIES = ["น้ำท่วม", "น้ำล้นตลิ่ง", "ฝนตกหนัก น้ำป่า", "เขื่อน เร่งระบายน้ำ"];
const NEWS_MAX = 80;

async function fetchText(url, timeoutMs = 60000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": "FloodAlert/1.0 (+https://github.com)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

const decode = (s) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
};

function parseRss(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const source = tag(item, "source");
    const sourceUrl = (item.match(/<source url="([^"]+)"/) || [])[1] || "";
    let title = tag(item, "title");
    // Google News ต่อท้ายชื่อข่าวด้วย " - ชื่อสำนักข่าว"
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    return {
      title,
      source: sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, "") : source,
      link: tag(item, "link"),
      published: new Date(tag(item, "pubDate")).toISOString(),
    };
  });
}

async function buildNews() {
  const results = await Promise.allSettled(
    NEWS_QUERIES.map((q) =>
      fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:2d")}&hl=th&gl=TH&ceid=TH:th`)
    )
  );
  const seen = new Set();
  const news = results
    .flatMap((r) => (r.status === "fulfilled" ? parseRss(r.value) : []))
    .filter((n) => n.title && !seen.has(n.title) && seen.add(n.title))
    .sort((a, b) => b.published.localeCompare(a.published))
    .slice(0, NEWS_MAX);
  results.filter((r) => r.status === "rejected").forEach((r) => console.warn("news:", r.reason.message));
  if (!news.length) throw new Error("ไม่พบข่าวเลย");
  return news;
}

async function buildWater() {
  const data = parseThaiWater(JSON.parse(await fetchText(THAIWATER_URL, 120000)));
  if (!data.water.length) throw new Error("ไม่มีข้อมูลระดับน้ำ");
  return data;
}

await mkdir(OUT, { recursive: true });
const generated = new Date().toISOString();
let failed = 0;

for (const [file, build] of [["feed.json", buildNews], ["water.json", buildWater]]) {
  try {
    const result = await build();
    const body = file === "feed.json" ? { generated, news: result } : { generated, ...result };
    await writeFile(new URL(file, OUT), JSON.stringify(body));
    console.log(`✓ ${file}`, file === "feed.json" ? `${result.length} ข่าว` : `${result.water.length} สถานีน้ำ, ${result.rain.length} สถานีฝนหนัก, ${result.dams.length} เขื่อน`);
  } catch (err) {
    failed++;
    console.error(`✗ ${file} — คงไฟล์เดิมไว้:`, err.message);
  }
}
// ล้มเหลวทั้งหมดถึงจะนับว่า job fail (แจ้งเตือนใน GitHub)
if (failed === 2) process.exit(1);
