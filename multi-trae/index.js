const puppeteer = require('puppeteer');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

function findChromeExecutablesRecursive(dir, chromePaths = []) {
    if (!fs.existsSync(dir)) {
        return chromePaths;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
            findChromeExecutablesRecursive(fullPath, chromePaths);
        } else if (entry.name.toLowerCase() === 'chrome.exe') {
            const parentDir = path.dirname(fullPath);
            const browserName = path.basename(path.dirname(parentDir)) || path.basename(parentDir);
            chromePaths.push({
                name: browserName,
                path: fullPath
            });
        }
    }
    
    return chromePaths;
}

async function findChromeExecutables(browserDir) {
    const chromePaths = [];
    
    if (!fs.existsSync(browserDir)) {
        console.error(`浏览器目录不存在: ${browserDir}`);
        return chromePaths;
    }

    findChromeExecutablesRecursive(browserDir, chromePaths);
    
    const uniquePaths = [];
    const seenPaths = new Set();
    for (const item of chromePaths) {
        if (!seenPaths.has(item.path)) {
            seenPaths.add(item.path);
            uniquePaths.push(item);
        }
    }
    
    return uniquePaths;
}

async function getLCPTime(browser, url) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    
    try {
        await page.setCacheEnabled(false);
        
        await page._client().send('Network.clearBrowserCache');
        await page._client().send('Network.clearBrowserCookies');
        
        await page.goto(url, {
            waitUntil: 'networkidle0',
            timeout: 60000
        });

        const lcpData = await page.evaluate(() => {
            return new Promise((resolve) => {
                let lcpEntry = null;
                
                const po = new PerformanceObserver((entryList) => {
                    const entries = entryList.getEntries();
                    const lastEntry = entries[entries.length - 1];
                    lcpEntry = {
                        startTime: lastEntry.startTime,
                        size: lastEntry.size,
                        url: lastEntry.url || '',
                        element: lastEntry.element?.tagName || ''
                    };
                });
                
                po.observe({ type: 'largest-contentful-paint', buffered: true });
                
                setTimeout(() => {
                    po.disconnect();
                    if (!lcpEntry) {
                        const bufferedEntries = performance.getEntriesByType('largest-contentful-paint');
                        if (bufferedEntries.length > 0) {
                            const lastEntry = bufferedEntries[bufferedEntries.length - 1];
                            lcpEntry = {
                                startTime: lastEntry.startTime,
                                size: lastEntry.size,
                                url: lastEntry.url || '',
                                element: lastEntry.element?.tagName || ''
                            };
                        }
                    }
                    resolve(lcpEntry);
                }, 3000);
            });
        });

        await page.close();
        await context.close();
        return lcpData;
        
    } catch (error) {
        console.error(`访问 ${url} 时出错: ${error.message}`);
        await page.close();
        await context.close();
        return null;
    }
}

async function runMultipleTests(browser, url, testCount = 3) {
    const results = [];
    
    for (let i = 0; i < testCount; i++) {
        console.log(`    第 ${i + 1}/${testCount} 次测试...`);
        const lcpData = await getLCPTime(browser, url);
        if (lcpData) {
            results.push(lcpData);
        }
    }
    
    if (results.length === 0) {
        return null;
    }
    
    const avgLcpTime = results.reduce((sum, r) => sum + r.startTime, 0) / results.length;
    const avgLcpSize = results.reduce((sum, r) => sum + r.size, 0) / results.length;
    const minLcpTime = Math.min(...results.map(r => r.startTime));
    const maxLcpTime = Math.max(...results.map(r => r.startTime));
    
    return {
        avgLcpTime,
        avgLcpSize,
        minLcpTime,
        maxLcpTime,
        testCount: results.length,
        allResults: results
    };
}

