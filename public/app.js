const cards = document.querySelector("#cards");
const template = document.querySelector("#card-template");
const runButton = document.querySelector("#run-now");
const reloadButton = document.querySelector("#reload");

function displayDate(date) {
  if (!date) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short"
  }).format(new Date(`${date}T00:00:00+09:00`));
}

function displayTimestamp(timestamp) {
  if (!timestamp) return "尚未采集";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(new Date(timestamp)) + " JST";
}

function priorityClass(priority) {
  return priority === "高" ? "high" : priority === "中" ? "medium" : "low";
}

function render(report) {
  document.querySelector("#report-date").textContent = displayDate(report.date);
  document.querySelector("#insight").textContent = report.insight;
  const changed = report.items.filter((item) => item.changes?.length > 0).length;
  const errors = report.items.filter((item) => item.status === "error").length;
  document.querySelector("#counts").textContent = `共 ${report.items.length} 个页面 · ${changed} 个检测到内容变化${errors ? ` · ${errors} 个采集失败` : ""}`;

  cards.replaceChildren();
  for (const item of report.items) {
    const node = template.content.cloneNode(true);
    node.querySelector(".brand").textContent = item.brand;
    node.querySelector(".type").textContent = item.type;
    const priority = node.querySelector(".priority");
    priority.textContent = `${item.priority}优先级`;
    priority.classList.add(priorityClass(item.priority));
    const link = node.querySelector(".source-link");
    link.href = item.url;
    node.querySelector(".headline").textContent = item.headline;
    node.querySelector(".business-summary").textContent = item.businessSummary;
    node.querySelector(".captured-at").textContent = `采集时间：${displayTimestamp(item.capturedAt)}`;

    const screenshot = node.querySelector(".screenshot");
    const empty = node.querySelector(".empty-shot");
    if (item.screenshot) {
      if (item.screenshotMode === "full-page") {
        node.querySelector(".image-wrap").classList.add("full-page");
      }
      screenshot.src = item.screenshot;
      screenshot.alt = `${item.brand} ${item.type} 截图`;
      empty.remove();
    } else {
      screenshot.remove();
    }

    const changes = node.querySelector(".changes");
    if (item.changes?.length) {
      for (const change of item.changes) {
        const li = document.createElement("li");
        li.textContent = change;
        changes.append(li);
      }
    } else {
      changes.remove();
    }
    cards.append(node);
  }
}

async function load() {
  const response = await fetch("/api/report", { cache: "no-store" });
  if (!response.ok) throw new Error("无法读取日报数据");
  render(await response.json());
}

async function refreshStatus() {
  const response = await fetch("/api/status", { cache: "no-store" });
  const status = await response.json();
  const dot = document.querySelector("#status-dot");
  const label = document.querySelector("#status");
  dot.className = `status-dot ${status.isRunning ? "running" : "ready"}`;
  label.textContent = status.isRunning ? "正在采集页面…" : "系统待命";
  runButton.disabled = status.isRunning;
  runButton.textContent = status.isRunning ? "正在刷新…" : "立即刷新";
}

runButton.addEventListener("click", async () => {
  runButton.disabled = true;
  runButton.textContent = "正在启动…";
  const response = await fetch("/api/run", { method: "POST" });
  if (!response.ok) alert("启动失败，请查看服务终端日志。");
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
