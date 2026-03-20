const { runPerformanceTest } = require('./index');

const webUrls = process.argv[2] ? process.argv[2].split(',') : [
    'https://www.baidu.com',
    'https://www.google.com',
    'https://www.github.com'
];

const browserDir = process.argv[3] || 'C:\\Program Files\\Google\\Chrome\\Application';

const outputPath = process.argv[4] || './lcp-results.xlsx';

const testCount = process.argv[5] ? parseInt(process.argv[5]) : 3;

console.log('='.repeat(60));
console.log('LCP性能自动化测试工具');
console.log('='.repeat(60));
console.log('\n使用方式:');
console.log('  node cli.js <网址列表> <浏览器目录> [输出文件] [测试次数]');
console.log('\n参数说明:');
console.log('  网址列表: 用逗号分隔的网址，如: https://a.com,https://b.com');
console.log('  浏览器目录: 包含多个浏览器内核文件夹的目录');
console.log('  输出文件: Excel输出路径，默认: ./lcp-results.xlsx');
console.log('  测试次数: 每个网址测试次数，默认: 3');
console.log('\n示例:');
console.log('  node cli.js https://www.baidu.com,https://www.qq.com D:\\browsers result.xlsx 5');
console.log('='.repeat(60));
console.log('\n当前配置:');
console.log(`  网址列表: ${webUrls.join(', ')}`);
console.log(`  浏览器目录: ${browserDir}`);
console.log(`  输出文件: ${outputPath}`);
console.log(`  测试次数: ${testCount}`);
console.log('\n');

runPerformanceTest(webUrls, browserDir, outputPath, testCount)
    .then(() => {
        console.log('\n测试完成！');
        process.exit(0);
    })
    .catch(error => {
        console.error('\n测试失败:', error.message);
        process.exit(1);
    });
