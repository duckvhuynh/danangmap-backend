const expected = process.argv[2];
if (!['up', 'degraded'].includes(expected)) {
  throw new Error('Expected mail readiness must be up or degraded');
}
const deadline = Date.now() + Number(process.argv[3] ?? 30_000);
let last;
while (Date.now() < deadline) {
  try {
    const response = await fetch('http://localhost:4000/health/ready');
    last = await response.json();
    const checks = last?.checks;
    if (
      response.status === 200 &&
      last?.status === 'ok' &&
      checks?.postgres === 'up' &&
      checks?.redis === 'up' &&
      checks?.migrations === 'current' &&
      checks?.minio === 'up' &&
      checks?.mail === expected
    ) {
      process.stdout.write(`Core ready; mail=${expected}\n`);
      process.exit(0);
    }
  } catch {
    // Poll through container transitions without emitting dependency details.
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
throw new Error(`Mail readiness did not become ${expected}: ${JSON.stringify(last)}`);
