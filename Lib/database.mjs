// lib/database.js - Database utilities with multi-database support
import sql from 'mssql';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Force project-local .env values to override inherited shell/IDE env vars.
// This prevents stale exported credentials from causing region login failures.
dotenv.config({ path: path.join(__dirname, '../.env'), override: true });

// Database configurations - support multiple databases
const databaseConfigs = {};
const sqlPools = {};
let currentDatabaseId = 'default';

// Default database configuration
const defaultDbConfig = {
    user: process.env.DB_USER || 'sa',
    password: process.env.DB_PASSWORD || 'YourStrong@Passw0rd',
    server: process.env.DB_SERVER || 'localhost',
    database: process.env.DB_DATABASE || 'master',
    port: parseInt(process.env.DB_PORT) || 1433,
    options: {
        encrypt: process.env.DB_ENCRYPT === 'true',
        trustServerCertificate: true, // Always trust server certificate for self-signed certs
        connectionTimeout: parseInt(process.env.DB_CONNECTION_TIMEOUT) || 15000,
        requestTimeout: parseInt(process.env.DB_REQUEST_TIMEOUT) || 15000,
        pool: {
            max: parseInt(process.env.DB_POOL_MAX) || 10,
            min: parseInt(process.env.DB_POOL_MIN) || 0,
            idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT) || 30000
        }
    }
};

// Register the default database
databaseConfigs['default'] = defaultDbConfig;

/**
 * Register a new database connection
 * @param {string} databaseId - Unique identifier for the database
 * @param {object} config - Database configuration object
 * @returns {boolean} - True if successful
 */
export function registerDatabase(databaseId, config) {
    try {
        if (!databaseId || !config) {
            throw new Error('Database ID and configuration are required');
        }

        // Validate required config fields
        const requiredFields = ['user', 'password', 'server', 'database'];
        for (const field of requiredFields) {
            if (!config[field]) {
                throw new Error(`Missing required field: ${field}`);
            }
        }

        // Set default values for optional fields
        const fullConfig = {
            ...config,
            options: {
                encrypt: config.options?.encrypt || false,
                trustServerCertificate: config.options?.trustServerCertificate !== false,
                connectionTimeout: config.options?.connectionTimeout || 15000,
                requestTimeout: config.options?.requestTimeout || 15000,
                pool: {
                    max: config.options?.pool?.max || 10,
                    min: config.options?.pool?.min || 0,
                    idleTimeoutMillis: config.options?.pool?.idleTimeoutMillis || 30000
                }
            }
        };

        // Named instance support: convert "host\\instance" into server + options.instanceName.
        // This aligns with the mssql driver expected config and avoids hard-forcing port 1433.
        if (typeof fullConfig.server === 'string' && fullConfig.server.includes('\\')) {
            const [host, instanceName] = fullConfig.server.split('\\', 2);
            if (host && instanceName) {
                fullConfig.server = host;
                if (!fullConfig.options.instanceName) {
                    fullConfig.options.instanceName = instanceName;
                }
            }
        }

        // Preserve explicit ports, otherwise default to 1433 only when not using instance lookup.
        if (config.port !== undefined && config.port !== null && config.port !== '') {
            fullConfig.port = parseInt(config.port, 10) || 1433;
        } else if (!fullConfig.options.instanceName) {
            fullConfig.port = 1433;
        } else {
            delete fullConfig.port;
        }

        databaseConfigs[databaseId] = fullConfig;
        const instanceSuffix = fullConfig.options.instanceName ? `\\${fullConfig.options.instanceName}` : '';
        const portSuffix = fullConfig.port ? `:${fullConfig.port}` : '';
        logger.info(`Registered database: ${databaseId} (${fullConfig.server}${instanceSuffix}${portSuffix}/${fullConfig.database})`);
        return true;
    } catch (err) {
        logger.error(`Failed to register database ${databaseId}: ${err.message}`);
        return false;
    }
}

/**
 * Get list of registered databases
 * @returns {Array} - Array of database information
 */
export function getRegisteredDatabases() {
    return Object.keys(databaseConfigs).map(id => ({
        id,
        server: databaseConfigs[id].server,
        database: databaseConfigs[id].database,
        user: databaseConfigs[id].user,
        isConnected: sqlPools[id]?.connected || false
    }));
}

/**
 * Switch to a different database connection
 * @param {string} databaseId - Database ID to switch to
 * @returns {boolean} - True if successful
 */
