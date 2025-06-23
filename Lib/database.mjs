// lib/database.js - Database utilities with multi-database support
import sql from 'mssql';
import dotenv from 'dotenv';
import { logger } from './logger.mjs';

dotenv.config();

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
            port: config.port || 1433,
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
        
        databaseConfigs[databaseId] = fullConfig;
        logger.info(`Registered database: ${databaseId} (${config.server}/${config.database})`);
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
    
    try {
        logger.info(`Initializing SQL Server connection pool for: ${dbId}...`);
        
        const config = databaseConfigs[dbId];
        
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
        logger.error(`Failed to initialize SQL Server connection pool for ${dbId}: ${err.message}`);
        throw err;
    }
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
export async function executeQuery(sqlQuery, parameters = {}, retryCount = 3, databaseId = null) {
    const dbId = databaseId || currentDatabaseId;
    
    if (sqlQuery.length > 100) {
        logger.info(`Executing SQL on ${dbId}: ${sqlQuery.substring(0, 100)}...`);
    } else {
        logger.info(`Executing SQL on ${dbId}: ${sqlQuery}`);
    }
    
    await ensurePoolConnected(dbId);
    
    try {
        const request = sqlPools[dbId].request();
        
        // Add parameters if provided
        for (const [key, value] of Object.entries(parameters)) {
            request.input(key, value);
        }
        
        const startTime = Date.now();
        const result = await request.query(sqlQuery);
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
export async function executeQueryOnMultipleDatabases(sqlQuery, databaseIds, parameters = {}) {
    if (!Array.isArray(databaseIds) || databaseIds.length === 0) {
        throw new Error('No database IDs provided');
    }
    
    // Validate all database IDs exist
    for (const dbId of databaseIds) {
        if (!databaseConfigs[dbId]) {
            throw new Error(`Database configuration not found: ${dbId}`);
        }
    }
    
    logger.info(`Executing query on ${databaseIds.length} databases: ${databaseIds.join(', ')}`);
    
    // Execute queries in parallel
    const promises = databaseIds.map(async (dbId) => {
        try {
            const result = await executeQuery(sqlQuery, parameters, 3, dbId);
            return {
                databaseId: dbId,
                success: true,
                result: result,
                server: databaseConfigs[dbId].server,
                database: databaseConfigs[dbId].database
            };
        } catch (err) {
            logger.error(`Query failed on database ${dbId}: ${err.message}`);
            return {
                databaseId: dbId,
                success: false,
                error: err.message,
                server: databaseConfigs[dbId].server,
                database: databaseConfigs[dbId].database
            };
        }
    });
    
    const results = await Promise.allSettled(promises);
    
    return results.map(result => result.status === 'fulfilled' ? result.value : {
        databaseId: 'unknown',
        success: false,
        error: result.reason?.message || 'Unknown error'
    });
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

// Only initialize default database pool if we're in single-database mode
// In multi-database mode, the multi-db-config loader handles initialization
// Check if multi-db-config.json exists to determine mode
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const multiDbConfigPath = path.join(__dirname, '..', 'multi-db-config.json');
const hasMultiDatabaseConfig = fs.existsSync(multiDbConfigPath);

if (!hasMultiDatabaseConfig && process.env.DB_SERVER) {
    logger.info("Single database mode detected, initializing default database pool...");
initializeDbPool('default').catch(err => {
    logger.error(`Failed to initialize default database pool: ${err.message}`);
});
} else if (hasMultiDatabaseConfig) {
    logger.info("Multi-database configuration detected, skipping automatic default database initialization");
}