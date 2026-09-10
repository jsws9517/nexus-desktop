import { callBuiltinTool } from '../../dist/tools/index.js';

async function main() {
  // 1. sheet.analyze
  const analyzeResult = await callBuiltinTool('sheet.analyze', { path: 'D:/agent-cli/nexus-desktop/test/fixtures/sales.csv' });
  const analysisData = JSON.parse(analyzeResult.content);
  const amountCol = analysisData.artifact?.body?.analysis?.find(c => c.name === 'amount');
  console.log(`sum = ${amountCol.sum}`);
  console.log(`mean = ${amountCol.avg.toFixed(2)}`);

  // 2. bi.chart
  const rows = analysisData.artifact.body.rows;
  const chartResult = await callBuiltinTool('bi.chart', {
    data: { columns: ['month', 'amount', 'region'], rows },
    x: 'month', y: 'amount', aggregate: 'sum', mark: 'bar', title: 'Amount by Month'
  });
  const chartData = JSON.parse(chartResult.content);
  console.log('chart status:', chartData.artifact.status);
}

main().catch(err => { console.error(err); process.exit(1); });
