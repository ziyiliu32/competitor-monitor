const brandPairs = document.querySelector("#brand-pairs");
const template = document.querySelector("#card-template");
const runButton = document.querySelector("#run-now");
const reloadButton = document.querySelector("#reload");

function displayDate(date) {
  if (!date) return "-";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short"
  }).format(new Date(`${date}T00:00:00+09:00`));
}

function displayTimestamp(timestamp) {
  if (!timestamp) return "Not captured yet";
  return `${new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(timestamp))} JST`;
}

function badgeClass(label) {
  if (/promotion|sale/i.test(label)) return "promotion";
  if (/new product|launch/i.test(label)) return "launch";
  if (/collaboration|collection/i.test(label)) return "collaboration";
  return "campaign";
}

function createCard(item) {
  const node = template.content.cloneNode(true);
  node.querySelector(".brand").textContent = item.brand;
  node.querySelector(".type").textContent = item.type;

  const badge = node.querySelector(".priority");
  const badgeLabel = item.kind === "hero"
    ? (item.analysis?.primary || "Homepage campaign")
    : "Product listing page";
  badge.textContent = badgeLabel;
  badge.classList.add(badgeClass(badgeLabel));

  const sourceLink = node.querySelector(".source-link");
  sourceLink.href = item.url;

  const screenshot = node.querySelector(".screenshot");
  const emptyShot = node.querySelector(".empty-shot");
  if (item.screenshot) {
    if (item.screenshotMode === "full-page") node.querySelector(".image-wrap").classList.add("full-page");
    screenshot.src = item.screenshot;
    screenshot.alt = `${item.brand} ${item.type} screenshot`;
    emptyShot.remove();
  } else {
    screenshot.remove();
  }

  const analysis = item.analysis;
  const analysisDetail = node.querySelector(".analysis-detail");
  if (analysis?.primary) {
    node.querySelector(".analysis-title").textContent = analysis.title || "Page analysis";
    node.querySelector(".analysis-primary").textContent = analysis.primary;
    node.querySelector(".analysis-secondary").textContent = analysis.secondary || "";

    const analysisPoints = node.querySelector(".analysis-points");
    for (const point of analysis.points || []) {
      const listItem = document.createElement("li");
      listItem.textContent = point;
      analysisPoints.append(listItem);
    }
    if (!analysis.points?.length) analysisPoints.remove();
  } else {
    analysisDetail.remove();
  }

  const changes = node.querySelector(".changes");
  if (item.status === "success") {
    for (const change of item.changes || []) {
      const listItem = document.createElement("li");
      listItem.textContent = change;
      changes.append(listItem);
    }
  }
  if (item.status !== "success" || !item.changes?.length) changes.remove();

  node.querySelector(".captured-at").textContent = `Captured: ${displayTimestamp(item.capturedAt)}`;
  return node;
}

function render(report) {
  document.querySelector("#report-date").textContent = displayDate(report.date);
  const overview = report.heroOverview || { headline: report.insight, updates: [] };
  document.querySelector("#insight").textContent = overview.headline || report.insight || "No daily overview is available yet.";
  const heroOverview = document.querySelector("#hero-overview");
  heroOverview.replaceChildren();
  for (const update of overview.updates || []) {
    const item = document.createElement("li");
    const messageChange = update.previousMessage && update.currentMessage
      ? `${update.brand}: "${update.previousMessage}" -> "${update.currentMessage}".`
      : `${update.brand}: homepage hero content updated.`;
    const addedCopy = update.addedCopy?.length
      ? ` New visible content: ${update.addedCopy.map((copy) => `"${copy}"`).join(", ")}.`
      : "";
    item.textContent = `${messageChange}${addedCopy}`;
    heroOverview.append(item);
  }
  if (!(overview.updates || []).length) heroOverview.remove();

  const changed = report.items.filter((item) => item.changes?.length > 0).length;
  const errors = report.items.filter((item) => item.status === "error").length;
  document.querySelector("#counts").textContent =
    `${report.items.length} pages | ${changed} with content changes${errors ? ` | ${errors} capture failures` : ""}`;

  const brands = [...new Set(report.items.map((item) => item.brand))];
  brandPairs.replaceChildren();

  for (const brand of brands) {
    const pair = document.createElement("section");
    pair.className = "brand-pair";

    const label = document.createElement("p");
    label.className = "pair-brand";
    label.textContent = brand;
    pair.append(label);

    const hero = report.items.find((item) => item.brand === brand && item.kind === "hero");
    const plp = report.items.find((item) => item.brand === brand && item.kind === "plp");
    const heroSlot = document.createElement("div");
    const plpSlot = document.createElement("div");
    heroSlot.className = "pair-card";
    plpSlot.className = "pair-card";
    if (hero) heroSlot.append(createCard(hero));
    if (plp) plpSlot.append(createCard(plp));
    pair.append(heroSlot, plpSlot);
    brandPairs.append(pair);
  }
}

async function load() {
  const response = await fetch("/api/report", { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to load report data.");
  render(await response.json());
}

async function refreshStatus() {
  const response = await fetch("/api/status", { cache: "no-store" });
  const status = await response.json();
  const dot = document.querySelector("#status-dot");
  dot.className = `status-dot ${status.isRunning ? "running" : "ready"}`;
  document.querySelector("#status").textContent = status.isRunning ? "Capturing pages..." : "System ready";
  runButton.disabled = status.isRunning;
  runButton.textContent = status.isRunning ? "Running..." : "Run now";
}

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  runButton.textContent = "Starting...";
  const response = await fetch("/api/run", { method: "POST" });
  if (!response.ok) alert("Unable to start the capture run. Check the server logs.");

  await refreshStatus();
  const timer = setInterval(async () => {
    await refreshStatus();
    const status = await (await fetch("/api/status", { cache: "no-store" })).json();
    if (!status.isRunning) {
      clearInterval(timer);
      await load();
    }
  }, 3000);
});

reloadButton.addEventListener("click", () => load().catch((error) => alert(error.message)));
Promise.all([load(), refreshStatus()]).catch((error) => {
  document.querySelector("#insight").textContent = error.message;
});