async function runPerformanceTest(webUrls, browserDir, outputPath = './lcp-results.xlsx', testCount = 3) {
    console.log('开始性能测试...');
    console.log(`浏览器目录: ${browserDir}`);
    console.log(`测试网址数量: ${webUrls.length}`);
    console.log(`每个网址测试次数: ${testCount}`);
    
    const browsers = await findChromeExecutables(browserDir);
    
    if (browsers.length === 0) {
        console.error('未找到任何浏览器内核');
        return;
    }
    
    console.log(`找到 ${browsers.length} 个浏览器内核:`);
    browsers.forEach(b => console.log(`  - ${b.name}: ${b.path}`));
    
    const results = [];
    
    for (const browserInfo of browsers) {
        console.log(`\n正在测试浏览器: ${browserInfo.name}`);
        
        let browser;
        try {
            browser = await puppeteer.launch({
                executablePath: browserInfo.path,
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-cache',
                    '--disable-application-cache',
                    '--disable-offline-load-stale-cache'
                ]
            });
        } catch (error) {
            console.error(`启动浏览器 ${browserInfo.name} 失败: ${error.message}`);
            continue;
        }
        
        for (const url of webUrls) {
            console.log(`  测试网址: ${url}`);
            
            const testData = await runMultipleTests(browser, url, testCount);
            
            if (testData) {
                results.push({
                    browserName: browserInfo.name,
                    browserPath: browserInfo.path,
                    url: url,
                    avgLcpTime: testData.avgLcpTime.toFixed(2),
                    minLcpTime: testData.minLcpTime.toFixed(2),
                    maxLcpTime: testData.maxLcpTime.toFixed(2),
                    avgLcpSize: testData.avgLcpSize.toFixed(0),
                    testCount: testData.testCount,
                    testTime: new Date().toLocaleString('zh-CN'),
                    status: '成功'
                });
                
                console.log(`    平均LCP: ${testData.avgLcpTime.toFixed(2)}ms (最小: ${testData.minLcpTime.toFixed(2)}ms, 最大: ${testData.maxLcpTime.toFixed(2)}ms)`);
            } else {
                results.push({
                    browserName: browserInfo.name,
                    browserPath: browserInfo.path,
                    url: url,
                    avgLcpTime: null,
                    minLcpTime: null,
                    maxLcpTime: null,
                    avgLcpSize: null,
                    testCount: 0,
                    testTime: new Date().toLocaleString('zh-CN'),
                    status: '失败'
                });
            }
        }
        
        await browser.close();
    }
    
    const finalPath = await exportToExcel(results, outputPath);
    console.log(`\n测试完成！结果已保存到: ${finalPath}`);
    
    return results;
}

async function exportToExcel(results, outputPath) {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('LCP性能测试结果');
    
    const now = new Date();
    const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    
    const ext = path.extname(outputPath);
    const baseName = path.basename(outputPath, ext);
    const dir = path.dirname(outputPath);
    const finalOutputPath = path.join(dir, `${baseName}_${timestamp}${ext}`);
    
    worksheet.columns = [
        { header: '浏览器名称', key: 'browserName', width: 20 },
        { header: '浏览器路径', key: 'browserPath', width: 50 },
        { header: '测试网址', key: 'url', width: 40 },
        { header: '平均LCP时间(ms)', key: 'avgLcpTime', width: 18 },
        { header: '最小LCP时间(ms)', key: 'minLcpTime', width: 18 },
        { header: '最大LCP时间(ms)', key: 'maxLcpTime', width: 18 },
        { header: '平均LCP元素大小', key: 'avgLcpSize', width: 18 },
        { header: '测试次数', key: 'testCount', width: 12 },
        { header: '测试时间', key: 'testTime', width: 20 },
        { header: '状态', key: 'status', width: 10 }
    ];
    
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' }
    };
    
    results.forEach(result => {
        worksheet.addRow(result);
    });
    
    worksheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1) {
            const status = row.getCell(10).value;
            if (status === '失败') {
                row.eachCell(cell => {
                    cell.fill = {
                        type: 'pattern',
                        pattern: 'solid',
                        fgColor: { argb: 'FFFFCCCC' }
                    };
                });
            }
        }
    });
    
    await workbook.xlsx.writeFile(finalOutputPath);
    return finalOutputPath;
}

module.exports = {
    runPerformanceTest,
    findChromeExecutables,
    getLCPTime,
    exportToExcel
};
