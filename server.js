const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
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
const CHROME_DEBUG_URL = process.env.CHROME_DEBUG_URL || "http://127.0.0.1:9222";

const targets = [
  { id: "rw-hero", brand: "Red Wing", type: "Homepage", homepage: true, url: "https://redwingheritage.jp/" },
  { id: "rw-men", brand: "Red Wing", type: "Men's Category", url: "https://redwingheritage.jp/category/MEN/" },
  { id: "ugg-hero", brand: "UGG", type: "Homepage", homepage: true, url: "https://www.ugg.com/jp/" },
  { id: "ugg-men", brand: "UGG", type: "Men's New Arrivals", url: "https://www.ugg.com/jp/men-new-arrivals/" },
  { id: "dm-hero", brand: "Dr. Martens", type: "Homepage", homepage: true, url: "https://jp.drmartens.com/home" },
  { id: "dm-new", brand: "Dr. Martens", type: "New Arrivals", url: "https://jp.drmartens.com/all_new/" },
  { id: "cv-hero", brand: "Converse", type: "Homepage", homepage: true, url: "https://converse.co.jp/" },
  { id: "cv-men", brand: "Converse", type: "Men's Coming Soon", url: "https://converse.co.jp/collections/soon/mens" },
  { id: "nike-hero", brand: "Nike", type: "Homepage", homepage: true, url: "https://www.nike.com/jp/" },
  { id: "nike-men", brand: "Nike", type: "Men's New Shoes", url: "https://www.nike.com/jp/w/new-mens-shoes-3n82yznik1zy7ok" }
];

let isRunning = false;
let lastRun = null;

function tokyoParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value])
  );
}

function tokyoDate(date = new Date()) {
  const { year, month, day } = tokyoParts(date);
  return `${year}-${month}-${day}`;
}

function isMondayTokyo(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    weekday: "long"
  }).format(date) === "Monday";
}

function getScreenshotMode(target, date = new Date()) {
  return target.homepage && isMondayTokyo(date) ? "full-page" : "viewport";
}

function nextElevenAmTokyo() {
  const now = new Date();
  const { year, month, day, hour } = tokyoParts(now);
  let next = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 2, 0, 0));
  if (Number(hour) >= 11) next = new Date(next.getTime() + 24 * 60 * 60 * 1000);
  return next;
}

async function ensureDirectories() {
  await Promise.all([DATA_DIR, SCREENSHOTS_DIR, REPORTS_DIR, SNAPSHOTS_DIR].map((directory) => fsp.mkdir(directory, { recursive: true })));
}

function cleanLines(text) {
  return [...new Set(
    text.split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter((line) => line.length >= 3 && line.length <= 120)
      .filter((line) => !/^(search|menu|close|log in|sign in|ログイン|検索|メニュー)$/i.test(line))
  )].slice(0, 100);
}

function getChanges(previous = [], current = []) {
  const previousSet = new Set(previous);
  const currentSet = new Set(current);
  return {
    added: current.filter((line) => !previousSet.has(line)).slice(0, 4),
    removed: previous.filter((line) => !currentSet.has(line)).slice(0, 3)
  };
}

