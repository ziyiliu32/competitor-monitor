const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.MONITOR_DATA_DIR || path.join(ROOT, "data");
const SCREENSHOTS_DIR = path.join(DATA_DIR, "screenshots");
const REPORTS_DIR = path.join(DATA_DIR, "reports");
const SNAPSHOTS_DIR = path.join(DATA_DIR, "snapshots");
const CHROME_DEBUG_URL = process.env.CHROME_DEBUG_URL || "http://127.0.0.1:9222";
const CHROME_EXECUTABLE = process.env.CHROME_EXECUTABLE || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const CHROME_PROFILE_DIR = process.env.CHROME_PROFILE_DIR || path.join(ROOT, "chrome-profile");

const targets = [
  { id: "rw-hero", brand: "Red Wing", type: "Homepage", kind: "hero", homepage: true, url: "https://redwingheritage.jp/" },
  { id: "rw-men", brand: "Red Wing", type: "Men's Category", kind: "plp", url: "https://redwingheritage.jp/category/MEN/" },
  { id: "ugg-hero", brand: "UGG", type: "Homepage", kind: "hero", homepage: true, url: "https://www.ugg.com/jp/" },
  { id: "ugg-men", brand: "UGG", type: "Men's New Arrivals", kind: "plp", url: "https://www.ugg.com/jp/men-new-arrivals/" },
  { id: "dm-hero", brand: "Dr. Martens", type: "Homepage", kind: "hero", homepage: true, url: "https://jp.drmartens.com/home" },
  { id: "dm-new", brand: "Dr. Martens", type: "New Arrivals", kind: "plp", url: "https://jp.drmartens.com/all_new/" },
  { id: "cv-hero", brand: "Converse", type: "Homepage", kind: "hero", homepage: true, url: "https://converse.co.jp/" },
  { id: "cv-men", brand: "Converse", type: "Men's Coming Soon", kind: "plp", url: "https://converse.co.jp/collections/soon/mens" },
  { id: "nike-hero", brand: "Nike", type: "Homepage", kind: "hero", homepage: true, url: "https://www.nike.com/jp/" },
  { id: "nike-men", brand: "Nike", type: "Men's New Shoes", kind: "plp", url: "https://www.nike.com/jp/w/new-mens-shoes-3n82yznik1zy7ok" }
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

function uniqueShortLines(items, limit = 6) {
  return [...new Set(
    items
      .map((item) => String(item || "").replace(/\s+/g, " ").trim())
      .filter((item) => item.length >= 3 && item.length <= 120)
  )].slice(0, limit);
}

function cleanLines(text) {
  return uniqueShortLines(
    text.split("\n").filter((line) => !/^(search|menu|close|log in|sign in)$/i.test(line)),
    100
  );
}

function getChanges(previous = [], current = []) {
  const previousSet = new Set(previous);
  const currentSet = new Set(current);
  return {
    added: current.filter((line) => !previousSet.has(line)).slice(0, 4),
    removed: previous.filter((line) => !currentSet.has(line)).slice(0, 3)
  };
}

async function extractPageSignals(page, kind) {
  return page.evaluate((pageKind) => {
    const text = (element) => (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const inViewport = (element) => {
      const rect = element.getBoundingClientRect();
      return isVisible(element) && rect.top < window.innerHeight && rect.bottom > 0;
    };
    const collect = (selector, predicate, limit = 8) => {
      const output = [];
      for (const element of document.querySelectorAll(selector)) {
        if (!predicate(element)) continue;
        const value = text(element);
        if (value) output.push(value);
        if (output.length >= limit) break;
      }
      return [...new Set(output)];
    };

    const headings = collect("h1, h2, h3, [role='heading']", inViewport, 5);
    const actions = collect("a, button", inViewport, 6);
    const bodyText = text(document.body);
    const hasFilter = /\b(filter|filters|size|color|category|collection)\b/i.test(bodyText);
    const hasSort = /\b(sort|sort by|recommended|newest|price)\b/i.test(bodyText);
    const hasSearch = /\b(search|search products)\b/i.test(bodyText);
    const hasPromo = /\b(new|sale|limited|exclusive|discount|off)\b/i.test(bodyText);

    if (pageKind === "hero") {
      return {
        headings,
        heroText: collect("main h1, main h2, main h3, main p, main span, main a, main button, [role='main'] h1, [role='main'] h2, [role='main'] p, [role='main'] a, [role='main'] button", inViewport, 24),
        actions: collect("main a, main button, [role='main'] a, [role='main'] button", inViewport, 6),
        hasPromo,
        visibleImageCount: [...document.images].filter(inViewport).length
      };
    }

    const main = document.querySelector("main") || document.body;
    const productLinks = collect("main a, [role='main'] a", (element) => {
      if (!isVisible(element)) return false;
      const href = element.getAttribute("href") || "";
      return /product|products|item|style|shoe|boot|sneaker/i.test(href) && text(element).length >= 3;
    }, 12);
    const productImages = [...main.querySelectorAll("img")].filter(isVisible).map((image) => image.alt).filter(Boolean).slice(0, 12);

    return {
      headings,
      productLinks,
      productImages,
      hasFilter,
      hasSort,
      hasSearch,
      hasPromo,
      visibleImageCount: [...main.querySelectorAll("img")].filter(isVisible).length
    };
  }, kind);
}

function productTypeSummary(signals, fallbackType) {
  const source = uniqueShortLines([...(signals.productLinks || []), ...(signals.productImages || []), ...(signals.headings || [])], 18).join(" ");
  const categories = [
    ["boots", /\bboot|moc\b/i],
    ["shoes", /\bshoe|sneaker|trainer|loafer|oxford|slip-on\b/i],
    ["sandals", /\bsandal|slide|slipper\b/i],
    ["apparel", /\bshirt|jacket|hoodie|pant|short|dress|apparel\b/i],
    ["accessories", /\bbag|cap|hat|sock|accessor/i]
  ].filter(([, pattern]) => pattern.test(source)).map(([name]) => name);

  if (categories.length > 0) return `Visible assortment includes ${categories.join(", ")}.`;
  if (signals.headings?.[0]) return `The page is organized around "${signals.headings[0]}".`;
  return `The page presents the ${fallbackType.toLowerCase()} assortment through a product grid.`;
}

function createHeroAnalysis(target, signals) {
  const heroMessage = signals.headings?.[0] || "";
  const supportingMessage = signals.headings?.slice(1, 3).join(" | ");
  const ctas = uniqueShortLines(signals.actions || [], 4).filter((action) => action.length <= 40);
  const source = `${heroMessage} ${supportingMessage} ${(signals.heroText || []).join(" ")} ${ctas.join(" ")}`.toLowerCase();
  const isSale = /\b(final sale|sale|discount|off|promotion|promo)\b|\u30bb\u30fc\u30eb|\u5272\u5f15|\u5024\u4e0b\u3052/.test(source);
  const isNew = /\b(new arrival|new|launch|drop|latest)\b|\u65b0\u4f5c|\u65b0\u7740|\u65b0\u767a\u58f2|\u767a\u58f2/.test(source);
  const isCollab = /\b(collab|collaboration|collection|skims)\b|\u30b3\u30e9\u30dc/.test(source);
  const campaignType = isSale
    ? "Promotion / sale event"
    : isCollab
      ? "Collaboration or collection launch"
      : isNew
        ? "New product launch"
        : "Brand or seasonal campaign";

  const watchPoints = [];
  if (isSale) watchPoints.push("Watch the depth of the offer, deadline language, and whether discounted items move into the primary CTA.");
  if (isNew) watchPoints.push("Watch whether the launch expands from the hero into the new-arrivals PLP and whether additional product types appear.");
  if (isCollab) watchPoints.push("Watch for partner naming, limited-edition language, and dedicated collection landing pages.");
  if (ctas.length) watchPoints.push(`Primary conversion path: ${ctas.slice(0, 2).join(" / ")}.`);
  if (heroMessage) watchPoints.push(`Current hero message: "${heroMessage}".`);

  return {
    title: "Campaign signal",
    primary: campaignType,
    secondary: heroMessage ? `Hero message: "${heroMessage}".${supportingMessage ? ` Supporting copy: ${supportingMessage}.` : ""}` : "",
    points: watchPoints.slice(0, 3)
  };
}

function createPlpAnalysis(target, signals) {
  const uxPoints = [];
  if (signals.hasFilter) uxPoints.push("Filtering controls help shoppers narrow the assortment by relevant attributes.");
  if (signals.hasSort) uxPoints.push("Sorting options support quick comparison by priority such as newness or price.");
  if (signals.visibleImageCount > 0) uxPoints.push("Product imagery in the grid supports fast visual scanning before a product-detail visit.");
  if (signals.hasPromo) uxPoints.push("Newness or promotional labels make commercial highlights easier to identify.");
  if (signals.hasSearch) uxPoints.push("Search access gives shoppers a direct route when browsing alone is not efficient.");
  if (uxPoints.length === 0) uxPoints.push("The page uses a structured assortment layout to help shoppers browse and compare products.");

  return {
    title: "PLP analysis",
    primary: productTypeSummary(signals, target.type),
    secondary: signals.headings?.slice(0, 2).join(" | ") || "Product listing page",
    points: uxPoints.slice(0, 4)
  };
}

function fallbackAnalysis(target) {
  return null;
}

function isPlaceholderAnalysis(analysis) {
  const text = `${analysis?.primary || ""} ${analysis?.secondary || ""} ${(analysis?.points || []).join(" ")}`;
  return /existing homepage screenshot|existing product listing screenshot|run a new capture|next capture will inspect/i.test(text);
}

function createChangeSummary(target, previous, visibleLines) {
  if (!previous?.valid) return { priority: "Low", headline: "Baseline created", changes: [] };
  const { added, removed } = getChanges(previous.visibleLines || [], visibleLines);
  if (added.length === 0 && removed.length === 0) return { priority: "Low", headline: "No visible text changes detected", changes: [] };

  const changes = [...added.map((line) => `Added: ${line}`), ...removed.map((line) => `Removed: ${line}`)];
  const highPriorityPattern = /(new arrival|new|sale|discount|off|collab|collaboration|limited|campaign|free shipping)/i;
  return {
    priority: changes.some((line) => highPriorityPattern.test(line)) ? "High" : "Medium",
    headline: "Page content update detected",
    changes
  };
}

function createHeroUpdate(target, previous, analysis, changeSummary) {
  if (target.kind !== "hero" || !previous?.valid) return null;

  const previousMessage = previous.analysis?.primary || "";
  const currentMessage = analysis?.primary || "";
  const messageChanged = previousMessage && currentMessage && previousMessage !== currentMessage;
  const addedCopy = (changeSummary.changes || [])
    .filter((change) => change.startsWith("Added: "))
    .map((change) => change.replace("Added: ", ""))
    .filter((copy) => copy !== currentMessage)
    .slice(0, 2);

  if (!messageChanged && addedCopy.length === 0) return null;

  return {
    brand: target.brand,
    previousMessage,
    currentMessage,
    addedCopy
  };
}

function heroOverview(items) {
  const updates = items.map((item) => item.heroUpdate).filter(Boolean);
  if (updates.length === 0) {
    return {
      headline: "No homepage hero changes detected today.",
      updates: []
    };
  }

  return {
    headline: `${updates.length} homepage hero change(s) detected today.`,
    updates
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

async function waitForHeroMedia(page, target) {
  if (target.id !== "nike-hero") return;

  await page.waitForFunction(() => {
    return [...document.images].some((image) => {
      const rect = image.getBoundingClientRect();
      return (
        image.complete &&
        image.naturalWidth > 800 &&
        rect.top >= 0 &&
        rect.top < window.innerHeight &&
        rect.width > 1000 &&
        rect.height > 400
      );
    });
  }, { timeout: 15000 });

  await page.locator("img").evaluateAll(async (images) => {
    const hero = images.find((image) => {
      const rect = image.getBoundingClientRect();
      return image.complete && image.naturalWidth > 800 && rect.top >= 0 && rect.top < window.innerHeight && rect.height > 400;
    });
    await hero?.decode?.().catch(() => undefined);
  });
}

async function captureTarget(browser, target, date) {
  const snapshotPath = path.join(SNAPSHOTS_DIR, `${target.id}.json`);
  const previous = await readJson(snapshotPath);
  const screenshotMode = getScreenshotMode(target);
  const screenshotName = `${target.id}.png`;
  let page;

  try {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(15000);
    const navigation = await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      document.querySelectorAll('[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i]').forEach((element) => {
        element.style.setProperty("display", "none", "important");
      });
    });
    await waitForHeroMedia(page, target);

    const visibleText = await page.locator("body").innerText();
    const title = await page.title();
    const status = navigation?.status() || 200;
    if (status >= 400 || /\b(403|404|access denied|request blocked|request could not be satisfied)\b/i.test(`${title}\n${visibleText}`)) {
      throw new Error(`The site returned an error or blocked the browser request (HTTP ${status}).`);
    }

    const visibleLines = cleanLines(visibleText);
    const signals = await extractPageSignals(page, target.kind);
    const analysis = target.kind === "hero" ? createHeroAnalysis(target, signals) : createPlpAnalysis(target, signals);
    const screenshotFile = path.join(SCREENSHOTS_DIR, date, screenshotName);
    await page.screenshot({ path: screenshotFile, fullPage: screenshotMode === "full-page" });

    const snapshot = {
      capturedAt: new Date().toISOString(),
      visibleLines,
      screenshot: `/screenshots/${date}/${screenshotName}`,
      screenshotMode,
      analysis,
      valid: true
    };
    await fsp.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");

    const changeSummary = createChangeSummary(target, previous, visibleLines);
    const heroUpdate = createHeroUpdate(target, previous, analysis, changeSummary);
    return {
      ...target,
      status: "success",
      capturedAt: snapshot.capturedAt,
      screenshot: snapshot.screenshot,
      previousScreenshot: previous?.valid ? previous.screenshot : null,
      screenshotMode,
      analysis,
      heroUpdate,
      ...changeSummary
    };
  } catch (error) {
    return {
      ...target,
      status: "error",
      capturedAt: new Date().toISOString(),
      screenshot: previous?.valid ? previous.screenshot : null,
      screenshotMode: previous?.screenshotMode || screenshotMode,
      analysis: previous?.analysis || fallbackAnalysis(target),
      heroUpdate: null,
      priority: "Low",
      headline: "Capture failed",
      changes: []
    };
  } finally {
    await page?.close().catch(() => undefined);
  }
}

function reportInsight(items) {
  const changed = items.filter((item) => item.status === "success" && item.changes.length > 0);
  const highPriority = changed.filter((item) => item.priority === "High");
  if (changed.length === 0) return "No visible text changes were detected today. Review the hero and PLP analyses for the current merchandising approach.";
  if (highPriority.length > 0) return `${highPriority.length} high-priority update(s) detected. Review new products, promotional language, and hero-message changes first.`;
  return `${changed.length} page(s) showed visible content updates. Check the relevant hero or PLP analysis for current context.`;
}

async function connectBrowser() {
  try {
    const browser = await chromium.connectOverCDP(CHROME_DEBUG_URL, { timeout: 8000 });
    console.log(`Connected to monitoring Chrome: ${CHROME_DEBUG_URL}`);
    return { browser, browserMode: "Google Chrome (dedicated monitoring profile)", closeWhenDone: false };
  } catch {
    try {
      spawn(CHROME_EXECUTABLE, [
        "--remote-debugging-port=9222",
        `--user-data-dir=${CHROME_PROFILE_DIR}`,
        "--no-first-run",
        "--no-default-browser-check"
      ], { detached: true, stdio: "ignore", windowsHide: true }).unref();

      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        try {
          const browser = await chromium.connectOverCDP(CHROME_DEBUG_URL, { timeout: 2000 });
          console.log("Started and connected to the dedicated Chrome profile.");
          return { browser, browserMode: "Google Chrome (dedicated monitoring profile)", closeWhenDone: false };
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      throw new Error("Dedicated Chrome did not expose its debugging port in time.");
    } catch {
      const browser = await chromium.launch({ headless: true });
      return { browser, browserMode: "Isolated Chromium (last-resort fallback)", closeWhenDone: true };
    }
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
      heroOverview: heroOverview(items),
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
    scheduledTime: "11:00 JST",
    capturePlan: isMondayTokyo() ? "Monday full-page homepage archive" : "Daily viewport capture",
    insight: "Waiting for the first capture at 11:00 JST.",
    heroOverview: {
      headline: "Waiting for the first capture.",
      updates: []
    },
    items: targets.map((target) => ({
      ...target,
      status: "waiting",
      priority: "Low",
      headline: "Waiting for first capture",
      changes: [],
      screenshot: null,
      screenshotMode: getScreenshotMode(target),
      analysis: fallbackAnalysis(target)
    }))
  };
}

function normalizeReport(report) {
  const targetById = new Map(targets.map((target) => [target.id, target]));
  const items = (report.items || []).map((item) => {
    const target = targetById.get(item.id) || item;
    return {
      ...item,
      ...target,
      priority: ["High", "Medium", "Low"].includes(item.priority) ? item.priority : "Low",
      analysis: isPlaceholderAnalysis(item.analysis) ? null : (item.analysis || fallbackAnalysis(target)),
      screenshotMode: item.screenshotMode || getScreenshotMode(target),
      changes: item.changes || []
    };
  });
  return {
    ...report,
    capturePlan: report.capturePlan || (isMondayTokyo() ? "Monday full-page homepage archive" : "Daily viewport capture"),
    insight: report.insight || reportInsight(items),
    heroOverview: report.heroOverview || heroOverview(items),
    items
  };
}

async function latestReport() {
  const today = await readJson(path.join(REPORTS_DIR, `${tokyoDate()}.json`));
  if (today) return normalizeReport(today);
  const files = (await fsp.readdir(REPORTS_DIR)).filter((file) => file.endsWith(".json")).sort().reverse();
  return files.length ? normalizeReport(await readJson(path.join(REPORTS_DIR, files[0]))) : waitingReport();
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
