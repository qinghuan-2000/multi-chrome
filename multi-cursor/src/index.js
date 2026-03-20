const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");
const ExcelJS = require("exceljs");

const DEFAULT_NAVIGATION_TIMEOUT_MS = 45000;
const DEFAULT_WAIT_AFTER_LOAD_MS = 1000;
const DEFAULT_REPEAT_COUNT = 5;
const DEFAULT_WARMUP_COUNT = 0;
const DEFAULT_WAIT_UNTIL = "load";
const DEFAULT_HEADLESS = true;

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    }
  }
  return args;
}

function ensureAbsolute(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function readJsonConfig(configPath) {
  const absPath = ensureAbsolute(configPath);
  const content = fs.readFileSync(absPath, "utf-8");
  return JSON.parse(content);
}

function findChromeExecutables(rootDir) {
  const result = [];
  const absRoot = ensureAbsolute(rootDir);

  if (!fs.existsSync(absRoot)) {
    throw new Error(`Browser kernel root path not found: ${absRoot}`);
  }

  const stack = [absRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase() === "chrome.exe") {
        result.push(fullPath);
      }
    }
  }

  return result.sort((a, b) => a.localeCompare(b));
}

function createLcpCollectorScript() {
  return `
    (() => {
      window.__lcpValue = null;
      window.__lcpEntries = [];
      try {
        const observer = new PerformanceObserver((list) => {
          const entries = list.getEntries();
          for (const entry of entries) {
            const value = entry.renderTime || entry.loadTime || entry.startTime || null;
            window.__lcpEntries.push({
              name: entry.name,
              startTime: entry.startTime,
              renderTime: entry.renderTime,
              loadTime: entry.loadTime,
              size: entry.size,
              value
            });
            if (value !== null) {
              window.__lcpValue = value;
            }
          }
        });
        observer.observe({ type: "largest-contentful-paint", buffered: true });
        window.__lcpStop = () => observer.disconnect();
      } catch (e) {
        window.__lcpError = e.message || String(e);
      }
    })();
  `;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTimestampForFile(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function resolveOutputPath(outputExcel, useTimestampFileName) {
  if (!useTimestampFileName) {
    return outputExcel;
  }
  const parsed = path.parse(outputExcel);
  const ext = parsed.ext || ".xlsx";
  const stampedName = `${parsed.name}_${formatTimestampForFile()}${ext}`;
  return path.join(parsed.dir, stampedName);
}

function calcPercentile(sortedArr, p) {
  if (!sortedArr.length) return null;
  if (sortedArr.length === 1) return sortedArr[0];
  const idx = (sortedArr.length - 1) * p;
  const low = Math.floor(idx);
  const high = Math.ceil(idx);
  if (low === high) return sortedArr[low];
  const weight = idx - low;
  return sortedArr[low] * (1 - weight) + sortedArr[high] * weight;
}

function normalizeWaitUntil(value) {
  const allowed = new Set(["domcontentloaded", "load", "networkidle0", "networkidle2"]);
  if (!value) return DEFAULT_WAIT_UNTIL;
  const normalized = String(value).toLowerCase();
  if (!allowed.has(normalized)) {
    throw new Error(`WaitUntil must be one of: ${Array.from(allowed).join(", ")}`);
  }
  return normalized;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "boolean") return value;
  const str = String(value).toLowerCase();
  if (str === "true") return true;
  if (str === "false") return false;
  return fallback;
}

async function measureLcpWithPage(page, url, options = {}) {
  const navigationTimeoutMs = options.navigationTimeoutMs || DEFAULT_NAVIGATION_TIMEOUT_MS;
  const waitAfterLoadMs = options.waitAfterLoadMs || DEFAULT_WAIT_AFTER_LOAD_MS;
  const waitUntil = options.waitUntil || DEFAULT_WAIT_UNTIL;
  const disableCache = options.disableCache !== false;
  const startedAt = Date.now();

  try {
    const cdp = await page.target().createCDPSession();
    await cdp.send("Network.enable");
    // Ensure cold-load characteristics: disable HTTP cache.
    if (disableCache) {
      try {
        await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      } catch (e) {
        // Some Chromium builds may not support this; cache disabling will be best-effort.
      }
      // Clear stored cache/cookies to better approximate a "first visit".
      try {
        await cdp.send("Network.clearBrowserCache");
      } catch (e) {
        // Best-effort
      }
      try {
        await cdp.send("Network.clearBrowserCookies");
      } catch (e) {
        // Best-effort
      }
      // Also clear origin-scoped storage (e.g. service worker + cache storage)
      // to reduce influence on LCP from SW/CacheStorage.
      try {
        const origin = new URL(url).origin;
        await cdp.send("Storage.enable");
        await cdp.send("Storage.clearDataForOrigin", {
          origin,
          storageTypes: [
            "cacheStorage",
            "serviceWorkers",
            "cookies",
            "localStorage",
            "indexedDB",
            "websqlDatabases",
          ],
        });
      } catch (e) {
        // Best-effort; if not supported, HTTP cache will still be disabled/cleared.
      }
    }
    await cdp.send("Performance.enable");
    page.setDefaultNavigationTimeout(navigationTimeoutMs);
    await page.evaluateOnNewDocument(createLcpCollectorScript());
    await page.goto(url, { waitUntil, timeout: navigationTimeoutMs });
    await sleep(waitAfterLoadMs);

    const data = await page.evaluate(() => {
      const directEntries = performance.getEntriesByType("largest-contentful-paint") || [];
      const lastEntry =
        directEntries.length > 0 ? directEntries[directEntries.length - 1] : null;
      const directLcp = lastEntry
        ? lastEntry.renderTime || lastEntry.loadTime || lastEntry.startTime || null
        : null;

      if (window.__lcpStop) {
        window.__lcpStop();
      }

      return {
        lcp:
          directLcp !== null && directLcp !== undefined ? directLcp : window.__lcpValue || null,
        entries:
          directEntries.length > 0
            ? directEntries.map((entry) => ({
                name: entry.name,
                startTime: entry.startTime,
                renderTime: entry.renderTime,
                loadTime: entry.loadTime,
                size: entry.size,
                value: entry.renderTime || entry.loadTime || entry.startTime || null,
              }))
            : window.__lcpEntries || [],
        injectError: window.__lcpError || null,
      };
    });
    const metricResult = await cdp.send("Performance.getMetrics");
    const metricMap = new Map(
      (metricResult.metrics || []).map((item) => [item.name, item.value])
    );
    const cdpLcp =
      metricMap.get("LargestContentfulPaint") ??
      metricMap.get("LargestContentfulPaint::Candidate") ??
      null;
    const cdpLcpMs = typeof cdpLcp === "number" ? cdpLcp * 1000 : null;
    const finalLcp = data.lcp == null ? cdpLcpMs : data.lcp;

    const elapsedMs = Date.now() - startedAt;
    return {
      success: true,
      lcpMs: finalLcp,
      elapsedMs,
      entryCount: Array.isArray(data.entries) ? data.entries.length : 0,
      injectError: data.injectError,
      errorMessage: finalLcp == null ? "LCP not available for this page/load." : null,
    };
  } catch (error) {
    return {
      success: false,
      lcpMs: null,
      elapsedMs: Date.now() - startedAt,
      entryCount: 0,
      injectError: null,
      errorMessage: error.message || String(error),
    };
  }
}

function buildRows(results) {
  return results.map((item) => ({
    url: item.url,
    round: item.round || 1,
    browserKernelPath: item.browserKernelPath,
    browserName: path.basename(path.dirname(item.browserKernelPath)),
    success: item.success ? "yes" : "no",
    lcpMs: item.lcpMs == null ? "" : Number(item.lcpMs.toFixed(2)),
    elapsedMs: item.elapsedMs,
    lcpEntryCount: item.entryCount,
    injectError: item.injectError || "",
    errorMessage: item.errorMessage || "",
    testedAt: item.testedAt,
  }));
}

function createSummaryRows(results) {
  const map = new Map();
  for (const row of results) {
    if (!row.success || row.lcpMs == null) continue;
    const key = `${row.browserKernelPath}__${row.url}`;
    if (!map.has(key)) {
      map.set(key, {
        values: [],
        browserKernelPath: row.browserKernelPath,
        url: row.url,
      });
    }
    map.get(key).values.push(row.lcpMs);
  }

  const rows = [];
  for (const value of map.values()) {
    const arr = [...value.values].sort((a, b) => a - b);
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    const median = calcPercentile(arr, 0.5);
    const p90 = calcPercentile(arr, 0.9);
    rows.push({
      url: value.url,
      browserKernelPath: value.browserKernelPath,
      browserName: path.basename(path.dirname(value.browserKernelPath)),
      sampleCount: arr.length,
      avgLcpMs: Number(avg.toFixed(2)),
      minLcpMs: Number(min.toFixed(2)),
      maxLcpMs: Number(max.toFixed(2)),
      medianLcpMs: median == null ? "" : Number(median.toFixed(2)),
      p90LcpMs: p90 == null ? "" : Number(p90.toFixed(2)),
    });
  }

  return rows.sort((a, b) => {
    const browserCmp = a.browserKernelPath.localeCompare(b.browserKernelPath);
    if (browserCmp !== 0) return browserCmp;
    return a.url.localeCompare(b.url);
  });
}

async function writeExcel(outputPath, detailRows, summaryRows, metaRows = []) {
  const workbook = new ExcelJS.Workbook();
  const detailSheet = workbook.addWorksheet("lcp_details");
  const summarySheet = workbook.addWorksheet("lcp_summary");
  const metaSheet = workbook.addWorksheet("test_meta");

  if (detailRows.length > 0) {
    const detailColumns = Object.keys(detailRows[0]).map((key) => ({
      header: key,
      key,
      width: 22,
    }));
    detailSheet.columns = detailColumns;
    detailRows.forEach((row) => detailSheet.addRow(row));
  }

  if (summaryRows.length > 0) {
    const summaryColumns = Object.keys(summaryRows[0]).map((key) => ({
      header: key,
      key,
      width: 22,
    }));
    summarySheet.columns = summaryColumns;
    summaryRows.forEach((row) => summarySheet.addRow(row));
  }

  if (metaRows.length > 0) {
    metaSheet.columns = [
      { header: "key", key: "key", width: 28 },
      { header: "value", key: "value", width: 80 },
    ];
    metaRows.forEach((row) => metaSheet.addRow(row));
  }

  // Write to a temp file first to avoid generating a broken xlsx on interruption.
  const tempOutputPath = `${outputPath}.tmp.xlsx`;
  await workbook.xlsx.writeFile(tempOutputPath);

  const maxRetries = 6;
  for (let i = 0; i < maxRetries; i += 1) {
    try {
      if (fs.existsSync(outputPath)) {
        fs.rmSync(outputPath, { force: true });
      }
      fs.renameSync(tempOutputPath, outputPath);
      return;
    } catch (error) {
      const code = error && error.code;
      if ((code === "EBUSY" || code === "EPERM") && i < maxRetries - 1) {
        await sleep(1000 * (i + 1));
        continue;
      }
      throw error;
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const configPath = args.config || "./config.json";
  const config = readJsonConfig(configPath);

  const urls = Array.isArray(config.WebUrl) ? config.WebUrl : [];
  const browserRoot = config.BrowserKernelRootPath;
  const outputExcel = ensureAbsolute(config.OutputExcelPath || "./lcp-report.xlsx");
  const finalOutputExcel = resolveOutputPath(
    outputExcel,
    config.UseTimestampFileName !== false
  );
  const waitAfterLoadMs = Number(config.WaitAfterLoadMs || DEFAULT_WAIT_AFTER_LOAD_MS);
  const navigationTimeoutMs = Number(
    config.NavigationTimeoutMs || DEFAULT_NAVIGATION_TIMEOUT_MS
  );
  const repeatCount = Number(config.RepeatCount || DEFAULT_REPEAT_COUNT);
  const warmupCount = Number(config.WarmupCount ?? DEFAULT_WARMUP_COUNT);
  const waitUntil = normalizeWaitUntil(config.WaitUntil || DEFAULT_WAIT_UNTIL);
  const headless = parseBoolean(config.Headless, DEFAULT_HEADLESS);
  const disableCache = parseBoolean(config.DisableCache, true);

  if (!urls.length) {
    throw new Error("WebUrl must be a non-empty array in config");
  }
  if (!browserRoot) {
    throw new Error("BrowserKernelRootPath is required in config");
  }

  if (!Number.isFinite(repeatCount) || repeatCount < 1) {
    throw new Error("RepeatCount must be a number >= 1");
  }
  if (!Number.isFinite(warmupCount) || warmupCount < 0) {
    throw new Error("WarmupCount must be a number >= 0");
  }
  if (disableCache !== true) {
    // Keep behavior explicit: user can opt out if needed.
    console.log("Warning: DisableCache=false; results may include cached loads.");
  }

  const browserExecutables = findChromeExecutables(browserRoot);
  if (!browserExecutables.length) {
    throw new Error(`No chrome.exe found under: ${browserRoot}`);
  }

  console.log(`Found ${browserExecutables.length} browser kernels.`);
  console.log(
    `Testing ${urls.length} URLs with repeatCount=${repeatCount}, warmupCount=${warmupCount}, waitUntil=${waitUntil}, headless=${headless}...`
  );

  const results = [];
  for (const browserPath of browserExecutables) {
    const browser = await puppeteer.launch({
      executablePath: browserPath,
      headless,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: { width: 1366, height: 768 },
    });
    try {
      for (const url of urls) {
        for (let i = 1; i <= warmupCount; i += 1) {
          console.log(
            `Warmup => browser: ${browserPath} | url: ${url} | round: ${i}/${warmupCount}`
          );
          const page = await browser.newPage();
          try {
            await measureLcpWithPage(page, url, {
              waitAfterLoadMs,
              navigationTimeoutMs,
              waitUntil,
              disableCache,
            });
          } finally {
            await page.close().catch(() => {});
          }
        }

        for (let i = 1; i <= repeatCount; i += 1) {
          console.log(
            `Running => browser: ${browserPath} | url: ${url} | round: ${i}/${repeatCount}`
          );
          const page = await browser.newPage();
          let ret;
          try {
            ret = await measureLcpWithPage(page, url, {
              waitAfterLoadMs,
              navigationTimeoutMs,
              waitUntil,
              disableCache,
            });
          } finally {
            await page.close().catch(() => {});
          }

          results.push({
            url,
            browserKernelPath: browserPath,
            round: i,
            ...ret,
            testedAt: new Date().toISOString(),
          });
        }
      }
    } finally {
      await browser.close().catch(() => {});
    }
  }

  const detailRows = buildRows(results);
  const summaryRows = createSummaryRows(results);
  const metaRows = [
    { key: "generatedAt", value: new Date().toISOString() },
    { key: "measurementGoal", value: "Real-user-like LCP sampling baseline" },
    { key: "urlCount", value: String(urls.length) },
    { key: "browserKernelCount", value: String(browserExecutables.length) },
    { key: "repeatCount", value: String(repeatCount) },
    { key: "warmupCount", value: String(warmupCount) },
    { key: "waitUntil", value: waitUntil },
    { key: "waitAfterLoadMs", value: String(waitAfterLoadMs) },
    { key: "navigationTimeoutMs", value: String(navigationTimeoutMs) },
    { key: "headless", value: String(headless) },
    { key: "coldLoadStrategy", value: "CacheDisabled via CDP + clearBrowserCache/Cookies per round(best-effort)" },
    { key: "disableCache", value: String(disableCache) },
  ];
  await writeExcel(finalOutputExcel, detailRows, summaryRows, metaRows);

  console.log(`Done. Excel saved to: ${finalOutputExcel}`);
}

main().catch((err) => {
  console.error("Run failed:", err);
  process.exit(1);
});
