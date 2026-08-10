import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openNoteStore } from './db.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel, {
  service: config.serviceName,
  envId: config.envId,
});
const store = openNoteStore(config.databasePath);
const app = createApp(store, config, logger);

const server = app.listen(config.port, () => {
  logger.info('service started', {
    port: config.port,
    nodeEnv: config.nodeEnv,
    databasePath: config.databasePath,
    authMode: config.authMode,
    authServiceUrl: config.authServiceUrl,
  });
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown requested', { signal });

  const forceExit = setTimeout(() => {
    logger.warn('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, config.shutdownGraceMs);
  forceExit.unref();

  server.close((error) => {
    if (error) {
      logger.error('error while closing server', { err: error.message });
      process.exit(1);
    }
    store.close();
    logger.info('shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection', { reason: String(reason) });
});
