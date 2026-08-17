const cards = document.querySelector("#cards");
const template = document.querySelector("#card-template");
const runButton = document.querySelector("#run-now");
const reloadButton = document.querySelector("#reload");

function displayDate(date) {
  if (!date) return "—";
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

function priorityClass(priority) {
  return priority === "High" ? "high" : priority === "Medium" ? "medium" : "low";
}

function legacyPriority(priority) {
  if (priority === "High" || priority === "Medium" || priority === "Low") return priority;
  return "Low";
}

function render(report) {
  document.querySelector("#report-date").textContent = displayDate(report.date);
  document.querySelector("#insight").textContent = report.insight || "No daily overview is available yet.";

  const changed = report.items.filter((item) => item.changes?.length > 0).length;
  const errors = report.items.filter((item) => item.status === "error").length;
  document.querySelector("#counts").textContent = `${report.items.length} pages · ${changed} with content changes${errors ? ` · ${errors} capture failures` : ""}`;

  cards.replaceChildren();
  for (const item of report.items) {
    const node = template.content.cloneNode(true);
    node.querySelector(".brand").textContent = item.brand;
    node.querySelector(".type").textContent = item.type;

    const priorityValue = legacyPriority(item.priority);
    const priority = node.querySelector(".priority");
    priority.textContent = `${priorityValue} priority`;
    priority.classList.add(priorityClass(priorityValue));

    const sourceLink = node.querySelector(".source-link");
    sourceLink.href = item.url;

    const fullImageLink = node.querySelector(".full-image-link");
    if (item.screenshot) {
      fullImageLink.href = item.screenshot;
    } else {
      fullImageLink.remove();
    }

    node.querySelector(".headline").textContent = item.headline || "No summary available";
    node.querySelector(".business-summary").textContent = item.businessSummary || "No business summary available.";
    node.querySelector(".captured-at").textContent = `Captured: ${displayTimestamp(item.capturedAt)}`;

    const screenshot = node.querySelector(".screenshot");
    const empty = node.querySelector(".empty-shot");
    if (item.screenshot) {
      if (item.screenshotMode === "full-page") node.querySelector(".image-wrap").classList.add("full-page");
      screenshot.src = item.screenshot;
      screenshot.alt = `${item.brand} ${item.type} screenshot`;
      empty.remove();
    } else {
      screenshot.remove();
    }

    const changes = node.querySelector(".changes");
    if (item.changes?.length) {
      for (const change of item.changes) {
        const listItem = document.createElement("li");
        listItem.textContent = change;
        changes.append(listItem);
      }
    } else {
      changes.remove();
    }
    cards.append(node);
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
  const label = document.querySelector("#status");
  dot.className = `status-dot ${status.isRunning ? "running" : "ready"}`;
  label.textContent = status.isRunning ? "Capturing pages…" : "System ready";
  runButton.disabled = status.isRunning;
  runButton.textContent = status.isRunning ? "Running…" : "Run now";
}

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  runButton.textContent = "Starting…";
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
