# Competitor Monitoring Dashboard

Local dashboard for daily Japanese competitor website monitoring.

It captures screenshots and visible text from 10 pages at **11:00 JST**, compares them with the previous run, and produces an English summary.

## Capture plan

- Every day: viewport screenshots for all 10 pages.
- Every Monday: full-page screenshots for the five homepages.
- Category pages always use viewport screenshots to keep the daily report quick and readable.

## Run

```powershell
cd "C:\Users\rziyi\competitor monitor"
npm start
```

Open `http://localhost:3000`.

To run a capture immediately:

```powershell
npm run run-now
```

## Dedicated monitoring Chrome

The capture service first tries to connect to a dedicated Google Chrome monitoring window on port 9222. This lets it reuse cookie consent, locale settings, and manual sign-in state.

```powershell
cd "C:\Users\rziyi\competitor monitor"
.\start-monitoring-chrome.ps1
```

This Chrome window uses the project-local `chrome-profile` folder and does not affect your everyday Chrome profile. Keep it open for the best results, particularly for Red Wing and UGG.

If it is unavailable, the service falls back to isolated Chromium.

## Keep the schedule running

The Node process runs the schedule. Keep the computer on and leave `npm start` running. Keep the dedicated monitoring Chrome window open as well.

To start the dashboard after Windows sign-in, create a Task Scheduler task:

- Trigger: At log on
- Program: `C:\Program Files\nodejs\node.exe`
- Arguments: `server.js`
- Start in: `C:\Users\rziyi\competitor monitor`

## Data locations

- Screenshots: `data/screenshots/YYYY-MM-DD/`
- Daily reports: `data/reports/YYYY-MM-DD.json`
- Comparison baselines: `data/snapshots/`

## Future Visualping integration

The dashboard is ready to receive Visualping data, but a webhook URL or API export format has not been configured. Once available, Visualping change screenshots and AI summaries can replace or supplement the local capture results.
