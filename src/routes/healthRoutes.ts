import { Request, Response, Router } from 'express';
import pool from '../config/database';
import { redisCache, redisQueue, redisAnalytics } from '../config/redis';
import { openAICircuitBreaker, pineconeCircuitBreaker } from '../utils/circuitBreaker';
import logger from '../utils/logger';

const router = Router();

/**
 * Basic health check - fast response for load balancer
 */
router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

/**
 * Detailed health check with dependency status
 */
router.get('/health/detailed', async (_req: Request, res: Response) => {
  const startTime = Date.now();
  const health: any = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    node_version: process.version,
    memory: {
      used: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100,
      total: Math.round((process.memoryUsage().heapTotal / 1024 / 1024) * 100) / 100,
      external: Math.round((process.memoryUsage().external / 1024 / 1024) * 100) / 100,
      rss: Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100,
      unit: 'MB',
    },
    dependencies: {} as any,
  };

  let allHealthy = true;

  // Check PostgreSQL
  try {
    await pool.query('SELECT NOW()');
    health.dependencies.database = {
      status: 'healthy',
      responseTime: Date.now() - startTime,
    };
  } catch (error) {
    allHealthy = false;
    health.dependencies.database = {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Check Redis Cache
  try {
    const redisCacheStart = Date.now();
    await redisCache.ping();
    health.dependencies.redisCache = {
      status: 'healthy',
      responseTime: Date.now() - redisCacheStart,
    };
  } catch (error) {
    allHealthy = false;
    health.dependencies.redisCache = {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Check Redis Queue
  try {
    const redisQueueStart = Date.now();
    await redisQueue.ping();
    health.dependencies.redisQueue = {
      status: 'healthy',
      responseTime: Date.now() - redisQueueStart,
    };
  } catch (error) {
    allHealthy = false;
    health.dependencies.redisQueue = {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Check Redis Analytics
  try {
    const redisAnalyticsStart = Date.now();
    await redisAnalytics.ping();
    health.dependencies.redisAnalytics = {
      status: 'healthy',
      responseTime: Date.now() - redisAnalyticsStart,
    };
  } catch (error) {
    allHealthy = false;
    health.dependencies.redisAnalytics = {
      status: 'unhealthy',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Circuit breaker states
  health.circuitBreakers = {
    openAI: openAICircuitBreaker.getMetrics(),
    pinecone: pineconeCircuitBreaker.getMetrics(),
  };

  // Overall status
  health.status = allHealthy ? 'healthy' : 'degraded';

  const statusCode = allHealthy ? 200 : 503;
  res.status(statusCode).json(health);
});

/**
 * Readiness probe - checks if service is ready to receive traffic
 */
router.get('/ready', async (_req: Request, res: Response) => {
  try {
    // Check critical dependencies
    await pool.query('SELECT 1');
    await redisCache.ping();

    res.status(200).json({
      status: 'ready',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Readiness check failed', { error });
    res.status(503).json({
      status: 'not ready',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Liveness probe - checks if service is alive
 */
router.get('/live', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

/**
 * Metrics endpoint for monitoring (Prometheus-compatible)
 */
router.get('/metrics', async (_req: Request, res: Response) => {
  try {
    const metrics: string[] = [];

    // Process metrics
    const mem = process.memoryUsage();
    metrics.push(`# HELP process_heap_bytes Process heap size in bytes`);
    metrics.push(`# TYPE process_heap_bytes gauge`);
    metrics.push(`process_heap_bytes{type="used"} ${mem.heapUsed}`);
    metrics.push(`process_heap_bytes{type="total"} ${mem.heapTotal}`);

    metrics.push(`# HELP process_resident_memory_bytes Process resident memory in bytes`);
    metrics.push(`# TYPE process_resident_memory_bytes gauge`);
    metrics.push(`process_resident_memory_bytes ${mem.rss}`);

    metrics.push(`# HELP process_uptime_seconds Process uptime in seconds`);
    metrics.push(`# TYPE process_uptime_seconds counter`);
    metrics.push(`process_uptime_seconds ${process.uptime()}`);

    // Database pool metrics (if available)
    metrics.push(`# HELP db_pool_total Total database connections in pool`);
    metrics.push(`# TYPE db_pool_total gauge`);
    metrics.push(`db_pool_total ${pool.totalCount}`);

    metrics.push(`# HELP db_pool_idle Idle database connections in pool`);
    metrics.push(`# TYPE db_pool_idle gauge`);
    metrics.push(`db_pool_idle ${pool.idleCount}`);

    metrics.push(`# HELP db_pool_waiting Waiting database connections in pool`);
    metrics.push(`# TYPE db_pool_waiting gauge`);
    metrics.push(`db_pool_waiting ${pool.waitingCount}`);

    // Circuit breaker metrics
    const openAIMetrics = openAICircuitBreaker.getMetrics();
    metrics.push(`# HELP circuit_breaker_state Circuit breaker state (0=CLOSED, 1=HALF_OPEN, 2=OPEN)`);
    metrics.push(`# TYPE circuit_breaker_state gauge`);
    const stateValue = openAIMetrics.state === 'CLOSED' ? 0 : openAIMetrics.state === 'HALF_OPEN' ? 1 : 2;
    metrics.push(`circuit_breaker_state{service="openai"} ${stateValue}`);

    const pineconeMetrics = pineconeCircuitBreaker.getMetrics();
    const pineconeStateValue = pineconeMetrics.state === 'CLOSED' ? 0 : pineconeMetrics.state === 'HALF_OPEN' ? 1 : 2;
    metrics.push(`circuit_breaker_state{service="pinecone"} ${pineconeStateValue}`);

    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.status(200).send(metrics.join('\n') + '\n');
  } catch (error) {
    logger.error('Metrics endpoint error', { error });
    res.status(500).json({ error: 'Failed to generate metrics' });
  }
});

export default router;
