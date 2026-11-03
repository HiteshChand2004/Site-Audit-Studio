// Stands in for audit/lighthouse/worker.js in lighthouse-lane.test.js: same message protocol, no Chrome. The URL says what to do:
// stub://run?ms=<how long>&fail=1 (exit with an error instead of answering). It answers with when it really started and ended.
process.once('message', ({ url, formFactor }) => {
  const q = new URL(url).searchParams;
  const startedAt = Date.now();
  setTimeout(() => {
    if (q.get('fail')) process.exit(3);
    process.send({ type: 'done', summary: { url, formFactor, startedAt, endedAt: Date.now() } }, () => process.exit(0));
  }, Number(q.get('ms')) || 0);
});
