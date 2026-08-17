const http = require("node:http");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { chromium } = require("playwright");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.MONITOR_DATA_DIR || path.join(ROOT, "data");
const SCREENSHOTS_DIR = path.join(DATA_DIR, "screenshots");
const REPORTS_DIR = path.join(DATA_DIR, "reports");
const SNAPSHOTS_DIR = path.join(DATA_DIR, "snapshots");
const JST_OFFSET_HOURS = 9;
const CHROME_DEBUG_URL = process.env.CHROME_DEBUG_URL || "http://127.0.0.1:9222";

const targets = [
  { id: "rw-hero", brand: "Red Wing", type: "首页全页", screenshotMode: "full-page", url: "https://redwingheritage.jp/" },
  { id: "rw-men", brand: "Red Wing", type: "MEN 分类页", url: "https://redwingheritage.jp/category/MEN/" },
  { id: "ugg-hero", brand: "UGG", type: "首页全页", screenshotMode: "full-page", url: "https://www.ugg.com/jp/" },
  { id: "ugg-men", brand: "UGG", type: "男款新品页", url: "https://www.ugg.com/jp/men-new-arrivals/" },
  { id: "dm-hero", brand: "Dr. Martens", type: "首页全页", screenshotMode: "full-page", url: "https://jp.drmartens.com/home" },
  { id: "dm-new", brand: "Dr. Martens", type: "全新商品页", url: "https://jp.drmartens.com/all_new/" },
  { id: "cv-hero", brand: "Converse", type: "首页全页", screenshotMode: "full-page", url: "https://converse.co.jp/" },
  { id: "cv-men", brand: "Converse", type: "男款即将上市页", url: "https://converse.co.jp/collections/soon/mens" },
  { id: "nike-hero", brand: "Nike", type: "首页全页", screenshotMode: "full-page", url: "https://www.nike.com/jp/" },
  { id: "nike-men", brand: "Nike", type: "男款新品鞋页", url: "https://www.nike.com/jp/w/new-mens-shoes-3n82yznik1zy7ok" }
];

let isRunning = false;
let lastRun = null;

function tokyoParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
}

function tokyoDate(date = new Date()) {
  const { year, month, day } = tokyoParts(date);
  return `${year}-${month}-${day}`;
}

function nextElevenAmTokyo() {
  const now = new Date();
  const { year, month, day, hour } = tokyoParts(now);
  let next = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 2, 0, 0));
  if (Number(hour) >= 11) next = new Date(next.getTime() + 24 * 60 * 60 * 1000);
  return next;
}

async function ensureDirectories() {
  await Promise.all([DATA_DIR, SCREENSHOTS_DIR, REPORTS_DIR, SNAPSHOTS_DIR].map((dir) => fsp.mkdir(dir, { recursive: true })));
}

function cleanLines(text) {
  return [...new Set(
    text.split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length >= 3 && line.length <= 100)
      .filter((line) => !/^(search|menu|close|ログイン|検索|メニュー)$/i.test(line))
  )].slice(0, 80);
}

function getChanges(previous = [], current = []) {
  const oldSet = new Set(previous);
  const nowSet = new Set(current);
  return {
    added: current.filter((line) => !oldSet.has(line)).slice(0, 4),
    removed: previous.filter((line) => !nowSet.has(line)).slice(0, 3)
  };
}

function makeSummary(target, previous, currentLines) {
  if (!previous) {
    return {
      priority: "低",
      headline: "已建立首个页面基线",
      businessSummary: `已采集 ${target.brand} ${target.type} 的首张截图与可见文案。明天开始会自动对比变化。`,
      changes: []
    };
  }

  const { added, removed } = getChanges(previous.visibleLines || [], currentLines);
  if (added.length === 0 && removed.length === 0) {
    return {
      priority: "低",
      headline: "未检测到可见文案变化",
      businessSummary: `${target.brand} ${target.type} 未发现可见标题、商品或促销文案变动。`,
      changes: []
    };
  }

  const changes = [...added.map((line) => `新增：${line}`), ...removed.map((line) => `移除：${line}`)];
  const importantWords = /(new|new arrival|sale|off|限定|新作|新着|コラボ|discount|セール|発売|キャンペーン|free shipping)/i;
  const priority = changes.some((line) => importantWords.test(line)) ? "高" : "中";

  return {
    priority,
    headline: "检测到页面内容更新",
    businessSummary: `${target.brand} ${target.type} 出现 ${added.length} 条新增、${removed.length} 条移除的可见内容。建议结合截图确认是否涉及新品、主推款或促销更新。`,
    changes
  };
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function captureTarget(browser, target, date) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const snapshotPath = path.join(SNAPSHOTS_DIR, `${target.id}.json`);
  const previous = await readJson(snapshotPath);
  const screenshotName = `${target.id}.png`;

  try {
    page.setDefaultTimeout(15000);
    const navigation = await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      document.querySelectorAll('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i]').forEach((element) => {
        element.style.setProperty("display", "none", "important");
      });
    });

    const visibleText = await page.locator("body").innerText({ timeout: 15000 });
    const title = await page.title();
    const status = navigation?.status() || 200;
    if (
      status >= 400 ||
      /\b(403|404|access denied|request blocked|request could not be satisfied)\b/i.test(`${title}\n${visibleText}`)
    ) {
      throw new Error(`页面被拒绝或返回错误状态（HTTP ${status}）。`);
    }
    const visibleLines = cleanLines(visibleText);
    const screenshotFile = path.join(SCREENSHOTS_DIR, date, screenshotName);
    await page.screenshot({ path: screenshotFile, fullPage: target.screenshotMode === "full-page" });

    const summary = makeSummary(target, previous, visibleLines);
    const currentSnapshot = {
      capturedAt: new Date().toISOString(),
      visibleLines,
      screenshot: `/screenshots/${date}/${screenshotName}`,
      valid: true
    };
    await fsp.writeFile(snapshotPath, JSON.stringify(currentSnapshot, null, 2), "utf8");

    return {
      ...target,
      status: "success",
      capturedAt: currentSnapshot.capturedAt,
      screenshot: currentSnapshot.screenshot,
      previousScreenshot: previous?.screenshot || null,
      ...summary
    };
  } catch (error) {
    return {
      ...target,
      status: "error",
      priority: "低",
      headline: "采集失败",
      businessSummary: `未能采集页面：${error.message}`,
      changes: [],
      capturedAt: new Date().toISOString(),
      screenshot: previous?.valid ? previous.screenshot : null
    };
  } finally {
    await page.close();
  }
}

