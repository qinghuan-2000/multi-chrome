# LCP Auto Test (Multi Browser Kernel)

This project measures page `LCP` for a list of URLs across multiple local browser kernels (`chrome.exe`) and exports results to Excel.

## Input Parameters

Use a config JSON file with these fields:

- `WebUrl`: array of target page URLs
- `BrowserKernelRootPath`: local root path that contains multiple kernel folders; script will recursively find every `chrome.exe`
- `OutputExcelPath`: output xlsx path
- `UseTimestampFileName`: (optional, default `true`) append timestamp to output file name to avoid overwrite/lock conflict
- `Headless`: (optional, default `true`) use headless browser (recommended for automation)
- `WaitUntil`: (optional, default `load`) page readiness point: `domcontentloaded` / `load` / `networkidle0` / `networkidle2`
- `WarmupCount`: (optional, default `0`) warmup visits per URL+browser, not included in final stats
- `RepeatCount`: (optional, default `5`) how many times each URL is tested in each browser kernel
- `WaitAfterLoadMs`: (optional, default `1000`) extra wait after `WaitUntil` point for better real-user-like LCP capture
- `DisableCache`: (optional, default `true`) disable HTTP cache (best-effort) to capture *first-load* LCP
- `NavigationTimeoutMs`: (optional) timeout for page navigation

Example config: `config.example.json`

## Install

```bash
npm install
```

## Run

```bash
node src/index.js --config ./config.example.json
```

or:

```bash
npm run run -- --config ./config.example.json
```

## Output

The Excel file contains 3 sheets:

- `lcp_details`: each URL x browser kernel x round test record
- `lcp_summary`: per browser + URL summary (`avg/min/max/median/p90`)
- `test_meta`: test method and runtime parameters used for this report

## Notes

- Script uses `puppeteer-core` with local `chrome.exe` (no bundled browser download).
- Some pages may block automation/headless traffic, which can affect metrics.
- Browser process is reused per kernel; each round disables and clears browser cache/cookies via CDP to better approximate first-load.
