import { createApp } from './app.js';

const app = createApp();
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '0.0.0.0';
const server = app.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => { app.locals.close(); process.exit(0); }));
}