function createSummary(target, previous, currentLines) {
  if (!previous?.valid) {
    return {
      priority: "Low",
      headline: "Baseline created",
      businessSummary: `The first screenshot and visible-text baseline for ${target.brand} ${target.type} has been captured. Changes will be compared from the next run.`,
      changes: []
    };
  }

  const { added, removed } = getChanges(previous.visibleLines || [], currentLines);
  if (added.length === 0 && removed.length === 0) {
    return {
      priority: "Low",
      headline: "No visible text changes detected",
      businessSummary: `No visible headline, product, or promotion copy changes were detected on ${target.brand} ${target.type}.`,
      changes: []
    };
  }

  const changes = [
    ...added.map((line) => `Added: ${line}`),
    ...removed.map((line) => `Removed: ${line}`)
  ];
  const highPriorityPattern = /(new arrival|new|sale|discount|off|collab|collaboration|limited|campaign|free shipping|発売|新着|新作|セール|限定|コラボ)/i;
  const priority = changes.some((line) => highPriorityPattern.test(line)) ? "High" : "Medium";

  return {
    priority,
    headline: "Page content update detected",
    businessSummary: `${target.brand} ${target.type} has ${added.length} added and ${removed.length} removed visible-text items. Review the screenshot to confirm whether the update relates to new products, hero products, or promotions.`,
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
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1
  });
  const snapshotPath = path.join(SNAPSHOTS_DIR, `${target.id}.json`);
  const previous = await readJson(snapshotPath);
  const mode = getScreenshotMode(target);
  const screenshotName = `${target.id}.png`;

  try {
    page.setDefaultTimeout(15000);
    const navigation = await page.goto(target.url, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      document.querySelectorAll('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i]').forEach((element) => {
        element.style.setProperty("display", "none", "important");
      });
    });

    const visibleText = await page.locator("body").innerText();
    const title = await page.title();
    const status = navigation?.status() || 200;
    if (status >= 400 || /\b(403|404|access denied|request blocked|request could not be satisfied)\b/i.test(`${title}\n${visibleText}`)) {
      throw new Error(`The site returned an error or blocked the browser request (HTTP ${status}).`);
    }

    const visibleLines = cleanLines(visibleText);
    const screenshotFile = path.join(SCREENSHOTS_DIR, date, screenshotName);
    await page.screenshot({ path: screenshotFile, fullPage: mode === "full-page" });

    const currentSnapshot = {
      capturedAt: new Date().toISOString(),
      visibleLines,
      screenshot: `/screenshots/${date}/${screenshotName}`,
      screenshotMode: mode,
      valid: true
    };
    await fsp.writeFile(snapshotPath, JSON.stringify(currentSnapshot, null, 2), "utf8");

    return {
      ...target,
      status: "success",
      capturedAt: currentSnapshot.capturedAt,
      screenshot: currentSnapshot.screenshot,
      previousScreenshot: previous?.valid ? previous.screenshot : null,
      screenshotMode: mode,
      ...createSummary(target, previous, visibleLines)
    };
  } catch (error) {
    return {
      ...target,
      status: "error",
      capturedAt: new Date().toISOString(),
      screenshot: previous?.valid ? previous.screenshot : null,
      screenshotMode: previous?.screenshotMode || mode,
      priority: "Low",
      headline: "Capture failed",
      businessSummary: `The page could not be captured: ${error.message}`,
      changes: []
    };
  } finally {
    await page.close();
  }
}

function reportInsight(items) {
  const changed = items.filter((item) => item.status === "success" && item.changes.length > 0);
  const highPriority = changed.filter((item) => item.priority === "High");
  if (changed.length === 0) return "No visible text changes were detected today; screenshots have been refreshed.";
  if (highPriority.length > 0) return `${highPriority.length} high-priority page update(s) were detected today. Review new products, promotions, and campaign copy first.`;
  return `${changed.length} page(s) showed content updates today, mainly in product information or page copy.`;
}

async function connectBrowser() {
  try {
    const browser = await chromium.connectOverCDP(CHROME_DEBUG_URL, { timeout: 8000 });
    console.log(`Connected to monitoring Chrome: ${CHROME_DEBUG_URL}`);
    return { browser, browserMode: "Google Chrome (dedicated monitoring profile)", closeWhenDone: false };
  } catch {
    console.warn(`Monitoring Chrome is unavailable at ${CHROME_DEBUG_URL}; using isolated Chromium.`);
    const browser = await chromium.launch({ headless: true });
    return { browser, browserMode: "Isolated Chromium (fallback)", closeWhenDone: true };
  }
}

