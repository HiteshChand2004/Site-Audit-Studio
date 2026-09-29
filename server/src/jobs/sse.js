// Streams one job's events (progress/done/failed) over SSE. Jobs that already left memory are
// answered from their database row and the stream is closed.
const HEARTBEAT_MS = 15000;

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('./manager.js').JobManager} manager
 * @param {string} jobId
 * @param {() => ({id:string,status:string,error:string|null}|undefined)} loadRow
 */
export function streamJob(req, res, manager, jobId, loadRow) {
  const job = manager.get(jobId);
  const row = job ? null : loadRow();
  if (!job && !row) return res.status(404).json({ error: 'Job not found.' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  if (!job) {
    if (row.status === 'done') send('done', { id: row.id, status: 'done' });
    else send('failed', { id: row.id, status: row.status, error: row.error || 'This job is no longer running.' });
    return res.end();
  }

  send('progress', job);
  if (job.status === 'done' || job.status === 'failed') {
    send(job.status, job);
    return res.end();
  }

  // A named event, not an SSE comment: browsers never hand comments to the page, and the client
  // uses the ping to notice a stream that went silent (a proxy can keep it open after the API died).
  const heartbeat = setInterval(() => send('ping', {}), HEARTBEAT_MS);
  const cleanup = () => {
    clearInterval(heartbeat);
    manager.off(jobId, listener);
  };
  function listener(type, data) {
    send(type, data);
    if (type === 'done' || type === 'failed') {
      cleanup();
      res.end();
    }
  }
  manager.on(jobId, listener);
  req.on('close', cleanup);
}