export function switchDatabase(databaseId) {
    if (!databaseConfigs[databaseId]) {
        logger.error(`Database ${databaseId} not found`);
        return false;
    }

    currentDatabaseId = databaseId;
    logger.info(`Switched to database: ${databaseId}`);
    return true;
}

/**
 * Get current database ID
 * @returns {string} - Current database ID
 */
export function getCurrentDatabaseId() {
    return currentDatabaseId;
}

/**
 * Initialize a SQL connection pool for a specific database
 * @param {string} databaseId - Database ID to initialize
 * @returns {Promise<boolean>} - True if successful
 */
export async function initializeDbPool(databaseId = null) {
    const dbId = databaseId || currentDatabaseId;

    if (!databaseConfigs[dbId]) {
        throw new Error(`Database configuration not found: ${dbId}`);
    }

    const config = databaseConfigs[dbId];
    // DEBUG: Log config details
    logger.info(`DEBUG: Pool Config for ${dbId}: user=${config.user}, server=${config.server}, port=${config.port}, database=${config.database}`);
    logger.info(`DEBUG: Options: ${JSON.stringify(config.options)}`);

    const maxAttempts = parseInt(process.env.DB_CONNECT_RETRIES || '3', 10);
    const retryDelayMs = parseInt(process.env.DB_CONNECT_RETRY_DELAY_MS || '1000', 10);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            logger.info(`Initializing SQL Server connection pool for: ${dbId} (attempt ${attempt}/${maxAttempts})...`);

            // Create and connect the pool
            const pool = await new sql.ConnectionPool(config).connect();

            // Setup pool error handler
            pool.on('error', err => {
                logger.error(`SQL Pool Error (${dbId}): ${err.message}`);
            });

            sqlPools[dbId] = pool;

            logger.info(`SQL Server connection pool initialized successfully for ${dbId} (${config.server}/${config.database})`);
            return true;
        } catch (err) {
            const transientCodes = new Set(['ETIMEOUT', 'ESOCKET', 'EINSTLOOKUP']);
            const isTransient = transientCodes.has(err.code) || /timed out|instance|lookup/i.test(err.message || '');
            const hasAttemptsLeft = attempt < maxAttempts;

            logger.error(`Failed to initialize SQL Server connection pool for ${dbId} (attempt ${attempt}/${maxAttempts}): ${err.message}`);

            if (!isTransient || !hasAttemptsLeft) {
                throw err;
            }

            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        }
    }

    throw new Error(`Failed to initialize SQL Server connection pool for ${dbId}`);
}

/**
 * Check if the SQL pool is connected and initialize if necessary
 * @param {string} databaseId - Database ID to check
 * @returns {Promise<void>}
 */
async function ensurePoolConnected(databaseId = null) {
    const dbId = databaseId || currentDatabaseId;

    if (!sqlPools[dbId]) {
        await initializeDbPool(dbId);
    } else if (!sqlPools[dbId].connected) {
        logger.warn(`SQL Pool disconnected for ${dbId}, reconnecting...`);
        try {
            await sqlPools[dbId].connect();
        } catch (err) {
            logger.error(`Failed to reconnect SQL pool for ${dbId}: ${err.message}`);
            // Create a new pool if reconnect fails
            delete sqlPools[dbId];
            await initializeDbPool(dbId);
        }
    }
}

/**
 * Execute a SQL query with retry logic
 * @param {string} sqlQuery - SQL query to execute
 * @param {object} parameters - Query parameters
 * @param {number} retryCount - Number of retries on transient errors
 * @param {string} databaseId - Optional database ID to execute against
 * @returns {Promise<object>} - Query result
 */
