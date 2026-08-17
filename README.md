# 竞品官网监控日报

本地网页仪表盘。每天 **11:00 JST** 自动抓取 10 个竞品页面的截图、提取可见文字，与上一轮进行对比，再生成中文摘要。5 个首页任务保存全页截图；5 个分类页保留首屏截图，以减少商品长列表造成的日报噪音。

采集器优先连接一个独立的 Google Chrome 监控窗口（端口 9222）。这会复用该窗口中的 Cookie、地区设置和人工登录态；如果该窗口没有启动，才会回退到隔离 Chromium。

## 运行

```powershell
cd C:\Users\rziyi\competitor-monitoring
npm install
npm start
```

在浏览器中打开 `http://localhost:3000`。

## 启动专用监控 Chrome（推荐）

先运行：

```powershell
cd "C:\Users\rziyi\competitor monitor"
.\start-monitoring-chrome.ps1
```

首次打开后，在这个**独立的 Chrome 窗口**中接受 Cookie、设置地区或登录。它使用项目内的 `chrome-profile`，不影响日常 Chrome。保持它打开，仪表盘每天 11:00 会自动复用它截图。

这一步尤其建议用于 Red Wing 和 UGG：它们会拦截无登录态、自动化新开的浏览器。

首次启动会等待下一个日本时间 11:00。要立即建立首个截图基线，可点击“立即刷新”，或执行：

```powershell
npm run run-now
```

## 保持定时任务运行

定时任务由 Node 服务进程执行，电脑需保持开机且 `npm start` 进程不能退出。专用监控 Chrome 也需要保持打开。

若要在登录 Windows 后自动运行，可在“任务计划程序”新建任务：

- 触发器：登录时
- 程序：`C:\Program Files\nodejs\node.exe`
- 参数：`server.js`
- 起始于：`C:\Users\rziyi\competitor-monitoring`

## 数据位置

- 截图：`data/screenshots/YYYY-MM-DD/`
- 每日报告：`data/reports/YYYY-MM-DD.json`
- 对比基线：`data/snapshots/`

## 摘要逻辑

当前版本基于可见文本的新增/移除，输出确定性的中文摘要，不会臆测市场动作。后续可在 `makeSummary()` 中接入 Visualping webhook 或 LLM，生成更深入的业务解读。
