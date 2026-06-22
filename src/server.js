// EventLight — Express server entry point.
import express from 'express';
import { migrate } from './db/migrate.js';
import { startScheduler } from './scheduler/cron.js';
import { PORT, PUBLIC_DIR } from './config.js';
import eventsRouter from './routes/events.js';
import settingsRouter from './routes/settings.js';
import refreshRouter from './routes/refresh.js';
import statusRouter from './routes/status.js';

// Initialise the database before anything queries it.
migrate();

const app = express();
app.use(express.json({ limit: '1mb' }));

// API routes.
app.use('/api', eventsRouter);
app.use('/api', settingsRouter);
app.use('/api', refreshRouter);
app.use('/api', statusRouter);

// Static frontend.
app.use(express.static(PUBLIC_DIR));

// Centralised error handler — keeps the server alive on unexpected route errors.
app.use((err, req, res, next) => {
  console.error('[server] route error', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message });
});

const server = app.listen(PORT, () => {
  console.log(`\n  EventLight running at http://localhost:${PORT}\n`);
  startScheduler();
});

// Never let an unhandled async error take the whole server down.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException:', err);
});

export default server;
