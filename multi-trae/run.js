const { runPerformanceTest } = require('./index');
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, 'config.json');

if (!fs.existsSync(configPath)) {
    console.error('配置文件 config.json 不存在');
    process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const testCount = config.testCount || 3;

console.log('='.repeat(60));
console.log('LCP性能自动化测试工具 (配置文件模式)');
console.log('='.repeat(60));
console.log('\n当前配置:');
console.log(`  网址列表: ${config.webUrls.join(', ')}`);
console.log(`  浏览器目录: ${config.browserDir}`);
console.log(`  输出文件: ${config.outputPath}`);
console.log(`  每个网址测试次数: ${testCount}`);
console.log('\n');

runPerformanceTest(config.webUrls, config.browserDir, config.outputPath, testCount)
    .then(() => {
        console.log('\n测试完成！');
        process.exit(0);
    })
    .catch(error => {
        console.error('\n测试失败:', error.message);
        process.exit(1);
    });
