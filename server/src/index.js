import express from 'express';
import cors from 'cors';
import projectsRouter from './routes/projects.js';
import analyzeRouter from './routes/analyze.js';
import screensRouter from './routes/screens.js';

const PORT = Number(process.env.PORT) || 4000;
const app = express();

app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, phase: 3, time: new Date().toISOString() });
});

app.use('/api/projects', projectsRouter);
app.use('/api/projects', analyzeRouter);
app.use('/api/projects', screensRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error.' });
});

// Express 5 passes listen errors (such as a port conflict) to this callback.
app.listen(PORT, (err) => {
  if (err) {
    console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Stop the other server or set PORT.` : err);
    process.exit(1);
  }
  console.log(`API ready on http://localhost:${PORT}`);
});