async function runMonitoring() {
  if (isRunning) return { running: true };
  isRunning = true;
  const startedAt = new Date().toISOString();
  const date = tokyoDate();

  try {
    await ensureDirectories();
    await fsp.mkdir(path.join(SCREENSHOTS_DIR, date), { recursive: true });
    const { browser, browserMode, closeWhenDone } = await connectBrowser();
    const items = [];
    for (const target of targets) items.push(await captureTarget(browser, target, date));
    if (closeWhenDone) await browser.close();

    const report = {
      date,
      generatedAt: new Date().toISOString(),
      scheduledTime: "11:00 JST",
      capturePlan: isMondayTokyo() ? "Monday full-page homepage archive" : "Daily viewport capture",
      browserMode,
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

function waitingReport() {
  return {
    date: tokyoDate(),
    generatedAt: null,
    scheduledTime: "11:00 JST",
    capturePlan: isMondayTokyo() ? "Monday full-page homepage archive" : "Daily viewport capture",
    insight: "Waiting for the first capture at 11:00 JST.",
    items: targets.map((target) => ({
      ...target,
      status: "waiting",
      priority: "Low",
      headline: "Waiting for first capture",
      businessSummary: "The system captures screenshots and generates a summary every day at 11:00 JST.",
      changes: [],
      screenshot: null,
      screenshotMode: getScreenshotMode(target)
    }))
  };
}

function normalizeReport(report) {
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const items = (report.items || []).map((item) => {
    const target = targetById.get(item.id);
    const priority = ["High", "Medium", "Low"].includes(item.priority) ? item.priority : "Low";
    const hasLegacyCopy = /[\uFFFD\u3040-\u30ff\u3400-\u9fff]/.test(`${item.headline || ""}${item.businessSummary || ""}`);
    const defaultHeadline = item.status === "error" ? "Capture failed" : "Existing screenshot available";
    const defaultSummary = item.status === "error"
      ? "The previous capture failed. Run the dashboard again to refresh this result."
      : "This is an existing screenshot from the last completed capture. The next run will generate an English summary.";

    return {
      ...item,
      ...(target || {}),
      priority,
      headline: hasLegacyCopy ? defaultHeadline : (item.headline || defaultHeadline),
      businessSummary: hasLegacyCopy ? defaultSummary : (item.businessSummary || defaultSummary),
      changes: hasLegacyCopy ? [] : (item.changes || []),
      screenshotMode: item.screenshotMode || getScreenshotMode(target || item)
    };
  });

  return {
    ...report,
    capturePlan: report.capturePlan || (isMondayTokyo() ? "Monday full-page homepage archive" : "Daily viewport capture"),
    insight: /[\uFFFD\u3040-\u30ff\u3400-\u9fff]/.test(report.insight || "")
      ? "Existing screenshots are available. The next capture will generate an English daily overview."
      : (report.insight || reportInsight(items)),
    items
  };
}

async function latestReport() {
  const today = await readJson(path.join(REPORTS_DIR, `${tokyoDate()}.json`));
  if (today) return normalizeReport(today);
  const files = (await fsp.readdir(REPORTS_DIR)).filter((file) => file.endsWith(".json")).sort().reverse();
  return files.length > 0
    ? normalizeReport(await readJson(path.join(REPORTS_DIR, files[0])))
    : waitingReport();
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png"
};

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sendFile(response, filePath) {
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    if (!response.headersSent) response.writeHead(404);
    response.end("Not found");
  });
  response.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream" });
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
      if (isRunning) return sendJson(response, 409, { error: "A capture run is already in progress." });
      runMonitoring().catch((error) => console.error("Monitoring run failed:", error));
      return sendJson(response, 202, { message: "Capture run started." });
    }

    const isScreenshot = url.pathname.startsWith("/screenshots/");
    const baseDirectory = isScreenshot ? SCREENSHOTS_DIR : PUBLIC_DIR;
    const relativePath = isScreenshot
      ? url.pathname.replace("/screenshots/", "")
      : (url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, ""));
    const filePath = path.join(baseDirectory, decodeURIComponent(relativePath));
    if (!filePath.startsWith(baseDirectory)) return sendJson(response, 403, { error: "Forbidden" });
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