export async function executeQuery(sqlQuery, parameters = {}, retryCount = 3, databaseId = null, timeoutMs = null, dryRun = false) {
    const dbId = databaseId || currentDatabaseId;

    if (sqlQuery.length > 100) {
        logger.info(`Executing SQL on ${dbId}: ${sqlQuery.substring(0, 100)}...`);
    } else {
        logger.info(`Executing SQL on ${dbId}: ${sqlQuery}`);
    }

    await ensurePoolConnected(dbId);

    try {
        const request = sqlPools[dbId].request();
        if (timeoutMs) {
            request.timeout = timeoutMs;
        }

        // Add parameters if provided
        for (const [key, value] of Object.entries(parameters)) {
            request.input(key, value);
        }

        const startTime = Date.now();
        const sqlToRun = dryRun ? `SET SHOWPLAN_XML ON; ${sqlQuery}; SET SHOWPLAN_XML OFF;` : sqlQuery;
        const queryPromise = request.query(sqlToRun);
        const result = timeoutMs
            ? await Promise.race([
                queryPromise,
                new Promise((_, reject) => {
                    const timeoutError = new Error('Query timeout exceeded');
                    timeoutError.code = 'ETIMEOUT';
                    setTimeout(() => reject(timeoutError), timeoutMs);
                })
            ])
            : await queryPromise;
        const executionTime = Date.now() - startTime;

        logger.info(`SQL executed successfully on ${dbId} in ${executionTime}ms, returned ${result.recordset?.length || 0} rows`);

        // Add execution time and database info to result
        result.executionTime = executionTime;
        result.databaseId = dbId;

        return result;
    } catch (err) {
        logger.error(`SQL execution failed on ${dbId}: ${err.message}`);

        // Handle transient errors with retry logic
        const transientErrors = ['ETIMEOUT', 'ECONNCLOSED', 'ECONNRESET', 'ESOCKET'];
        if (transientErrors.includes(err.code) && retryCount > 0) {
            logger.info(`Retrying SQL execution on ${dbId} (${retryCount} attempts left)...`);

            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Force pool reconnection for connection-related errors
            if (['ECONNCLOSED', 'ECONNRESET'].includes(err.code)) {
                delete sqlPools[dbId];
            }

            return executeQuery(sqlQuery, parameters, retryCount - 1, databaseId);
        }

        throw err;
    }
}

/**
 * Execute multiple SQL queries in a transaction
 * @param {Array<{sql: string, parameters: object}>} queries - Array of queries
 * @param {string} databaseId - Optional database ID to execute against
 * @returns {Promise<Array<object>>} - Array of results
 */
export async function executeTransaction(queries, databaseId = null) {
    const dbId = databaseId || currentDatabaseId;

    if (!Array.isArray(queries) || queries.length === 0) {
        throw new Error('No queries provided for transaction');
    }

    logger.info(`Starting transaction on ${dbId} with ${queries.length} queries`);

    await ensurePoolConnected(dbId);

    const transaction = new sql.Transaction(sqlPools[dbId]);

    try {
        await transaction.begin();
        logger.info(`Transaction started on ${dbId}`);

        const results = [];

        for (let i = 0; i < queries.length; i++) {
            const { sql: sqlQuery, parameters = {} } = queries[i];

            logger.info(`Executing transaction query ${i + 1}/${queries.length} on ${dbId}`);

            const request = new sql.Request(transaction);

            // Add parameters if provided
            for (const [key, value] of Object.entries(parameters)) {
                request.input(key, value);
            }

            const result = await request.query(sqlQuery);
            result.databaseId = dbId;
            results.push(result);
        }

        await transaction.commit();
        logger.info(`Transaction committed successfully on ${dbId}`);

        return results;
    } catch (err) {
        logger.error(`Transaction failed on ${dbId}: ${err.message}`);

        // Try to roll back the transaction
        try {
            await transaction.rollback();
            logger.info(`Transaction rolled back on ${dbId}`);
        } catch (rollbackErr) {
            logger.error(`Failed to roll back transaction on ${dbId}: ${rollbackErr.message}`);
        }

        throw err;
    }
}

/**
 * Execute a query on multiple databases simultaneously
 * @param {string} sqlQuery - SQL query to execute
 * @param {Array<string>} databaseIds - Array of database IDs to query
 * @param {object} parameters - Query parameters
 * @returns {Promise<Array<object>>} - Array of results with database info
 */
export async function executeQueryOnMultipleDatabases(sqlQuery, databaseIds, parameters = {}, options = {}) {
    if (!Array.isArray(databaseIds) || databaseIds.length === 0) {
        throw new Error('No database IDs provided');
    }

    // Validate all database IDs exist
    for (const dbId of databaseIds) {
        if (!databaseConfigs[dbId]) {
            throw new Error(`Database configuration not found: ${dbId}`);
        }
    }

    const maxDatabases = parseInt(process.env.MULTI_DB_MAX || '10', 10);
    if (databaseIds.length > maxDatabases) {
        throw new Error(`Too many databases requested (${databaseIds.length}); max is ${maxDatabases}`);
    }

    const concurrency = Math.min(
        options.concurrency || parseInt(process.env.MULTI_DB_CONCURRENCY || '4', 10),
        databaseIds.length
    );
    logger.info(`Executing query on ${databaseIds.length} databases: ${databaseIds.join(', ')} (concurrency=${concurrency})`);

    const results = [];
    let index = 0;

    const runNext = async () => {
        if (index >= databaseIds.length) return;
        const dbId = databaseIds[index++];
        try {
            const result = await executeQuery(sqlQuery, parameters, 3, dbId, options.timeoutMs);
            results.push({
                databaseId: dbId,
                success: true,
                result: result,
                server: databaseConfigs[dbId].server,
                database: databaseConfigs[dbId].database
            });
        } catch (err) {
            logger.error(`Query failed on database ${dbId}: ${err.message}`);
            results.push({
                databaseId: dbId,
                success: false,
                error: err.message,
                server: databaseConfigs[dbId].server,
                database: databaseConfigs[dbId].database
            });
        }
        await runNext();
    };

    await Promise.all(Array.from({ length: concurrency }, () => runNext()));

    return results;
}

