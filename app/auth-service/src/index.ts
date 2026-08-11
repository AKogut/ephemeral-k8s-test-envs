import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openUserStore } from './db.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config.logLevel, {
  service: config.serviceName,
  envId: config.envId,
});
const store = openUserStore(config);
const app = createApp(store, config, logger);

const server = app.listen(config.port, () => {
  logger.info('service started', {
    port: config.port,
    nodeEnv: config.nodeEnv,
    database: config.database.backend,
    scryptCostLog2: config.scryptCostLog2,
  });
});

/**
 * Kubernetes sends SIGTERM and then waits `terminationGracePeriodSeconds`
 * before SIGKILL. Draining in-flight requests here is what keeps a rolling
 * update from turning into flaky test failures.
 */
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
    // Closing the store is awaited rather than fired off: for SQLite it
    // returns immediately, but a connection pool has sockets to drain, and
    // exiting first would abandon them mid-flight. `forceExit` above is the
    // backstop if it ever hangs.
    store.close().then(
      () => {
        logger.info('shutdown complete');
        process.exit(0);
      },
      (closeError: unknown) => {
        logger.error('error while closing the store', { err: String(closeError) });
        process.exit(1);
      },
    );
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection', { reason: String(reason) });
});
