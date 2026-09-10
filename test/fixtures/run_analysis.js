import { callBuiltinTool } from '../../dist/tools/index.js';

async function main() {
  // Step 1: sheet.analyze on sales.csv
  const analyzeResult = await callBuiltinTool('sheet.analyze', { path: 'D:/agent-cli/nexus-desktop/test/fixtures/sales.csv' });
  console.log('=== sheet.analyze ===');
  const analysisData = JSON.parse(analyzeResult.content);
  console.log(JSON.stringify(analysisData, null, 2));
  
  // Extract amount stats
  const amountCol = analysisData.artifact?.body?.analysis?.find(c => c.name === 'amount');
  if (amountCol) {
    console.log('\namount 统计:');
    console.log(`  sum = ${amountCol.sum}`);
    console.log(`  mean = ${amountCol.avg.toFixed(2)}`);
  }

  // Step 2: bi.chart - bar chart of amount by month
  const chartResult = await callBuiltinTool('bi.chart', {
    data: {
      columns: ['month', 'amount', 'region'],
      rows: [['Jan', 120, 'North'], ['Feb', 260, 'North'], ['Mar', 90, 'South'], ['Apr', 310, 'South'], ['May', 150, 'North'], ['Jun', 205, 'East']]
    },
    x: 'month',
    y: 'amount',
    aggregate: 'sum',
    mark: 'bar',
    title: 'Amount by Month'
  });
  console.log('\n=== bi.chart 结果 ===');
  console.log(chartResult.content);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