function reportInsight(items) {
  const changed = items.filter((item) => item.status === "success" && item.changes.length > 0);
  const high = changed.filter((item) => item.priority === "高");
  if (changed.length === 0) return "今日未检测到可见文案变化；页面截图已刷新。";
  if (high.length > 0) return `今日有 ${high.length} 个高优先级页面更新，重点关注新品、促销或 campaign 文案。`;
  return `今日有 ${changed.length} 个页面检测到内容更新，主要为页面文案或商品信息调整。`;
}

async function runMonitoring() {
  if (isRunning) return { running: true };
  isRunning = true;
  const startedAt = new Date().toISOString();
  const date = tokyoDate();
  try {
    await ensureDirectories();
    await fsp.mkdir(path.join(SCREENSHOTS_DIR, date), { recursive: true });
    let browser;
    let usesExistingChrome = false;
    try {
      browser = await chromium.connectOverCDP(CHROME_DEBUG_URL, { timeout: 8000 });
      usesExistingChrome = true;
      console.log(`Connected to monitoring Chrome: ${CHROME_DEBUG_URL}`);
    } catch {
      console.warn(`Monitoring Chrome is not available at ${CHROME_DEBUG_URL}; using isolated Chromium instead.`);
      browser = await chromium.launch({ headless: true });
    }
    const items = [];
    for (const target of targets) items.push(await captureTarget(browser, target, date));
    if (!usesExistingChrome) await browser.close();

    const report = {
      date,
      generatedAt: new Date().toISOString(),
      scheduledTime: "11:00 JST",
      browserMode: usesExistingChrome ? "Google Chrome（专用监控配置）" : "隔离 Chromium（备用）",
      insight: reportInsight(items),
      items
    };
    await fsp.writeFile(path.join(REPORTS_DIR, `${date}.json`), JSON.stringify(report, null, 2), "utf8");
    lastRun = { startedAt, completedAt: new Date().toISOString(), date, status: "success" };
    return report;
  } catch (error) {
    lastRun = { startedAt, completedAt: new Date().toISOString(), status: "error", error: error.message };
    throw error;
  } finally {
    isRunning = false;
  }
}

async function latestReport() {
  const today = await readJson(path.join(REPORTS_DIR, `${tokyoDate()}.json`));
  if (today) return today;
  const files = (await fsp.readdir(REPORTS_DIR)).filter((file) => file.endsWith(".json")).sort().reverse();
  if (files[0]) return readJson(path.join(REPORTS_DIR, files[0]));
  return {
    date: tokyoDate(),
    generatedAt: null,
    scheduledTime: "11:00 JST",
    insight: "等待今天 11:00（日本时间）的首次采集。",
    items: targets.map((target) => ({
      ...target,
      status: "waiting",
      priority: "低",
      headline: "等待首次采集",
      businessSummary: "系统会在每天 11:00（日本时间）抓取截图并生成摘要。",
      changes: [],
      screenshot: null
    }))
  };
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png"
};

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(payload));
}

function sendFile(response, filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!response.headersSent) response.writeHead(404);
    response.end("Not found");
  });
  response.writeHead(200, { "Content-Type": mimeTypes[extension] || "application/octet-stream" });
  stream.pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/report") return sendJson(response, 200, await latestReport());
    if (request.method === "GET" && url.pathname === "/api/status") {
      return sendJson(response, 200, { isRunning, lastRun, nextRunAt: nextElevenAmTokyo().toISOString() });
    }
    if (request.method === "POST" && url.pathname === "/api/run") {
      if (isRunning) return sendJson(response, 409, { error: "采集任务正在运行。" });
      runMonitoring().catch((error) => console.error("Monitoring run failed:", error));
      return sendJson(response, 202, { message: "已启动采集任务。" });
    }

    const requested = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "");
    const baseDir = url.pathname.startsWith("/screenshots/") ? SCREENSHOTS_DIR : PUBLIC_DIR;
    const relative = url.pathname.startsWith("/screenshots/") ? url.pathname.replace("/screenshots/", "") : requested;
    const filePath = path.join(baseDir, decodeURIComponent(relative));
    if (!filePath.startsWith(baseDir)) return sendJson(response, 403, { error: "Forbidden" });
    return sendFile(response, filePath);
  } catch (error) {
    return sendJson(response, 500, { error: error.message });
  }
});

function schedule() {
  const next = nextElevenAmTokyo();
  console.log(`Next monitoring run: ${next.toISOString()} (11:00 JST)`);
  setTimeout(async () => {
    try {
      await runMonitoring();
    } catch (error) {
      console.error(error);
    }
    schedule();
  }, Math.max(0, next.getTime() - Date.now()));
}

async function main() {
  await ensureDirectories();
  if (process.argv.includes("--run-now")) {
    const report = await runMonitoring();
    console.log(`Completed report for ${report.date}`);
    return;
  }
  server.listen(PORT, () => {
    console.log(`Competitor monitoring dashboard: http://localhost:${PORT}`);
    schedule();
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
