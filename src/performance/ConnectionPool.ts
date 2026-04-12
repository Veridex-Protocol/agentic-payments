/**
 * @packageDocumentation
 * @module ConnectionPool
 * @description
 * HTTP Connection Pooling for High-Throughput Agents.
 * 
 * Agents often make rapid bursts of requests (e.g., checking prices, simulating transactions).
 * This module maintains reuseable `http.Agent` and `https.Agent` instances to:
 * - Reduce TCP handshake overhead (Keep-Alive).
 * - Limit concurrent socket connections (Resource management).
 * - Prevent "socket hang up" errors under load.
 */

import https from 'https';
import http from 'http';

export interface PoolConfig {
    /** Maximum sockets per host (default: 10) */
    maxSockets: number;
    /** Maximum total sockets (default: 50) */
    maxTotalSockets: number;
    /** Keep-alive timeout in ms (default: 30000) */
    keepAliveTimeout: number;
    /** Socket timeout in ms (default: 60000) */
    socketTimeout: number;
    /** Free socket timeout in ms (default: 15000) */
    freeSocketTimeout: number;
}

export interface PoolStats {
    totalSockets: number;
    freeSockets: number;
    activeSockets: number;
    pendingRequests: number;
    socketsByHost: Record<string, { active: number; free: number }>;
}

const DEFAULT_CONFIG: PoolConfig = {
    maxSockets: 10,
    maxTotalSockets: 50,
    keepAliveTimeout: 30000,
    socketTimeout: 60000,
    freeSocketTimeout: 15000,
};

export class ConnectionPool {
    private httpsAgent: https.Agent;
    private httpAgent: http.Agent;
    private config: PoolConfig;
    private socketsCreated = 0;
    private requestCount = 0;

    constructor(options: Partial<PoolConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...options };

        this.httpsAgent = new https.Agent({
            keepAlive: true,
            keepAliveMsecs: this.config.keepAliveTimeout,
            maxSockets: this.config.maxSockets,
            maxTotalSockets: this.config.maxTotalSockets,
            maxFreeSockets: this.config.maxSockets,
            timeout: this.config.socketTimeout,
            scheduling: 'fifo',
        });

        this.httpAgent = new http.Agent({
            keepAlive: true,
            keepAliveMsecs: this.config.keepAliveTimeout,
            maxSockets: this.config.maxSockets,
            maxTotalSockets: this.config.maxTotalSockets,
            maxFreeSockets: this.config.maxSockets,
            timeout: this.config.socketTimeout,
            scheduling: 'fifo',
        });

        // Track socket creation
        this.httpsAgent.on('connect', () => {
            this.socketsCreated++;
        });
        this.httpAgent.on('connect', () => {
            this.socketsCreated++;
        });
    }

    /**
     * Get the HTTPS agent for use with fetch/axios.
     */
    getHttpsAgent(): https.Agent {
        return this.httpsAgent;
    }

    /**
     * Get the HTTP agent for use with fetch/axios.
     */
    getHttpAgent(): http.Agent {
        return this.httpAgent;
    }

    /**
     * Get agent based on URL protocol.
     */
    getAgentForUrl(url: string): http.Agent | https.Agent {
        const isHttps = url.startsWith('https://');
        return isHttps ? this.httpsAgent : this.httpAgent;
    }

    /**
     * Create fetch options with connection pooling.
     */
    getFetchOptions(url: string): { agent: http.Agent | https.Agent } {
        this.requestCount++;
        return {
            agent: this.getAgentForUrl(url),
        };
    }

    /**
     * Get pool statistics.
     */
    getStats(): PoolStats {
        const httpsSockets = this.httpsAgent.sockets || {};
        const httpsFreeSockets = this.httpsAgent.freeSockets || {};
        const httpSockets = this.httpAgent.sockets || {};
        const httpFreeSockets = this.httpAgent.freeSockets || {};

        const socketsByHost: Record<string, { active: number; free: number }> = {};

        // Count HTTPS sockets
        for (const host of Object.keys(httpsSockets)) {
            socketsByHost[host] = {
                active: (httpsSockets[host]?.length || 0),
                free: (httpsFreeSockets[host]?.length || 0),
            };
        }
        for (const host of Object.keys(httpsFreeSockets)) {
            if (!socketsByHost[host]) {
                socketsByHost[host] = { active: 0, free: 0 };
            }
            socketsByHost[host].free = httpsFreeSockets[host]?.length || 0;
        }

        // Count HTTP sockets
        for (const host of Object.keys(httpSockets)) {
            const key = `http:${host}`;
            socketsByHost[key] = {
                active: (httpSockets[host]?.length || 0),
                free: (httpFreeSockets[host]?.length || 0),
            };
        }

        // Calculate totals
        let totalActive = 0;
        let totalFree = 0;
        for (const { active, free } of Object.values(socketsByHost)) {
            totalActive += active;
            totalFree += free;
        }

        return {
            totalSockets: totalActive + totalFree,
            freeSockets: totalFree,
            activeSockets: totalActive,
            pendingRequests: (this.httpsAgent as any).requests?.length || 0,
            socketsByHost,
        };
    }

    /**
     * Get total requests made through the pool.
     */
    getRequestCount(): number {
        return this.requestCount;
    }

    /**
     * Get total sockets created.
     */
    getSocketsCreated(): number {
        return this.socketsCreated;
    }

    /**
     * Get connection reuse ratio.
     */
    getReuseRatio(): number {
        if (this.requestCount === 0 || this.socketsCreated === 0) return 0;
        return 1 - (this.socketsCreated / this.requestCount);
    }

    /**
     * Destroy all connections and clean up.
     */
    destroy(): void {
        this.httpsAgent.destroy();
        this.httpAgent.destroy();
    }
}

// Singleton instance for shared connection pooling
let defaultPool: ConnectionPool | null = null;

/**
 * Get the default connection pool instance.
 */
export function getConnectionPool(): ConnectionPool {
    if (!defaultPool) {
        defaultPool = new ConnectionPool();
    }
    return defaultPool;
}

/**
 * Create a new connection pool with custom config.
 */
export function createConnectionPool(config?: Partial<PoolConfig>): ConnectionPool {
    return new ConnectionPool(config);
}