/**
 * Check if a table exists in the database
 * @param {string} tableName - Table name to check
 * @param {string} databaseId - Optional database ID to check
 * @returns {Promise<boolean>} - True if table exists
 */
export async function tableExists(tableName, databaseId = null) {
    try {
        const result = await executeQuery(`
            SELECT COUNT(*) AS TableCount
            FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_NAME = @tableName
        `, {
            tableName
        }, 3, databaseId);

        return result.recordset[0].TableCount > 0;
    } catch (err) {
        logger.error(`Error checking if table exists: ${err.message}`);
        return false;
    }
}

/**
 * Sanitize SQL identifier to prevent SQL injection
 * @param {string} identifier - Identifier to sanitize
 * @returns {string} - Sanitized identifier
 */
export function sanitizeSqlIdentifier(identifier) {
    if (!identifier) return '';

    // Remove brackets if present
    identifier = identifier.replace(/^\[|\]$/g, '');

    // Remove SQL injection characters and non-alphanumeric characters
    return identifier.replace(/[^a-zA-Z0-9_]/g, '');
}

/**
 * Get database configuration with optional password masking
 * @param {boolean} maskPassword - Whether to mask the password
 * @param {string} databaseId - Optional database ID to get config for
 * @returns {object} - Database configuration
 */
export function getDbConfig(maskPassword = false, databaseId = null) {
    const dbId = databaseId || currentDatabaseId;
    const config = { ...databaseConfigs[dbId] };

    if (maskPassword) {
        config.password = '********';
    }

    return config;
}

/**
 * Format SQL error for human-readable output
 * @param {Error} error - SQL error
 * @returns {string} - Formatted error message
 */
export function formatSqlError(error) {
    if (!error) return 'Unknown error';

    // Special handling for SQL Server errors
    if (error.number) {
        return `SQL Error ${error.number}: ${error.message}`;
    }

    return error.message || 'Unknown SQL error';
}

/**
 * Check health of all database connections
 * @returns {Promise<Array>} - Array of health check results
 */
export async function checkDatabaseHealth() {
    const results = [];

    for (const [dbId, pool] of Object.entries(sqlPools)) {
        try {
            if (pool && pool.connected) {
                // Execute simple health check query
                const startTime = Date.now();
                await pool.request().query('SELECT 1 AS health_check');
                const latency = Date.now() - startTime;

                results.push({
                    databaseId: dbId,
                    status: 'healthy',
                    latencyMs: latency,
                    connected: true
                });
            } else {
                results.push({
                    databaseId: dbId,
                    status: 'disconnected',
                    connected: false
                });
            }
        } catch (err) {
            results.push({
                databaseId: dbId,
                status: 'error',
                error: err.message,
                connected: false
            });
        }
    }

    return results;
}

// Only initialize default database pool if we're in single-database mode
// In multi-database mode, the multi-db-config loader handles initialization
// Check if multi-db-config.json exists to determine mode
const multiDbConfigPath = path.join(__dirname, '..', 'multi-db-config.json');
const hasMultiDatabaseConfig = fs.existsSync(multiDbConfigPath);

if (!hasMultiDatabaseConfig && process.env.DB_SERVER) {
    logger.info("Single database mode detected, initializing default database pool...");
    initializeDbPool('default')
        .then(() => {
            logger.info("Default database pool initialized successfully");
        })
        .catch(err => {
            logger.error(`Failed to initialize default database pool: ${err.message}`);
            logger.warn("Server will continue without database connection - tools may fail until connection is established");
        });
} else if (hasMultiDatabaseConfig) {
    logger.info("Multi-database configuration detected, skipping automatic default database initialization");
} else {
    logger.warn("No DB_SERVER configured and no multi-db-config.json found - database features will not be available until configured");
}
