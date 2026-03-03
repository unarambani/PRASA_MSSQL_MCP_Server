// lib/tools.js - Database tool implementations
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import {
    executeQuery,
    tableExists,
    sanitizeSqlIdentifier,
    formatSqlError,
    registerDatabase,
    getRegisteredDatabases,
    switchDatabase,
    getCurrentDatabaseId,
    executeQueryOnMultipleDatabases,
    checkDatabaseHealth,
    getDbConfig
} from './database.mjs';
// Import new pagination utilities
import {
    paginateQuery,
    generateNextCursor,
    generatePrevCursor,
    formatPaginationMetadata,
    extractDefaultCursorField
} from './pagination.mjs';
import { logger } from './logger.mjs';
import { createJsonRpcError } from './errors.mjs';

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

// Configuration
const QUERY_RESULTS_PATH = process.env.QUERY_RESULTS_PATH || path.join(__dirname, '../query_results');
const CACHE_DIR = path.join(QUERY_RESULTS_PATH, 'cache');
const WRITE_APPROVAL_TTL_MS = parseInt(process.env.WRITE_APPROVAL_TTL_MS || '300000', 10);
const SLOW_QUERY_MS = parseInt(process.env.SLOW_QUERY_MS || '2000', 10);
const LOCAL_DATABASE_IDS = (process.env.LOCAL_DATABASE_IDS || 'local').split(',').map(s => s.trim()).filter(Boolean);
const LOCAL_HOSTS = (process.env.LOCAL_HOSTS || 'localhost,127.0.0.1,::1').split(',').map(s => s.trim()).filter(Boolean);

const writeApprovals = new Map();

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function resolveOutputPath(outputFile, outputFormat) {
    if (!outputFile) return null;

    const desiredExt = outputFormat === 'csv' ? '.csv' : '.json';
    const denyList = ['/etc', '/bin', '/usr', '/System', '/Library', '/Applications']
        .map(dir => path.resolve(dir));

    let candidate = outputFile;
    const looksLikeDir = candidate.endsWith(path.sep) || candidate.endsWith('/') || candidate.endsWith('\\');

    if (!looksLikeDir && !path.extname(candidate)) {
        candidate += desiredExt;
    }

    let resolved = path.isAbsolute(candidate)
        ? path.resolve(candidate)
        : path.resolve(QUERY_RESULTS_PATH, candidate);

    for (const blockedDir of denyList) {
        if (resolved === blockedDir || resolved.startsWith(blockedDir + path.sep)) {
            return { error: `Output path is not allowed: ${blockedDir}` };
        }
    }

    if (looksLikeDir || (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory())) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `query-results-${timestamp}-${crypto.randomUUID()}${desiredExt}`;
        resolved = path.join(resolved, filename);
    }

    const ext = path.extname(resolved).toLowerCase();
    const baseExt = ext === '.gz' ? path.extname(resolved.slice(0, -3)).toLowerCase() : ext;
    if (baseExt && baseExt !== '.json' && baseExt !== '.csv') {
        return { error: `Output extension must be .json or .csv` };
    }

    if (!baseExt) {
        resolved += desiredExt;
    }

    return { path: resolved };
}

function normalizeParameters(parameters) {
    if (!parameters || typeof parameters !== 'object') return '{}';
    const keys = Object.keys(parameters).sort();
    const normalized = {};
    for (const key of keys) {
        normalized[key] = parameters[key];
    }
    return JSON.stringify(normalized);
}

function normalizeSqlForApproval(sql) {
    if (!sql || typeof sql !== 'string') return '';
    return sql
        .replace(/--.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\s+/g, ' ')
        .replace(/;+$/g, '')
        .trim()
        .toLowerCase();
}

function getApprovalKey(sql, parameters, databaseId) {
    const hash = crypto.createHash('sha256');
    hash.update(normalizeSqlForApproval(sql));
    hash.update('|');
    hash.update(normalizeParameters(parameters));
    hash.update('|');
    hash.update(databaseId || getCurrentDatabaseId());
    return hash.digest('hex');
}

function createApprovalToken(sql, parameters, databaseId) {
    const token = crypto.randomUUID();
    const key = getApprovalKey(sql, parameters, databaseId);
    const expiresAt = Date.now() + WRITE_APPROVAL_TTL_MS;
    writeApprovals.set(token, { key, expiresAt });
    return { token, expiresAt };
}

function validateApprovalToken(token, sql, parameters, databaseId) {
    if (!token) return false;
    const requestedApproval = String(token).trim().toLowerCase();
    const isHumanApprovalShortcut = ['approved', 'approve', 'yes', 'y', 'true'].includes(requestedApproval);

    if (!writeApprovals.has(token)) {
        if (!isHumanApprovalShortcut) return false;

        // UX fallback: allow explicit human approval words to confirm the
        // most recent matching pending approval request for this exact query.
        const key = getApprovalKey(sql, parameters, databaseId);
        for (const [pendingToken, entry] of writeApprovals.entries()) {
            if (!entry) continue;
            if (entry.expiresAt < Date.now()) {
                writeApprovals.delete(pendingToken);
                continue;
            }
            if (entry.key === key) {
                writeApprovals.delete(pendingToken);
                return true;
            }
        }
        return false;
    }

    const entry = writeApprovals.get(token);
    if (!entry || entry.expiresAt < Date.now()) {
        writeApprovals.delete(token);
        return false;
    }

    const key = getApprovalKey(sql, parameters, databaseId);
    if (entry.key !== key) return false;

    writeApprovals.delete(token);
    return true;
}

function extractApprovalToken(args) {
    if (!args || typeof args !== 'object') return undefined;
    return args.approvalToken || args.approval_token;
}

function classifySqlOperation(sql) {
    const normalized = sql.toLowerCase().replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const writeOps = ['insert', 'update', 'delete', 'merge', 'truncate'];
    const ddlOps = ['alter', 'drop', 'create'];
    const execOps = ['exec', 'execute'];

    for (const op of writeOps) {
        if (new RegExp(`\\b${op}\\b`).test(normalized)) return 'dml';
    }
    for (const op of ddlOps) {
        if (new RegExp(`\\b${op}\\b`).test(normalized)) return 'ddl';
    }
    for (const op of execOps) {
        if (new RegExp(`\\b${op}\\b`).test(normalized)) return 'exec';
    }
    return 'read';
}

function isLocalDatabase(databaseId) {
    const dbId = databaseId || getCurrentDatabaseId();
    if (LOCAL_DATABASE_IDS.includes(dbId)) return true;

    try {
        const config = getDbConfig(true, dbId);
        const host = (config?.server || '').toLowerCase();
        return LOCAL_HOSTS.includes(host);
    } catch {
        return false;
    }
}

function getCacheKey(sql, parameters, databaseId) {
    const hash = crypto.createHash('sha256');
    hash.update(sql);
    hash.update('|');
    hash.update(normalizeParameters(parameters));
    hash.update('|');
    hash.update(databaseId || getCurrentDatabaseId());
    return hash.digest('hex');
}

function readCache(cacheKey, ttlSeconds) {
    if (!ttlSeconds || ttlSeconds <= 0) return null;
    const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);
    if (!fs.existsSync(cachePath)) return null;

    try {
        const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        const ageMs = Date.now() - new Date(data.createdAt).getTime();
        if (ageMs > ttlSeconds * 1000) return null;
        return data.payload;
    } catch {
        return null;
    }
}

function writeCache(cacheKey, payload) {
    const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);
    try {
        const data = {
            createdAt: new Date().toISOString(),
            payload
        };
        fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
    } catch (err) {
        logger.warn(`Failed to write cache entry: ${err.message}`);
    }
}

/**
 * Register all database tools
 * @param {object} server - MCP server instance
 */
function registerDatabaseTools(server) {
    logger.info("Registering database tools...");

    // Make sure server._tools exists
    if (!server._tools) {
        server._tools = {};
    }

    // Helper function to register tools with all name variants
    const registerWithAllAliases = (name, schema, handler) => {
        try {
            // Register with mcp_ prefix
            server.tool(`mcp_${name}`, schema, handler);

            // Register with mcp_SQL_ prefix for Claude client compatibility
            server.tool(`mcp_SQL_${name}`, schema, handler);

            // Make sure server._tools exists
            if (!server._tools) {
                server._tools = {};
            }

            // Also add directly to server._tools (since tool registration is not working)
            server._tools[`mcp_${name}`] = { schema, handler };
            server._tools[`mcp_SQL_${name}`] = { schema, handler };

            logger.info(`Registered tool: mcp_${name} and mcp_SQL_${name}`);
        } catch (err) {
            logger.error(`Failed to register tool ${name}: ${err.message}`);
        }
    };

    // Register all database tools
    registerExecuteQueryTool(server, registerWithAllAliases);
    registerTableDetailsTool(server, registerWithAllAliases);
    registerProcedureDetailsTool(server, registerWithAllAliases);
    registerFunctionDetailsTool(server, registerWithAllAliases);
    registerViewDetailsTool(server, registerWithAllAliases);
    registerIndexDetailsTool(server, registerWithAllAliases);
    registerDiscoverTablesTool(server, registerWithAllAliases);
    registerDiscoverDatabaseTool(server, registerWithAllAliases);
    registerGetQueryResultsTool(server, registerWithAllAliases);
    registerDiscoverTool(server, registerWithAllAliases);
    registerCursorGuideTool(server, registerWithAllAliases);
    registerPaginatedQueryTool(server, registerWithAllAliases);
    registerQueryStreamerTool(server, registerWithAllAliases);

    // Register new multi-database tools
    registerDatabaseManagementTools(server, registerWithAllAliases);

    // Register health check tool
    registerHealthCheckTool(server, registerWithAllAliases);

    // Log registered tools for debugging
    logger.info(`Registered tools: ${Object.keys(server._tools).join(", ")}`);
}

/**
 * Register database management tools for multi-database support
 * @param {object} server - MCP server instance
 * @param {function} registerWithAllAliases - Helper to register with all name variants
 */
function registerDatabaseManagementTools(server, registerWithAllAliases) {
    // Register new database connection
    registerWithAllAliases("register_database", {
        databaseId: z.string().min(1, "Database ID cannot be empty"),
        server: z.string().min(1, "Server cannot be empty"),
        database: z.string().min(1, "Database name cannot be empty"),
        user: z.string().min(1, "Username cannot be empty"),
        password: z.string().min(1, "Password cannot be empty"),
        port: z.number().optional().default(1433),
        encrypt: z.boolean().optional().default(false),
        trustServerCertificate: z.boolean().optional().default(true)
    }, async (args) => {
        const { databaseId, server: serverName, database, user, password, port, encrypt, trustServerCertificate } = args;

        try {
            const config = {
                user,
                password,
                server: serverName,
                database,
                port,
                options: {
                    encrypt,
                    trustServerCertificate
                }
            };

            const success = registerDatabase(databaseId, config);

            if (success) {
                return {
                    content: [{
                        type: "text",
                        text: `✅ Successfully registered database: ${databaseId} (${serverName}/${database})`
                    }],
                    result: {
                        databaseId,
                        server: serverName,
                        database,
                        registered: true
                    }
                };
            } else {
                return {
                    content: [{
                        type: "text",
                        text: `❌ Failed to register database: ${databaseId}`
                    }],
                    isError: true
                };
            }
        } catch (err) {
            logger.error(`Failed to register database ${databaseId}: ${err.message}`);
            return {
                content: [{
                    type: "text",
                    text: `❌ Error registering database: ${err.message}`
                }],
                isError: true
            };
        }
    });

    // List registered databases
    registerWithAllAliases("list_databases", {}, async (args) => {
        try {
            const databases = getRegisteredDatabases();
            const currentDb = getCurrentDatabaseId();

            let responseText = `🗄️ Registered Databases (${databases.length}):\n\n`;

            databases.forEach(db => {
                const status = db.isConnected ? '🟢 Connected' : '🔴 Disconnected';
                const current = db.id === currentDb ? ' (CURRENT)' : '';
                responseText += `• ${db.id}${current}\n`;
                responseText += `  Server: ${db.server}\n`;
                responseText += `  Database: ${db.database}\n`;
                responseText += `  User: ${db.user}\n`;
                responseText += `  Status: ${status}\n\n`;
            });

            if (databases.length === 0) {
                responseText = "No databases are registered.";
            }

            return {
                content: [{
                    type: "text",
                    text: responseText
                }],
                result: {
                    databases,
                    currentDatabase: currentDb,
                    count: databases.length
                }
            };
        } catch (err) {
            logger.error(`Failed to list databases: ${err.message}`);
            return {
                content: [{
                    type: "text",
                    text: `❌ Error listing databases: ${err.message}`
                }],
                isError: true
            };
        }
    });

    // Switch database
    registerWithAllAliases("switch_database", {
        databaseId: z.string().min(1, "Database ID cannot be empty")
    }, async (args) => {
        const { databaseId } = args;

        try {
            const success = switchDatabase(databaseId);

            if (success) {
                return {
                    content: [{
                        type: "text",
                        text: `✅ Switched to database: ${databaseId}`
                    }],
                    result: {
                        currentDatabase: databaseId,
                        switched: true
                    }
                };
            } else {
                return {
                    content: [{
                        type: "text",
                        text: `❌ Failed to switch to database: ${databaseId}. Database not found.`
                    }],
                    isError: true
                };
            }
        } catch (err) {
            logger.error(`Failed to switch database to ${databaseId}: ${err.message}`);
            return {
                content: [{
                    type: "text",
                    text: `❌ Error switching database: ${err.message}`
                }],
                isError: true
            };
        }
    });

    // Get current database
    registerWithAllAliases("current_database", {}, async (args) => {
        try {
            const currentDb = getCurrentDatabaseId();
            const databases = getRegisteredDatabases();
            const dbInfo = databases.find(db => db.id === currentDb);

            let responseText = `📍 Current Database: ${currentDb}\n\n`;

            if (dbInfo) {
                responseText += `Server: ${dbInfo.server}\n`;
                responseText += `Database: ${dbInfo.database}\n`;
                responseText += `User: ${dbInfo.user}\n`;
                responseText += `Status: ${dbInfo.isConnected ? '🟢 Connected' : '🔴 Disconnected'}`;
            } else {
                responseText += "Database information not available.";
            }

            return {
                content: [{
                    type: "text",
                    text: responseText
                }],
                result: {
                    currentDatabase: currentDb,
                    databaseInfo: dbInfo
                }
            };
        } catch (err) {
            logger.error(`Failed to get current database: ${err.message}`);
            return {
                content: [{
                    type: "text",
                    text: `❌ Error getting current database: ${err.message}`
                }],
                isError: true
            };
        }
    });

    // Execute query on multiple databases
    registerWithAllAliases("execute_multi_query", {
        sql: z.string().min(1, "SQL query cannot be empty"),
        databaseIds: z.array(z.string()).min(1, "At least one database ID is required"),
        parameters: z.record(z.any()).optional(),
        maxRows: z.number().min(1).max(10000).optional().default(1000),
        concurrency: z.number().min(1).max(20).optional(),
        maxDatabases: z.number().min(1).max(100).optional(),
        timeoutMs: z.number().min(1).max(600000).optional(),
        requestId: z.string().optional()
    }, async (args) => {
        const { sql, databaseIds, parameters = {}, maxRows = 1000, concurrency, maxDatabases, timeoutMs, requestId } = args;

        // Basic validation to prevent destructive operations
        const lowerSql = sql.toLowerCase();
        const prohibitedOperations = ['drop ', 'delete ', 'truncate ', 'update ', 'alter ', 'insert ', 'merge '];

        if (prohibitedOperations.some(op => lowerSql.includes(op))) {
            return {
                content: [{
                    type: "text",
                    text: "⚠️ Error: Data modification operations are not allowed for multi-database queries."
                }],
                isError: true
            };
        }

        try {
            if (maxDatabases && databaseIds.length > maxDatabases) {
                return {
                    content: [{
                        type: "text",
                        text: `Too many databases requested (${databaseIds.length}). Max allowed is ${maxDatabases}.`
                    }],
                    isError: true
                };
            }

            const requestIdValue = requestId || crypto.randomUUID();
            logger.info(`Executing SQL on multiple databases: ${databaseIds.join(', ')}`);
            const startTime = Date.now();
            const results = await executeQueryOnMultipleDatabases(sql, databaseIds, parameters, {
                concurrency,
                timeoutMs,
                requestId: requestIdValue
            });
            const totalTime = Date.now() - startTime;

            let responseText = `🔍 Multi-Database Query Results (${results.length} databases)\n\n`;
            responseText += `Query: ${sql.length > 100 ? sql.substring(0, 100) + '...' : sql}\n`;
            responseText += `Total Execution Time: ${totalTime}ms\n\n`;

            let totalRows = 0;
            let successCount = 0;

            results.forEach(result => {
                if (result.success) {
                    successCount++;
                    const rows = result.result.recordset?.length || 0;
                    totalRows += rows;
                    responseText += `✅ ${result.databaseId} (${result.server}/${result.database}): ${rows} rows in ${result.result.executionTime}ms\n`;
                } else {
                    responseText += `❌ ${result.databaseId} (${result.server}/${result.database}): ${result.error}\n`;
                }
            });

            responseText += `\n📊 Summary: ${successCount}/${results.length} databases succeeded, ${totalRows} total rows returned`;

            return {
                content: [{
                    type: "text",
                    text: responseText
                }],
                result: {
                    results,
                    summary: {
                        totalDatabases: results.length,
                        successfulDatabases: successCount,
                        totalRows,
                        totalExecutionTime: totalTime,
                        requestId: requestIdValue
                    }
                }
            };
        } catch (err) {
            logger.error(`Multi-database query failed: ${err.message}`);
            return {
                content: [{
                    type: "text",
                    text: `❌ Error executing multi-database query: ${formatSqlError(err)}`
                }],
                isError: true
            };
        }
    });
}

/**
 * Register the execute-query tool with pagination support
 * @param {object} server - MCP server instance
 * @param {function} registerWithAllAliases - Helper to register with all name variants
 */
function registerExecuteQueryTool(server, registerWithAllAliases) {
    const schema = {
        sql: z.string().min(1, "SQL query cannot be empty"),
        returnResults: z.boolean().optional().default(false),
        maxRows: z.number().min(1).max(10000).optional().default(1000),
        parameters: z.record(z.any()).optional(),
        databaseId: z.string().optional(),
        outputFile: z.string().optional(),
        outputFormat: z.enum(['json', 'csv']).optional().default('json'),
        compressOutput: z.boolean().optional().default(false),
        csvDelimiter: z.string().optional().default(','),
        csvIncludeHeaders: z.boolean().optional().default(true),
        csvQuoteChar: z.string().optional().default('"'),
        timeoutMs: z.number().min(1).max(600000).optional(),
        dryRun: z.boolean().optional().default(false),
        approvalToken: z.string().optional(),
        cacheTtlSeconds: z.number().min(1).max(86400).optional(),
        requestId: z.string().optional(),
        maxEstimatedRows: z.number().min(1).max(10000000).optional(),
        requireWhere: z.boolean().optional().default(false),
        requireTop: z.boolean().optional().default(false),
        // Pagination parameters
        pageSize: z.number().min(1).max(1000).optional(),
        cursor: z.string().optional(),
        cursorField: z.string().optional(),
        includeCount: z.boolean().optional().default(false)
    };

    const handler = async (args) => {
        const {
            sql,
            returnResults = false,
            maxRows = 1000,
            parameters = {},
            databaseId,
            outputFile,
            outputFormat = 'json',
            compressOutput = false,
            csvDelimiter = ',',
            csvIncludeHeaders = true,
            csvQuoteChar = '"',
            timeoutMs,
            dryRun = false,
            approvalToken,
            cacheTtlSeconds,
            requestId,
            maxEstimatedRows,
            requireWhere = false,
            requireTop = false,
            pageSize,
            cursor,
            cursorField,
            includeCount = false
        } = args;

        const effectiveApprovalToken = approvalToken || extractApprovalToken(args);
        const effectiveDatabaseId = databaseId || getCurrentDatabaseId();
        const operationType = classifySqlOperation(sql);
        const isWrite = operationType === 'dml' || operationType === 'ddl';
        const isLocal = isLocalDatabase(effectiveDatabaseId);

        if (isWrite && !isLocal) {
            if (!effectiveApprovalToken || !validateApprovalToken(effectiveApprovalToken, sql, parameters, effectiveDatabaseId)) {
                logger.warn(`Write approval rejected for database "${effectiveDatabaseId}" (tokenProvided=${Boolean(effectiveApprovalToken)})`);
                const approval = createApprovalToken(sql, parameters, effectiveDatabaseId);
                return {
                    content: [{
                        type: "text",
                        text: `Approval required for data-altering query on non-local database. Re-run with approvalToken to proceed.\napprovalToken: ${approval.token}\napprovalExpiresAt: ${new Date(approval.expiresAt).toISOString()}`
                    }],
                    isError: true,
                    result: {
                        errorCode: "approval_required",
                        approvalToken: approval.token,
                        approvalExpiresAt: new Date(approval.expiresAt).toISOString()
                    }
                };
            }
        }

        if (operationType === 'read') {
            const normalized = sql.toLowerCase();
            if (requireWhere && !/\bwhere\b/.test(normalized)) {
                return {
                    content: [{
                        type: "text",
                        text: "Query rejected: WHERE clause required (requireWhere=true)."
                    }],
                    isError: true,
                    result: {
                        errorCode: "missing_where"
                    }
                };
            }

            if (requireTop && !/\btop\s+\d+\b/.test(normalized) && !/\bfetch\s+next\s+\d+\s+rows\b/.test(normalized)) {
                return {
                    content: [{
                        type: "text",
                        text: "Query rejected: TOP or FETCH required (requireTop=true)."
                    }],
                    isError: true,
                    result: {
                        errorCode: "missing_row_limit"
                    }
                };
            }
        }

        try {
            const requestIdValue = requestId || crypto.randomUUID();
            const cacheKey = getCacheKey(sql, parameters, effectiveDatabaseId);
            const cached = readCache(cacheKey, cacheTtlSeconds);
            if (cached) {
                return {
                    content: [{
                        type: "text",
                        text: cached.responseText + '\n\n(Cache hit)'
                    }],
                    result: {
                        ...cached.result,
                        metadata: {
                            ...cached.result.metadata,
                            requestId: requestIdValue,
                            cacheHit: true
                        }
                    }
                };
            }

            // Extract potential table names from query for validation
            const lowerSql = sql.toLowerCase();
            const tableNameRegex = /\bfrom\s+(\[?[\w_.]+\]?)/gi;
            const matches = [...lowerSql.matchAll(tableNameRegex)];

            // Variables for tracking
            let totalCount = null;

            if (maxEstimatedRows) {
                try {
                    let countSql = sql;
                    countSql = countSql.replace(/\s+ORDER\s+BY\s+.+?(?:(?:OFFSET|FETCH|$))/i, ' ');
                    countSql = countSql.replace(/\s+OFFSET\s+.+?(?:FETCH|$)/i, ' ');
                    countSql = countSql.replace(/\s+FETCH\s+.+?$/i, ' ');
                    countSql = `SELECT COUNT(*) AS TotalCount FROM (${countSql}) AS CountQuery`;

                    const countResult = await executeQuery(countSql, parameters, 3, effectiveDatabaseId, timeoutMs);
                    if (countResult.recordset?.length > 0) {
                        totalCount = countResult.recordset[0].TotalCount;
                        if (totalCount > maxEstimatedRows) {
                            return {
                                content: [{
                                    type: "text",
                                    text: `Estimated row count ${totalCount} exceeds maxEstimatedRows (${maxEstimatedRows}).`
                                }],
                                isError: true,
                                result: {
                                    errorCode: "max_estimated_rows_exceeded",
                                    totalCount,
                                    maxEstimatedRows
                                }
                            };
                        }
                    }
                } catch (err) {
                    logger.warn(`Failed to estimate row count: ${err.message}`);
                }
            }

            // Execute the query
            logger.info(`Executing SQL: ${sql}`);
            const startTime = Date.now();
            const result = await executeQuery(sql, parameters, 3, effectiveDatabaseId, timeoutMs, dryRun);
            const executionTime = Date.now() - startTime;
            const rowCount = result.recordset?.length || 0;
            logger.info(`SQL executed successfully in ${executionTime}ms, returned ${rowCount} rows`);
            if (executionTime > SLOW_QUERY_MS) {
                logger.warn(`Slow query (${executionTime}ms) requestId=${requestIdValue}`);
            }

            // Format response for display
            let responseText = '';

            if (dryRun) {
                responseText = `Dry run completed in ${executionTime}ms. Execution plan returned.`;
            } else if (rowCount === 0) {
                responseText = "Query executed successfully, but returned no rows.";
            } else {
                // Basic result summary
                responseText = `Query executed successfully in ${executionTime}ms and returned ${rowCount} rows.`;

                responseText += '\n\n';

                // Add sample of column names
                if (result.recordset && result.recordset.length > 0) {
                    responseText += `Columns: ${Object.keys(result.recordset[0]).join(', ')}\n\n`;

                    // If returnResults is true, include the actual data in the response
                    if (returnResults) {
                        responseText += `Data:\n`;

                        // Create a formatted table of results
                        const columns = Object.keys(result.recordset[0]);
                        const maxRowsToShow = Math.min(rowCount, maxRows);

                        // Header row
                        responseText += columns.join(' | ') + '\n';
                        responseText += columns.map(() => '---').join(' | ') + '\n';

                        // Data rows
                        for (let i = 0; i < maxRowsToShow; i++) {
                            const row = result.recordset[i];
                            const rowValues = columns.map(col => {
                                const value = row[col];
                                return value === null ? 'NULL' : String(value);
                            });
                            responseText += rowValues.join(' | ') + '\n';
                        }

                        if (rowCount > maxRows) {
                            responseText += `\n... (showing first ${maxRows} of ${rowCount} rows)\n`;
                        }
                    }
                }
            }

            let outputPath = null;
            if (outputFile) {
                const resolvedOutput = resolveOutputPath(outputFile, outputFormat);
                if (resolvedOutput?.error) {
                    return {
                        content: [{
                            type: "text",
                            text: `Error writing output file: ${resolvedOutput.error}`
                        }],
                        isError: true
                    };
                }

                outputPath = resolvedOutput.path;
                if (compressOutput && !outputPath.endsWith('.gz')) {
                    outputPath = `${outputPath}.gz`;
                }
                try {
                    if (outputFormat === 'csv') {
                        if (rowCount === 0) {
                            const emptyBuffer = Buffer.from('');
                            fs.writeFileSync(outputPath, compressOutput ? zlib.gzipSync(emptyBuffer) : emptyBuffer);
                        } else {
                            const columns = Object.keys(result.recordset[0]);
                            const lines = [];
                            if (csvIncludeHeaders) {
                                lines.push(columns.join(csvDelimiter));
                            }

                            result.recordset.forEach(row => {
                                const line = columns.map(col => {
                                    const value = row[col];
                                    if (value === null || value === undefined) return '';
                                    if (typeof value === 'string') return `${csvQuoteChar}${value.replace(/"/g, '""')}${csvQuoteChar}`;
                                    if (typeof value === 'object') return `${csvQuoteChar}${JSON.stringify(value).replace(/"/g, '""')}${csvQuoteChar}`;
                                    return String(value);
                                }).join(csvDelimiter);
                                lines.push(line);
                            });

                            const csvBuffer = Buffer.from(lines.join('\n'));
                            fs.writeFileSync(outputPath, compressOutput ? zlib.gzipSync(csvBuffer) : csvBuffer);
                        }
                    } else {
                        const resultWithMetadata = {
                            metadata: {
                                timestamp: new Date().toISOString(),
                                query: sql,
                                parameters: Object.keys(parameters).length > 0 ? parameters : undefined,
                                rowCount,
                                executionTimeMs: executionTime
                            },
                            results: result.recordset || []
                        };
                        const jsonBuffer = Buffer.from(JSON.stringify(resultWithMetadata, null, 2));
                        fs.writeFileSync(outputPath, compressOutput ? zlib.gzipSync(jsonBuffer) : jsonBuffer);
                    }

                    logger.info(`Query results written to ${outputPath}`);
                } catch (writeError) {
                    logger.error(`Error writing output file: ${writeError.message}`);
                    return {
                        content: [{
                            type: "text",
                            text: `Error writing output file: ${writeError.message}`
                        }],
                        isError: true
                    };
                }
            }

            // Generate UUID for tracking
            const uuid = crypto.randomUUID();

            // Return both the text response AND the actual data in MCP format
            const response = {
                content: [{
                    type: "text",
                    text: outputPath
                        ? `${responseText}\n\n📄 Output written to: ${outputPath}`
                        : responseText
                }],
                result: {
                    rowCount: rowCount,
                    results: result.recordset || [],
                    metadata: {
                        uuid: uuid,
                        pagination: null,
                        totalCount: totalCount,
                        executionTimeMs: executionTime,
                        outputPath,
                        requestId: requestIdValue,
                        cacheHit: false,
                        dryRun,
                        operationType,
                        isLocal
                    }
                }
            };

            if (cacheTtlSeconds) {
                writeCache(cacheKey, { responseText, result: response.result });
            }

            return response;
        } catch (err) {
            logger.error(`SQL execution failed: ${err.message}`);

            const retryableCodes = ['ETIMEOUT', 'ECONNCLOSED', 'ECONNRESET', 'ESOCKET'];
            const isTimeout = err.message && err.message.toLowerCase().includes('timeout');
            const retryable = isTimeout || (err.code && retryableCodes.includes(err.code));
            const errorCode = isTimeout ? 'query_timeout' : 'query_failed';

            return {
                content: [{
                    type: "text",
                    text: `Error executing query: ${formatSqlError(err)}${retryable ? ' (retryable)' : ''}`
                }],
                isError: true,
                result: {
                    errorCode,
                    retryable
                }
            };
        }
    };

    if (registerWithAllAliases) {
        registerWithAllAliases("execute_query", schema, handler);
    } else {
        server.tool("execute_query", schema, handler);
    }
}

/**
 * Register the table-details tool
 * @param {object} server - MCP server instance
 * @param {function} registerWithAllAliases - Helper to register with all name variants
 */
function registerTableDetailsTool(server, registerWithAllAliases) {
    const schema = {
        tableName: z.string().min(1, "Table name cannot be empty"),
        databaseId: z.string().optional()
    };

    const handler = async ({ tableName, databaseId }) => {
        try {
            // Parse schema and table name
            let schemaName = 'dbo'; // Default schema
            let tableNameOnly = tableName;

            // Handle schema-qualified table names (schema.table)
            if (tableName.includes('.')) {
                const parts = tableName.split('.');
                schemaName = parts[0].replace(/[\[\]]/g, ''); // Remove any brackets
                tableNameOnly = parts[1].replace(/[\[\]]/g, ''); // Remove any brackets
            }

            // Sanitize table name components
            const sanitizedSchema = sanitizeSqlIdentifier(schemaName);
            const sanitizedTable = sanitizeSqlIdentifier(tableNameOnly);

            // Check if the sanitization changed anything
            if (sanitizedSchema !== schemaName || sanitizedTable !== tableNameOnly) {
                return {
                    content: [{
                        type: "text",
                        text: `Invalid table name components: ${tableName}. Table and schema names should only contain alphanumeric characters and underscores.`
                    }],
                    isError: true
                };
            }

            // Query for table details with schema qualification
            const result = await executeQuery(`
                    SELECT 
                        COLUMN_NAME,
                        DATA_TYPE,
                        CHARACTER_MAXIMUM_LENGTH,
                        IS_NULLABLE,
                        COLUMN_DEFAULT
                    FROM 
                        INFORMATION_SCHEMA.COLUMNS
                    WHERE 
                    TABLE_SCHEMA = @schemaName AND
                        TABLE_NAME = @tableName
                    ORDER BY 
                        ORDINAL_POSITION
            `, {
                schemaName: sanitizedSchema,
                tableName: sanitizedTable
            }, 3, databaseId);

            if (result.recordset.length === 0) {
                return {
                    content: [{
                        type: "text",
                        text: `Table '${sanitizedSchema}.${sanitizedTable}' not found.`
                    }],
                    isError: true
                };
            }

            // Format response as markdown table
            let markdown = `# Table: ${sanitizedSchema}.${sanitizedTable}\n\n`;
            markdown += `## Columns\n\n`;
            markdown += `| Column Name | Data Type | Max Length | Nullable | Default |\n`;
            markdown += `|-------------|-----------|------------|----------|----------|\n`;

            result.recordset.forEach(column => {
                markdown += `| ${column.COLUMN_NAME} | ${column.DATA_TYPE} | ${column.CHARACTER_MAXIMUM_LENGTH || 'N/A'} | ${column.IS_NULLABLE} | ${column.COLUMN_DEFAULT || 'NULL'} |\n`;
            });

            // Return both the formatted markdown and the structured data
            return {
                content: [{
                    type: "text",
                    text: markdown
                }],
                result: {
                    columns: result.recordset || [],
                    metadata: {
                        rowCount: result.recordset.length,
                        tableName: `${sanitizedSchema}.${sanitizedTable}`
                    }
                }
            };
        } catch (err) {
            logger.error(`Error getting table details: ${err.message}`);

            return {
                content: [{
                    type: "text",
                    text: `Error getting table details: ${formatSqlError(err)}`
                }],
                isError: true
            };
        }
    };

    if (registerWithAllAliases) {
        registerWithAllAliases("table_details", schema, handler);
    } else {
        server.tool("table_details", schema, handler);
    }
}

/**
 * Register the procedure-details tool
 * @param {object} server - MCP server instance
 * @param {function} registerWithAlias - Optional helper to register with aliases
 */
function registerProcedureDetailsTool(server, registerWithAlias) {
    const handler = async ({ procedureName, databaseId }) => {
        try {
            // Sanitize procedure name
            const sanitizedProcName = sanitizeSqlIdentifier(procedureName);

            if (sanitizedProcName !== procedureName) {
                return {
                    content: [{
                        type: "text",
                        text: `Invalid procedure name: ${procedureName}. Procedure names should only contain alphanumeric characters and underscores.`
                    }],
                    isError: true
                };
            }

            const result = await executeQuery(`
                    SELECT 
                        ROUTINE_DEFINITION
                    FROM 
                        INFORMATION_SCHEMA.ROUTINES
                    WHERE 
                        ROUTINE_TYPE = 'PROCEDURE' AND
                        ROUTINE_NAME = @procedureName
                `, { procedureName: sanitizedProcName }, 3, databaseId);

            if (result.recordset.length === 0) {
                return {
                    content: [{
                        type: "text",
                        text: `Stored procedure '${sanitizedProcName}' not found.`
                    }],
                    isError: true
                };
            }

            // Get parameters
            const paramResult = await executeQuery(`
                    SELECT 
                        PARAMETER_NAME,
                        DATA_TYPE,
                        PARAMETER_MODE
                    FROM 
                        INFORMATION_SCHEMA.PARAMETERS
                    WHERE 
                        SPECIFIC_NAME = @procedureName
                    ORDER BY 
                        ORDINAL_POSITION
                `, { procedureName: sanitizedProcName }, 3, databaseId);

            let markdown = `# Stored Procedure: ${sanitizedProcName}\n\n`;

            if (paramResult.recordset.length > 0) {
                markdown += '## Parameters\n\n';
                markdown += '| Name | Type | Mode |\n';
                markdown += '|------|------|------|\n';

                paramResult.recordset.forEach(param => {
                    markdown += `| ${param.PARAMETER_NAME} | ${param.DATA_TYPE} | ${param.PARAMETER_MODE} |\n`;
                });

                markdown += '\n';
            }

            markdown += '## Definition\n\n';
            markdown += '```sql\n';
            markdown += result.recordset[0].ROUTINE_DEFINITION || 'Definition not available';
            markdown += '\n```\n';

            return {
                content: [{
                    type: "text",
                    text: markdown
                }],
                result: {
                    procedureName: sanitizedProcName,
                    parameters: paramResult.recordset || [],
                    definition: result.recordset[0].ROUTINE_DEFINITION || 'Definition not available'
                }
            };
        } catch (err) {
            logger.error(`Error getting procedure details: ${err.message}`);

            return {
                content: [{
                    type: "text",
                    text: `Error getting procedure details: ${formatSqlError(err)}`
                }],
                isError: true
            };
        }
    };

    const schema = {
        procedureName: z.string().min(1, "Procedure name cannot be empty"),
        databaseId: z.string().optional()
    };

    if (registerWithAlias) {
        registerWithAlias("procedure_details", schema, handler);
    } else {
        server.tool("mcp_procedure_details", schema, handler);
    }
}

/**
 * Register the function-details tool
 * @param {object} server - MCP server instance 
 * @param {function} registerWithAlias - Optional helper to register with aliases
 */
function registerFunctionDetailsTool(server, registerWithAlias) {
    const handler = async ({ functionName }) => {
        try {
            // Sanitize function name
            const sanitizedFuncName = sanitizeSqlIdentifier(functionName);

            if (sanitizedFuncName !== functionName) {
                return {
                    content: [{
                        type: "text",
                        text: `Invalid function name: ${functionName}. Function names should only contain alphanumeric characters and underscores.`
                    }],
                    isError: true
                };
            }

            const result = await executeQuery(`
                    SELECT 
                        ROUTINE_DEFINITION,
                        DATA_TYPE AS RETURN_TYPE
                    FROM 
                        INFORMATION_SCHEMA.ROUTINES
                    WHERE 
                        ROUTINE_TYPE = 'FUNCTION' AND
                        ROUTINE_NAME = @functionName
                `, { functionName: sanitizedFuncName });

            if (result.recordset.length === 0) {
                return {
                    content: [{
                        type: "text",
                        text: `Function '${sanitizedFuncName}' not found.`
                    }],
                    isError: true
                };
            }

            // Get parameters
            const paramResult = await executeQuery(`
                    SELECT 
                        PARAMETER_NAME,
                        DATA_TYPE,
                        PARAMETER_MODE
                    FROM 
                        INFORMATION_SCHEMA.PARAMETERS
                    WHERE 
                        SPECIFIC_NAME = @functionName
                    ORDER BY 
                        ORDINAL_POSITION
                `, { functionName: sanitizedFuncName });

            let markdown = `# Function: ${sanitizedFuncName}\n\n`;

            // Add return type
            markdown += `**Return Type**: ${result.recordset[0].RETURN_TYPE || 'Unknown'}\n\n`;

            if (paramResult.recordset.length > 0) {
                markdown += '## Parameters\n\n';
                markdown += '| Name | Type | Mode |\n';
                markdown += '|------|------|------|\n';

                paramResult.recordset.forEach(param => {
                    markdown += `| ${param.PARAMETER_NAME} | ${param.DATA_TYPE} | ${param.PARAMETER_MODE} |\n`;
                });

                markdown += '\n';
            }

            markdown += '## Definition\n\n';
            markdown += '```sql\n';
            markdown += result.recordset[0].ROUTINE_DEFINITION || 'Definition not available';
            markdown += '\n```\n';

            // Add usage example
            markdown += '\n## Usage Example\n\n';
            markdown += '```sql\n';

            // Simple scalar function example
            if (paramResult.recordset.length === 0) {
                markdown += `-- Call scalar function\n`;
                markdown += `SELECT dbo.${sanitizedFuncName}() AS Result\n`;
            } else {
                markdown += `-- Call function with parameters\n`;
                markdown += `SELECT dbo.${sanitizedFuncName}(${paramResult.recordset.map(() => '?').join(', ')}) AS Result\n`;
            }

            markdown += '```\n';

            return {
                content: [{
                    type: "text",
                    text: markdown
                }],
                result: {
                    functionName: sanitizedFuncName,
                    returnType: result.recordset[0].RETURN_TYPE || 'Unknown',
                    parameters: paramResult.recordset || [],
                    definition: result.recordset[0].ROUTINE_DEFINITION || 'Definition not available'
                }
            };
        } catch (err) {
            logger.error(`Error getting function details: ${err.message}`);

            return {
                content: [{
                    type: "text",
                    text: `Error getting function details: ${formatSqlError(err)}`
                }],
                isError: true
            };
        }
    };

    const schema = {
        functionName: z.string().min(1, "Function name cannot be empty")
    };

    if (registerWithAlias) {
        registerWithAlias("function_details", schema, handler);
    } else {
        server.tool("mcp_function_details", schema, handler);
    }
}

/**
 * Register the view-details tool
 * @param {object} server - MCP server instance
 * @param {function} registerWithAlias - Optional helper to register with aliases
 */
function registerViewDetailsTool(server, registerWithAlias) {
    const handler = async ({ viewName }) => {
        try {
            // Sanitize view name
            const sanitizedViewName = sanitizeSqlIdentifier(viewName);

            if (sanitizedViewName !== viewName) {
                return {
                    content: [{
                        type: "text",
                        text: `Invalid view name: ${viewName}. View names should only contain alphanumeric characters and underscores.`
                    }],
                    isError: true
                };
            }

            const result = await executeQuery(`
                    SELECT 
                        VIEW_DEFINITION
                    FROM 
                        INFORMATION_SCHEMA.VIEWS
                    WHERE 
                        TABLE_NAME = @viewName
                `, { viewName: sanitizedViewName });

            if (result.recordset.length === 0) {
                return {
                    content: [{
                        type: "text",
                        text: `View '${sanitizedViewName}' not found.`
                    }],
                    isError: true
                };
            }

            // Get columns
            const columnResult = await executeQuery(`
                    SELECT 
                        COLUMN_NAME,
                        DATA_TYPE,
                        IS_NULLABLE
                    FROM 
                        INFORMATION_SCHEMA.COLUMNS
                    WHERE 
                        TABLE_NAME = @viewName
                    ORDER BY 
                        ORDINAL_POSITION
                `, { viewName: sanitizedViewName });

            let markdown = `# View: ${sanitizedViewName}\n\n`;

            if (columnResult.recordset.length > 0) {
                markdown += '## Columns\n\n';
                markdown += '| Name | Type | Nullable |\n';
                markdown += '|------|------|----------|\n';

                columnResult.recordset.forEach(col => {
                    markdown += `| ${col.COLUMN_NAME} | ${col.DATA_TYPE} | ${col.IS_NULLABLE} |\n`;
                });

                markdown += '\n';
            }

            markdown += '## Definition\n\n';
            markdown += '```sql\n';
            markdown += result.recordset[0].VIEW_DEFINITION || 'Definition not available';
            markdown += '\n```\n';

            // Add usage example
            markdown += '\n## Usage Example\n\n';
            markdown += '```sql\n';
            markdown += `-- Query the view\n`;
            markdown += `SELECT TOP 100 * FROM [${sanitizedViewName}]\n`;
            markdown += '```\n';

            return {
                content: [{
                    type: "text",
                    text: markdown
                }],
                result: {
                    viewName: sanitizedViewName,
                    columns: columnResult.recordset || [],
                    definition: result.recordset[0].VIEW_DEFINITION || 'Definition not available'
                }
            };
        } catch (err) {
            logger.error(`Error getting view details: ${err.message}`);

            return {
                content: [{
                    type: "text",
                    text: `Error getting view details: ${formatSqlError(err)}`
                }],
                isError: true
            };
        }
    };

    const schema = {
        viewName: z.string().min(1, "View name cannot be empty")
    };

    if (registerWithAlias) {
        registerWithAlias("view_details", schema, handler);
    } else {
        server.tool("mcp_view_details", schema, handler);
    }
}

/**
 * Register the index-details tool
 * @param {object} server - MCP server instance
 * @param {function} registerWithAlias - Optional helper to register with aliases
 */
function registerIndexDetailsTool(server, registerWithAlias) {
    const handler = async ({ tableName, indexName }) => {
        try {
            // Sanitize names
            const sanitizedTableName = sanitizeSqlIdentifier(tableName);
            const sanitizedIndexName = sanitizeSqlIdentifier(indexName);

            if (sanitizedTableName !== tableName || sanitizedIndexName !== indexName) {
                return {
                    content: [{
                        type: "text",
                        text: `Invalid table or index name. Names should only contain alphanumeric characters and underscores.`
                    }],
                    isError: true
                };
            }

            const result = await executeQuery(`
                    SELECT 
                        i.name AS IndexName,
                        i.type_desc AS IndexType,
                        i.is_unique AS IsUnique,
                        i.is_primary_key AS IsPrimaryKey,
                        i.is_unique_constraint AS IsUniqueConstraint,
                        c.name AS ColumnName,
                        ic.is_descending_key AS IsDescending,
                        ic.is_included_column AS IsIncluded
                    FROM 
                        sys.indexes i
                    INNER JOIN 
                        sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                    INNER JOIN 
                        sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
                    INNER JOIN 
                        sys.tables t ON i.object_id = t.object_id
                    WHERE 
                        t.name = @tableName AND
                        i.name = @indexName
                    ORDER BY 
                        ic.key_ordinal
                `, {
                tableName: sanitizedTableName,
                indexName: sanitizedIndexName
            });

            if (result.recordset.length === 0) {
                return {
                    content: [{
                        type: "text",
                        text: `Index '${sanitizedIndexName}' on table '${sanitizedTableName}' not found.`
                    }],
                    isError: true
                };
            }

            let markdown = `# Index: ${sanitizedIndexName}\n\n`;
            markdown += `**Table**: ${sanitizedTableName}\n\n`;
            markdown += `**Type**: ${result.recordset[0].IndexType}\n\n`;
            markdown += `**Unique**: ${result.recordset[0].IsUnique ? 'Yes' : 'No'}\n\n`;
            markdown += `**Primary Key**: ${result.recordset[0].IsPrimaryKey ? 'Yes' : 'No'}\n\n`;
            markdown += `**Unique Constraint**: ${result.recordset[0].IsUniqueConstraint ? 'Yes' : 'No'}\n\n`;

            // Split into key columns and included columns
            const keyColumns = result.recordset.filter(r => !r.IsIncluded);
            const includedColumns = result.recordset.filter(r => r.IsIncluded);

            markdown += '## Key Columns\n\n';
            markdown += '| Column | Sort Direction |\n';
            markdown += '|--------|---------------|\n';

            keyColumns.forEach(col => {
                markdown += `| ${col.ColumnName} | ${col.IsDescending ? 'Descending' : 'Ascending'} |\n`;
            });

            if (includedColumns.length > 0) {
                markdown += '\n## Included Columns\n\n';
                markdown += '| Column |\n';
                markdown += '|--------|\n';

                includedColumns.forEach(col => {
                    markdown += `| ${col.ColumnName} |\n`;
                });
            }

            // Add index usage query example
            markdown += '\n## Index Usage Query\n\n';
            markdown += '```sql\n';
            markdown += `-- Get index usage statistics\n`;
            markdown += `SELECT\n`;
            markdown += `    s.name AS SchemaName,\n`;
            markdown += `    t.name AS TableName,\n`;
            markdown += `    i.name AS IndexName,\n`;
            markdown += `    ius.user_seeks AS Seeks,\n`;
            markdown += `    ius.user_scans AS Scans,\n`;
            markdown += `    ius.user_lookups AS Lookups,\n`;
            markdown += `    ius.user_updates AS Updates,\n`;
            markdown += `    ius.last_user_seek AS LastSeek,\n`;
            markdown += `    ius.last_user_scan AS LastScan,\n`;
            markdown += `    ius.last_user_lookup AS LastLookup,\n`;
            markdown += `    ius.last_user_update AS LastUpdate\n`;
            markdown += `FROM\n`;
            markdown += `    sys.indexes i\n`;
            markdown += `INNER JOIN\n`;
            markdown += `    sys.tables t ON i.object_id = t.object_id\n`;
            markdown += `INNER JOIN\n`;
            markdown += `    sys.schemas s ON t.schema_id = s.schema_id\n`;
            markdown += `LEFT JOIN\n`;
            markdown += `    sys.dm_db_index_usage_stats ius ON i.object_id = ius.object_id AND i.index_id = ius.index_id\n`;
            markdown += `WHERE\n`;
            markdown += `    t.name = '${sanitizedTableName}'\n`;
            markdown += `    AND i.name = '${sanitizedIndexName}'\n`;
            markdown += '```\n';

            return {
                content: [{
                    type: "text",
                    text: markdown
                }],
                result: {
                    tableName: sanitizedTableName,
                    indexName: sanitizedIndexName,
                    type: result.recordset[0].IndexType,
                    isUnique: result.recordset[0].IsUnique,
                    isPrimaryKey: result.recordset[0].IsPrimaryKey,
                    isUniqueConstraint: result.recordset[0].IsUniqueConstraint,
                    keyColumns: keyColumns.map(col => col.ColumnName),
                    includedColumns: includedColumns.map(col => col.ColumnName)
                }
            };
        } catch (err) {
            logger.error(`Error getting index details: ${err.message}`);

            return {
                content: [{
                    type: "text",
                    text: `Error getting index details: ${formatSqlError(err)}`
                }],
                isError: true
            };
        }
    };

    const schema = {
        tableName: z.string().min(1, "Table name cannot be empty"),
        indexName: z.string().min(1, "Index name cannot be empty")
    };

    if (registerWithAlias) {
        registerWithAlias("index_details", schema, handler);
    } else {
        server.tool("mcp_index_details", schema, handler);
    }
}

/**
 * Register the discover-tables tool
 * @param {object} server - MCP server instance 
 * @param {function} registerWithAlias - Optional helper to register with aliases
 */
function registerDiscoverTablesTool(server, registerWithAlias) {
    const handler = async ({ namePattern = '%', limit = 100, includeRowCounts = false }) => {
        try {
            // Sanitize name pattern - at least allow wildcards
            const sanitizedPattern = namePattern.replace(/[^a-zA-Z0-9_%]/g, '');

            // Build query based on parameters
            let query = `
                    SELECT TOP ${limit}
                        TABLE_SCHEMA,
                        TABLE_NAME,
                        TABLE_TYPE
                    FROM 
                        INFORMATION_SCHEMA.TABLES
                    WHERE 
                        TABLE_TYPE = 'BASE TABLE'
                `;

            // Add name pattern filter if provided and not the default wildcard
            if (sanitizedPattern !== '%') {
                query += ` AND TABLE_NAME LIKE @namePattern`;
            }

            // Add order
            query += ` ORDER BY TABLE_SCHEMA, TABLE_NAME`;

            const result = await executeQuery(query, { namePattern: sanitizedPattern });

            if (result.recordset.length === 0) {
                return {
                    content: [{
                        type: "text",
                        text: `No tables found${sanitizedPattern !== '%' ? ` matching pattern '${sanitizedPattern}'` : ''}.`
                    }]
                };
            }

            // Format results as markdown
            let markdown = `# Database Tables${sanitizedPattern !== '%' ? ` Matching '${sanitizedPattern}'` : ''}\n\n`;
            markdown += `Found ${result.recordset.length} tables.\n\n`;

            // If row counts are requested, get them for each table
            let tableWithRowCounts = [];

            if (includeRowCounts) {
                // For large number of tables, row counts could be expensive
                // Limit to first 20 tables
                const tablesToCount = result.recordset.slice(0, 20);

                for (const table of tablesToCount) {
                    try {
                        const countResult = await executeQuery(`
                                SELECT 
                                    SUM(p.rows) AS [RowCount]
                                FROM 
                                    sys.partitions p
                                INNER JOIN 
                                    sys.tables t ON p.object_id = t.object_id
                                INNER JOIN 
                                    sys.schemas s ON t.schema_id = s.schema_id
                                WHERE 
                                    s.name = @schemaName
                                    AND t.name = @tableName
                                    AND p.index_id IN (0, 1)
                            `, {
                            schemaName: table.TABLE_SCHEMA,
                            tableName: table.TABLE_NAME
                        });

                        tableWithRowCounts.push({
                            ...table,
                            RowCount: countResult.recordset[0].RowCount || 0
                        });
                    } catch (err) {
                        logger.warn(`Error getting row count for ${table.TABLE_SCHEMA}.${table.TABLE_NAME}: ${err.message}`);
                        tableWithRowCounts.push({
                            ...table,
                            RowCount: 'Error'
                        });
                    }
                }

                // Add the remaining tables without row counts if any
                if (result.recordset.length > 20) {
                    for (let i = 20; i < result.recordset.length; i++) {
                        tableWithRowCounts.push({
                            ...result.recordset[i],
                            RowCount: 'Not calculated'
                        });
                    }
                }

                // Create table with row counts
                markdown += '| Schema | Table Name | Row Count |\n';
                markdown += '|--------|------------|----------|\n';

                tableWithRowCounts.forEach(table => {
                    markdown += `| ${table.TABLE_SCHEMA} | ${table.TABLE_NAME} | ${table.RowCount} |\n`;
                });
            } else {
                // Just schema and table name
                markdown += '| Schema | Table Name |\n';
                markdown += '|--------|------------|\n';

                result.recordset.forEach(table => {
                    markdown += `| ${table.TABLE_SCHEMA} | ${table.TABLE_NAME} |\n`;
                });
            }

            markdown += '\n## Next Steps\n\n';
            markdown += '1. To view a table\'s structure, use:\n';
            markdown += '```javascript\n';
            markdown += `mcp__table_details({ tableName: "${result.recordset[0].TABLE_NAME}" })\n`;
            markdown += '```\n\n';

            markdown += '2. To query a table, use:\n';
            markdown += '```javascript\n';
            markdown += `mcp__execute_query({ sql: "SELECT TOP 100 * FROM [${result.recordset[0].TABLE_SCHEMA}].[${result.recordset[0].TABLE_NAME}]" })\n`;
            markdown += '```\n\n';

            if (sanitizedPattern === '%') {
                markdown += '3. To find tables by name pattern, use:\n';
                markdown += '```javascript\n';
                markdown += `mcp__discover_tables({ namePattern: "%search_term%" })\n`;
                markdown += '```\n\n';
            }

            if (!includeRowCounts) {
                markdown += '4. To include row counts (may be slower for many tables):\n';
                markdown += '```javascript\n';
                markdown += `mcp__discover_tables({ namePattern: "${sanitizedPattern}", includeRowCounts: true })\n`;
                markdown += '```\n';
            }

            return {
                content: [{
                    type: "text",
                    text: markdown
                }],
                result: {
                    tables: result.recordset || [],
                    rowCounts: tableWithRowCounts
                }
            };
        } catch (err) {
            logger.error(`Error discovering tables: ${err.message}`);

            return {
                content: [{
                    type: "text",
                    text: `Error discovering tables: ${formatSqlError(err)}`
                }],
                isError: true
            };
        }
    };

    const schema = {
        namePattern: z.string().optional().default('%'),
        limit: z.number().min(1).max(1000).optional().default(100),
        includeRowCounts: z.boolean().optional().default(false)
    };

    if (registerWithAlias) {
        registerWithAlias("discover_tables", schema, handler);
    } else {
        server.tool("mcp_discover_tables", schema, handler);
    }
}

/**
 * Register the discover-database tool
 * @param {object} server - MCP server instance
 * @param {function} registerWithAlias - Optional helper to register with aliases
 */
function registerDiscoverDatabaseTool(server, registerWithAlias) {
    const handler = async ({ type = 'all', limit = 100 }) => {
        try {
            let markdown = `# SQL Server Database Discovery\n\n`;

            // Declare result variables at the top to avoid undefined errors
            let tablesResult, viewsResult, procsResult, funcsResult;

            // Discover tables
            if (type === 'tables' || type === 'all') {
                const tablesQuery = `
                        SELECT TOP ${limit}
                            TABLE_SCHEMA,
                            TABLE_NAME
                        FROM 
                            INFORMATION_SCHEMA.TABLES
                        WHERE 
                            TABLE_TYPE = 'BASE TABLE'
                        ORDER BY 
                            TABLE_SCHEMA, TABLE_NAME
                    `;

                tablesResult = await executeQuery(tablesQuery);

                markdown += `## Tables (${tablesResult.recordset.length})\n\n`;

                if (tablesResult.recordset.length > 0) {
                    markdown += '| Schema | Table Name |\n';
                    markdown += '|--------|------------|\n';

                    tablesResult.recordset.forEach(table => {
                        markdown += `| ${table.TABLE_SCHEMA} | ${table.TABLE_NAME} |\n`;
                    });

                    markdown += '\n### Example Query:\n';
                    markdown += '```sql\n';
                    markdown += `-- Get sample data from a table\n`;
                    markdown += `SELECT TOP 100 * FROM [${tablesResult.recordset[0].TABLE_SCHEMA}].[${tablesResult.recordset[0].TABLE_NAME}]\n`;
                    markdown += '```\n\n';
                } else {
                    markdown += 'No tables found.\n\n';
                }
            }

            // Discover views
            if (type === 'views' || type === 'all') {
                const viewsQuery = `
                        SELECT TOP ${limit}
                            TABLE_SCHEMA,
                            TABLE_NAME
                        FROM 
                            INFORMATION_SCHEMA.VIEWS
                        ORDER BY 
                            TABLE_SCHEMA, TABLE_NAME
                    `;

                viewsResult = await executeQuery(viewsQuery);

                markdown += `## Views (${viewsResult.recordset.length})\n\n`;

                if (viewsResult.recordset.length > 0) {
                    markdown += '| Schema | View Name |\n';
                    markdown += '|--------|----------|\n';

                    viewsResult.recordset.forEach(view => {
                        markdown += `| ${view.TABLE_SCHEMA} | ${view.TABLE_NAME} |\n`;
                    });

                    markdown += '\n### Example Query:\n';
                    markdown += '```sql\n';
                    if (viewsResult.recordset.length > 0) {
                        markdown += `-- Get data from a view\n`;
                        markdown += `SELECT TOP 100 * FROM [${viewsResult.recordset[0].TABLE_SCHEMA}].[${viewsResult.recordset[0].TABLE_NAME}]\n`;
                    }
                    markdown += '```\n\n';
                } else {
                    markdown += 'No views found.\n\n';
                }
            }

            // Discover stored procedures
            if (type === 'procedures' || type === 'all') {
                const procsQuery = `
                        SELECT TOP ${limit}
                            ROUTINE_SCHEMA,
                            ROUTINE_NAME
                        FROM 
                            INFORMATION_SCHEMA.ROUTINES
                        WHERE 
                            ROUTINE_TYPE = 'PROCEDURE'
                        ORDER BY 
                            ROUTINE_SCHEMA, ROUTINE_NAME
                    `;

                procsResult = await executeQuery(procsQuery);

                markdown += `## Stored Procedures (${procsResult.recordset.length})\n\n`;

                if (procsResult.recordset.length > 0) {
                    markdown += '| Schema | Procedure Name |\n';
                    markdown += '|--------|---------------|\n';

                    procsResult.recordset.forEach(proc => {
                        markdown += `| ${proc.ROUTINE_SCHEMA} | ${proc.ROUTINE_NAME} |\n`;
                    });

                    markdown += '\n### Example:\n';
                    markdown += '```sql\n';
                    if (procsResult.recordset.length > 0) {
                        markdown += `-- Get procedure definition\n`;
                        markdown += `EXEC sp_helptext '${procsResult.recordset[0].ROUTINE_SCHEMA}.${procsResult.recordset[0].ROUTINE_NAME}'\n`;
                    }
                    markdown += '```\n\n';
                } else {
                    markdown += 'No stored procedures found.\n\n';
                }
            }

            // Discover functions
            if (type === 'functions' || type === 'all') {
                const funcsQuery = `
                        SELECT TOP ${limit}
                            ROUTINE_SCHEMA,
                            ROUTINE_NAME
                        FROM 
                            INFORMATION_SCHEMA.ROUTINES
                        WHERE 
                            ROUTINE_TYPE = 'FUNCTION'
                        ORDER BY 
                            ROUTINE_SCHEMA, ROUTINE_NAME
                    `;

                funcsResult = await executeQuery(funcsQuery);

                markdown += `## Functions (${funcsResult.recordset.length})\n\n`;

                if (funcsResult.recordset.length > 0) {
                    markdown += '| Schema | Function Name |\n';
                    markdown += '|--------|---------------|\n';

                    funcsResult.recordset.forEach(func => {
                        markdown += `| ${func.ROUTINE_SCHEMA} | ${func.ROUTINE_NAME} |\n`;
                    });

                    markdown += '\n### Example:\n';
                    markdown += '```sql\n';
                    if (funcsResult.recordset.length > 0) {
                        markdown += `-- Get function definition\n`;
                        markdown += `EXEC sp_helptext '${funcsResult.recordset[0].ROUTINE_SCHEMA}.${funcsResult.recordset[0].ROUTINE_NAME}'\n`;
                    }
                    markdown += '```\n\n';
                } else {
                    markdown += 'No functions found.\n\n';
                }
            }

            // Add summary and next steps
            markdown += '## Next Steps\n\n';
            markdown += '1. To query a table:\n';
            markdown += '```javascript\n';
            markdown += 'mcp__execute_query({ sql: "SELECT TOP 100 * FROM [schema].[table_name]" })\n';
            markdown += '```\n\n';

            markdown += '2. To view table structure:\n';
            markdown += '```javascript\n';
            markdown += 'mcp__table_details({ tableName: "table_name" })\n';
            markdown += '```\n\n';

            markdown += '3. To view view details:\n';
            markdown += '```javascript\n';
            markdown += 'mcp__view_details({ viewName: "view_name" })\n';
            markdown += '```\n\n';

            markdown += '4. To view procedure details:\n';
            markdown += '```javascript\n';
            markdown += 'mcp__procedure_details({ procedureName: "procedure_name" })\n';
            markdown += '```\n\n';

            return {
                content: [{
                    type: "text",
                    text: markdown
                }],
                result: {
                    databaseDiscovery: {
                        tables: tablesResult?.recordset || [],
                        views: viewsResult?.recordset || [],
                        procedures: procsResult?.recordset || [],
                        functions: funcsResult?.recordset || []
                    }
                }
            };
        } catch (err) {
            logger.error(`Error discovering database: ${err.message}`);

            return {
                content: [{
                    type: "text",
                    text: `Error discovering database: ${formatSqlError(err)}`
                }],
                isError: true
            };
        }
    };

    const schema = {
        type: z.enum(['tables', 'views', 'procedures', 'functions', 'all']).default('all'),
        limit: z.number().min(1).max(1000).optional().default(100)
    };

    if (registerWithAlias) {
        registerWithAlias("discover_database", schema, handler);
    } else {
        server.tool("mcp_discover_database", schema, handler);
    }
}

/**
 * Register the get-query-results tool
 * @param {object} server - MCP server instance
 * @param {function} registerWithAlias - Optional helper to register with aliases
 */
function registerGetQueryResultsTool(server, registerWithAlias) {
    const handler = async ({ uuid, limit = 10 }) => {
        try {
            // If directory doesn't exist, return empty list
            if (!fs.existsSync(QUERY_RESULTS_PATH)) {
                return {
                    content: [{
                        type: "text",
                        text: "No query results directory found."
                    }]
                };
            }

            // If UUID is provided, return that specific result
            if (uuid) {
                const filepath = path.join(QUERY_RESULTS_PATH, `${uuid}.json`);

                if (!fs.existsSync(filepath)) {
                    return {
                        content: [{
                            type: "text",
                            text: `Query result with UUID ${uuid} not found.`
                        }],
                        isError: true
                    };
                }

                try {
                    // Read the specific result file
                    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));

                    // Format the response
                    let markdown = `# Query Result: ${uuid}\n\n`;
                    markdown += `**Executed**: ${data.metadata.timestamp}\n\n`;
                    markdown += `**Query**: \`\`\`sql\n${data.metadata.query}\n\`\`\`\n\n`;
                    markdown += `**Row Count**: ${data.metadata.rowCount}\n\n`;

                    if (data.metadata.executionTimeMs) {
                        markdown += `**Execution Time**: ${data.metadata.executionTimeMs}ms\n\n`;
                    }

                    if (data.results && data.results.length > 0) {
                        markdown += `## Results Preview\n\n`;

                        // Create markdown table for preview (limited rows)
                        const previewRowCount = Math.min(data.results.length, limit);
                        const previewRows = data.results.slice(0, previewRowCount);

                        // Table headers
                        markdown += '| ' + Object.keys(previewRows[0]).join(' | ') + ' |\n';
                        markdown += '| ' + Object.keys(previewRows[0]).map(() => '---').join(' | ') + ' |\n';

                        // Table rows
                        previewRows.forEach(row => {
                            markdown += '| ' + Object.values(row).map(v => {
                                if (v === null) return 'NULL';
                                if (v === undefined) return '';
                                if (typeof v === 'object') return JSON.stringify(v);
                                return String(v);
                            }).join(' | ') + ' |\n';
                        });

                        if (data.results.length > previewRowCount) {
                            markdown += `\n_Showing first ${previewRowCount} of ${data.results.length} rows_\n`;
                        }
                    }

                    return {
                        content: [{
                            type: "text",
                            text: markdown
                        }],
                        result: {
                            rowCount: data.metadata.rowCount,
                            results: data.results || [],
                            metadata: {
                                uuid: data.metadata.uuid,
                                pagination: null,
                                totalCount: data.metadata.totalCount,
                                executionTimeMs: data.metadata.executionTimeMs
                            }
                        }
                    };
                } catch (err) {
                    logger.error(`Error reading query result: ${err.message}`);

                    return {
                        content: [{
                            type: "text",
                            text: `Error reading query result: ${err.message}`
                        }],
                        isError: true
                    };
                }
            } else {
                // List recent results
                try {
                    // Get all JSON files in the directory
                    const files = fs.readdirSync(QUERY_RESULTS_PATH)
                        .filter(file => file.endsWith('.json'))
                        .map(file => {
                            try {
                                const filepath = path.join(QUERY_RESULTS_PATH, file);
                                const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
                                return {
                                    uuid: data.metadata.uuid,
                                    timestamp: data.metadata.timestamp,
                                    query: data.metadata.query,
                                    rowCount: data.metadata.rowCount,
                                    executionTimeMs: data.metadata.executionTimeMs
                                };
                            } catch (err) {
                                return {
                                    uuid: file.replace('.json', ''),
                                    error: 'Could not read file metadata'
                                };
                            }
                        })
                        // Sort by timestamp (most recent first)
                        .sort((a, b) => {
                            if (!a.timestamp) return 1;
                            if (!b.timestamp) return -1;
                            return new Date(b.timestamp) - new Date(a.timestamp);
                        })
                        // Limit to requested number
                        .slice(0, limit);

                    // Format the response
                    let markdown = `# Recent Query Results\n\n`;

                    if (files.length === 0) {
                        markdown += 'No saved query results found.\n';
                    } else {
                        markdown += '| UUID | Timestamp | Query | Row Count |\n';
                        markdown += '|------|-----------|-------|----------|\n';

                        files.forEach(result => {
                            const queryPreview = result.query ?
                                (result.query.length > 50 ? result.query.substring(0, 50) + '...' : result.query) :
                                'N/A';

                            markdown += `| ${result.uuid} | ${result.timestamp || 'N/A'} | \`${queryPreview}\` | ${result.rowCount || 'N/A'} |\n`;
                        });

                        markdown += `\n## Viewing Specific Results\n\n`;
                        markdown += `To view details for a specific result, use:\n\n`;
                        markdown += `\`\`\`javascript\n`;
                        markdown += `mcp__get_query_results({ uuid: "${files[0].uuid}" })\n`;
                        markdown += `\`\`\`\n`;
                    }

                    return {
                        content: [{
                            type: "text",
                            text: markdown
                        }],
                        result: {
                            recentResults: files.map(result => ({
                                uuid: result.uuid,
                                timestamp: result.timestamp,
                                query: result.query,
                                rowCount: result.rowCount,
                                executionTimeMs: result.executionTimeMs
                            }))
                        }
                    };
                } catch (err) {
                    logger.error(`Error listing query results: ${err.message}`);

                    return {
                        content: [{
                            type: "text",
                            text: `Error listing query results: ${err.message}`
                        }],
                        isError: true
                    };
                }
            }
        } catch (err) {
            logger.error(`Error processing query results: ${err.message}`);

            return {
                content: [{
                    type: "text",
                    text: `Error processing query results: ${err.message}`
                }],
                isError: true
            };
        }
    };

    const schema = {
        uuid: z.string().uuid("Invalid UUID format").optional(),
        limit: z.number().min(1).max(100).optional().default(10)
    };

    if (registerWithAlias) {
        registerWithAlias("get_query_results", schema, handler);
    } else {
        server.tool("mcp_get_query_results", schema, handler);
    }
}

/**
 * Register the discover tool - provides a database overview
 * @param {object} server - MCP server instance
 * @param {function} registerWithAllAliases - Helper to register with all name variants
 */
function registerDiscoverTool(server, registerWithAllAliases) {
    // Define schema with optional random_string parameter (for compatibility)
    const schema = {
        random_string: z.string().optional()
    };

    const handler = async (args) => {
        try {
            // Get tables (limited to 100)
            const tablesResult = await executeQuery(`
                SELECT TOP 100
                        TABLE_SCHEMA,
                    TABLE_NAME,
                    TABLE_TYPE
                    FROM 
                        INFORMATION_SCHEMA.TABLES
                ORDER BY 
                    TABLE_SCHEMA, TABLE_NAME
            `);

            // Get stored procedures (limited to 100)
            const procsResult = await executeQuery(`
                SELECT TOP 100
                    ROUTINE_SCHEMA,
                    ROUTINE_NAME,
                    ROUTINE_TYPE
                FROM 
                    INFORMATION_SCHEMA.ROUTINES
                    WHERE 
                    ROUTINE_TYPE = 'PROCEDURE'
                    ORDER BY
                    ROUTINE_SCHEMA, ROUTINE_NAME
            `);

            // Get functions (limited to 100)
            const funcsResult = await executeQuery(`
                SELECT TOP 100
                    ROUTINE_SCHEMA,
                    ROUTINE_NAME,
                    ROUTINE_TYPE
                FROM 
                    INFORMATION_SCHEMA.ROUTINES
                WHERE 
                    ROUTINE_TYPE = 'FUNCTION'
                ORDER BY 
                    ROUTINE_SCHEMA, ROUTINE_NAME
            `);

            // Get views (actually included in tables with TABLE_TYPE = 'VIEW')
            const viewsResult = await executeQuery(`
                SELECT TOP 100
                    TABLE_SCHEMA,
                        TABLE_NAME
                FROM 
                    INFORMATION_SCHEMA.VIEWS
                ORDER BY 
                    TABLE_SCHEMA, TABLE_NAME
            `);

            // Format the output as markdown
            let markdown = `# Database Overview\n\n`;

            // Tables section
            markdown += `## Tables\n\n`;
            markdown += `| Schema | Table | Type |\n`;
            markdown += `| ------ | ----- | ---- |\n`;

            tablesResult.recordset.forEach(table => {
                markdown += `| ${table.TABLE_SCHEMA} | ${table.TABLE_NAME} | ${table.TABLE_TYPE} |\n`;
            });

            if (tablesResult.recordset.length === 100) {
                markdown += `\n_Showing first 100 tables. There may be more._\n\n`;
            }

            // Stored Procedures section
            markdown += `## Stored Procedures\n\n`;
            markdown += `| Schema | Procedure |\n`;
            markdown += `| ------ | --------- |\n`;

            procsResult.recordset.forEach(proc => {
                markdown += `| ${proc.ROUTINE_SCHEMA} | ${proc.ROUTINE_NAME} |\n`;
            });

            if (procsResult.recordset.length === 100) {
                markdown += `\n_Showing first 100 procedures. There may be more._\n\n`;
            }

            // Functions section
            markdown += `## Functions\n\n`;
            markdown += `| Schema | Function |\n`;
            markdown += `| ------ | -------- |\n`;

            funcsResult.recordset.forEach(func => {
                markdown += `| ${func.ROUTINE_SCHEMA} | ${func.ROUTINE_NAME} |\n`;
            });

            if (funcsResult.recordset.length === 100) {
                markdown += `\n_Showing first 100 functions. There may be more._\n\n`;
            }

            // Views section
            markdown += `## Views\n\n`;
            markdown += `| Schema | View |\n`;
            markdown += `| ------ | ---- |\n`;

            viewsResult.recordset.forEach(view => {
                markdown += `| ${view.TABLE_SCHEMA} | ${view.TABLE_NAME} |\n`;
            });

            if (viewsResult.recordset.length === 100) {
                markdown += `\n_Showing first 100 views. There may be more._\n\n`;
            }

            // Add usage examples
            markdown += `## Usage Examples\n\n`;
            markdown += `### Get Table Details\n`;
            markdown += "```javascript\n";
            markdown += `mcp_table_details({ tableName: "TableName" })\n`;
            markdown += "```\n\n";

            markdown += `### Execute Query\n`;
            markdown += "```javascript\n";
            markdown += `mcp_execute_query({ sql: "SELECT TOP 10 * FROM TableName" })\n`;
            markdown += "```\n\n";

            markdown += `### Get Database Schema\n`;
            markdown += "```javascript\n";
            markdown += `mcp_discover_database()\n`;
            markdown += "```\n";

            // Return the result in MCP format with both content and structured data
            return {
                content: [{
                    type: "text",
                    text: markdown
                }],
                result: {
                    tables: tablesResult.recordset || [],
                    procedures: procsResult.recordset || [],
                    functions: funcsResult.recordset || [],
                    views: viewsResult.recordset || []
                }
            };
        } catch (err) {
            logger.error(`Error in discover tool: ${err.message}`);

            return {
                content: [{
                    type: "text",
                    text: `Error getting database overview: ${formatSqlError(err)}`
                }],
                isError: true
            };
        }
    };

    // Register with all aliases
    if (registerWithAllAliases) {
        registerWithAllAliases("discover", schema, handler);
    } else {
        server.tool("discover", schema, handler);
    }
}

/**
 * Register the cursor-guide tool
 * @param {object} server - MCP server instance
 * @param {function} registerWithAllAliases - Helper to register with all name variants
 */
function registerCursorGuideTool(server, registerWithAllAliases) {
    const cursorGuideSchema = {
        random_string: z.string().optional().describe("Dummy parameter for no-parameter tools")
    };

    const handler = async (args) => {
        // Comprehensive guide for cursor-based pagination
        const guideText = `
# SQL Cursor-Based Pagination Guide

Cursor-based pagination is an efficient approach for paginating through large datasets, especially when:
- You need stable pagination through frequently changing data
- You're handling very large datasets where OFFSET/LIMIT becomes inefficient
- You want better performance for deep pagination

## Key Concepts

1. **Cursor**: A pointer to a specific item in a dataset, typically based on a unique, indexed field
2. **Direction**: You can paginate forward (next) or backward (previous)
3. **Page Size**: The number of items to return per request

## Example Usage

Using cursor-based pagination with our SQL tools:

\`\`\`javascript
// First page (no cursor)
const firstPage = await tool.call("mcp_paginated_query", {
  sql: "SELECT id, name, created_at FROM users ORDER BY created_at DESC",
  pageSize: 20,
  cursorField: "created_at"
});

// Next page (using cursor from previous response)
const nextPage = await tool.call("mcp_paginated_query", {
  sql: "SELECT id, name, created_at FROM users ORDER BY created_at DESC",
  pageSize: 20,
  cursorField: "created_at",
  cursor: firstPage.result.pagination.nextCursor,
  direction: "next"
});

// Previous page (going back)
const prevPage = await tool.call("mcp_paginated_query", {
  sql: "SELECT id, name, created_at FROM users ORDER BY created_at DESC",
  pageSize: 20,
  cursorField: "created_at",
  cursor: nextPage.result.pagination.prevCursor,
  direction: "prev"
});
\`\`\`

## Best Practices

1. **Choose an appropriate cursor field**:
   - Should be unique or nearly unique (ideally indexed)
   - Common choices: timestamps, auto-incrementing IDs
   - Compound cursors can be used for non-unique fields (e.g., "timestamp:id")

2. **Order matters**:
1. Use indexed fields for the cursor field to improve performance
2. Include the ORDER BY clause that matches your cursor field
3. For complex queries, use a subquery to ensure proper ordering`;

        return {
            content: [{
                type: "text",
                text: guideText
            }],
            result: {
                guide: "SQL pagination guide provided successfully"
            }
        };
    };

    if (registerWithAllAliases) {
        registerWithAllAliases("cursor_guide", cursorGuideSchema, handler);
    } else {
        server.tool("cursor_guide", cursorGuideSchema, handler);
        // Register the guide using native server.tool
        server.tool("mcp_cursor_guide", cursorGuideSchema, handler);
    }
}

/**
 * Register the paginated-query tool
 * @param {object} server - MCP server instance
 * @param {function} registerWithAlias - Optional helper to register with aliases
 */
function registerPaginatedQueryTool(server, registerWithAlias) {
    const handler = async ({
        sql,
        cursorField,
        pageSize = 50,
        cursor,
        parameters = {},
        includeCount = true,
        direction = 'next',
        returnTotals = true,
        timeoutMs,
        cacheTtlSeconds,
        requestId,
        maxEstimatedRows,
        compressOutput = false
    }) => {
        // Basic validation to prevent destructive operations
        const lowerSql = sql.toLowerCase();
        const prohibitedOperations = ['drop ', 'delete ', 'truncate ', 'update ', 'alter '];

        if (prohibitedOperations.some(op => lowerSql.includes(op))) {
            return {
                content: [{
                    type: "text",
                    text: "⚠️ Error: Data modification operations (DROP, DELETE, UPDATE, TRUNCATE, ALTER) are not allowed for safety reasons."
                }],
                isError: true
            };
        }

        try {
            const requestIdValue = requestId || crypto.randomUUID();
            const cacheKey = getCacheKey(sql, parameters, getCurrentDatabaseId());
            const cached = readCache(cacheKey, cacheTtlSeconds);
            if (cached) {
                return {
                    content: [{
                        type: "text",
                        text: cached.responseText + '\n\n(Cache hit)'
                    }],
                    result: {
                        ...cached.result,
                        metadata: {
                            ...cached.result.metadata,
                            requestId: requestIdValue,
                            cacheHit: true
                        }
                    }
                };
            }

            // Get total count if requested
            let totalCount = null;
            let estimatedTotalPages = null;
            let currentPage = null;

            if (includeCount) {
                try {
                    // Extract query without ORDER BY, OFFSET, etc. for count query
                    let countSql = sql;

                    // Remove ORDER BY, OFFSET/FETCH clauses for count query
                    countSql = countSql.replace(/\s+ORDER\s+BY\s+.+?(?:(?:OFFSET|FETCH|$))/i, ' ');
                    countSql = countSql.replace(/\s+OFFSET\s+.+?(?:FETCH|$)/i, ' ');
                    countSql = countSql.replace(/\s+FETCH\s+.+?$/i, ' ');

                    // Wrap in a count query
                    countSql = `SELECT COUNT(*) AS TotalCount FROM (${countSql}) AS CountQuery`;

                    logger.info(`Executing count query: ${countSql}`);

                    // Execute count query
                    const countResult = await executeQuery(countSql, parameters, 3, null, timeoutMs);

                    if (countResult.recordset && countResult.recordset.length > 0) {
                        totalCount = countResult.recordset[0].TotalCount;
                        estimatedTotalPages = Math.ceil(totalCount / pageSize);
                        logger.info(`Total count query returned: ${totalCount} rows (${estimatedTotalPages} pages)`);
                        if (maxEstimatedRows && totalCount > maxEstimatedRows) {
                            return {
                                content: [{
                                    type: "text",
                                    text: `Estimated row count ${totalCount} exceeds maxEstimatedRows (${maxEstimatedRows}).`
                                }],
                                isError: true,
                                result: {
                                    errorCode: "max_estimated_rows_exceeded",
                                    totalCount,
                                    maxEstimatedRows
                                }
                            };
                        }
                    }
                } catch (countErr) {
                    logger.warn(`Error executing count query: ${countErr.message}`);
                    // Continue without count if it fails
                }
            }

            // Determine cursor field if not provided
            const defaultCursorField = extractDefaultCursorField(sql);
            const effectiveCursorField = cursorField || defaultCursorField;

            logger.info(`Using cursor field: ${effectiveCursorField}`);

            // Apply pagination transformation
            const { paginatedSql, parameters: paginatedParams } =
                paginateQuery(sql, {
                    cursorField: effectiveCursorField,
                    pageSize,
                    cursor,
                    parameters,
                    defaultCursorField
                });

            logger.info(`Paginated SQL: ${paginatedSql}`);

            // Execute the paginated query
            const result = await executeQuery(paginatedSql, paginatedParams, 3, null, timeoutMs);
            const rowCount = result.recordset?.length || 0;

            // Generate cursors for navigation
            let nextCursor = null;
            let prevCursor = null;

            if (rowCount > 0) {
                // Generate next cursor if we got a full page
                const hasMore = rowCount >= pageSize;
                nextCursor = hasMore
                    ? generateNextCursor(result.recordset[rowCount - 1], effectiveCursorField)
                    : null;

                // Generate previous cursor
                prevCursor = cursor
                    ? generatePrevCursor(result.recordset[0], effectiveCursorField)
                    : null;
            }

            // Generate UUID for the output file
            const uuid = crypto.randomUUID();
            const filename = `${uuid}.json`;
            let filepath = path.join(QUERY_RESULTS_PATH, filename);
            if (compressOutput) {
                filepath = `${filepath}.gz`;
            }

            // Add pagination metadata
            const paginationMeta = {
                cursorField: effectiveCursorField,
                pageSize,
                returnedRows: rowCount,
                hasMore: !!nextCursor,
                nextCursor,
                prevCursor,
                direction,
                totalCount,
                estimatedTotalPages
            };

            // Save results to a JSON file
            if (result.recordset && result.recordset.length > 0) {
                try {
                    const resultWithMetadata = {
                        metadata: {
                            uuid,
                            timestamp: new Date().toISOString(),
                            query: sql,
                            parameters: Object.keys(parameters).length > 0 ? parameters : undefined,
                            rowCount,
                            executionTimeMs: result.executionTime || 0,
                            pagination: paginationMeta
                        },
                        results: result.recordset || []
                    };

                    const jsonBuffer = Buffer.from(JSON.stringify(resultWithMetadata, null, 2));
                    fs.writeFileSync(filepath, compressOutput ? zlib.gzipSync(jsonBuffer) : jsonBuffer);
                    logger.info(`Paginated query results saved to ${filepath}`);
                } catch (writeError) {
                    logger.error(`Error saving query results to file: ${writeError.message}`);
                }
            }

            // Format response markdown
            let markdown = `# Paginated Query Results\n\n`;

            // Add summary stats
            markdown += `Query executed successfully in ${result.executionTime || 0}ms and returned ${rowCount} rows.`;

            if (totalCount !== null && returnTotals) {
                markdown += ` (${totalCount} total rows)`;
            }

            markdown += '\n\n';

            if (totalCount !== null && returnTotals) {
                markdown += `## Pagination Overview\n\n`;
                markdown += `- **Total Records**: ${totalCount}\n`;
                markdown += `- **Page Size**: ${pageSize}\n`;
                markdown += `- **Total Pages**: ${estimatedTotalPages}\n`;
                markdown += `- **Cursor Field**: ${effectiveCursorField}\n\n`;
            }

            // Results preview
            if (rowCount > 0) {
                markdown += `## Results Preview\n\n`;

                // Format as markdown table (limited to 10 rows for preview)
                const previewRows = result.recordset.slice(0, 10);

                // Table headers
                markdown += '| ' + Object.keys(previewRows[0]).join(' | ') + ' |\n';
                markdown += '| ' + Object.keys(previewRows[0]).map(() => '---').join(' | ') + ' |\n';

                // Table rows
                previewRows.forEach(row => {
                    markdown += '| ' + Object.values(row).map(v => {
                        if (v === null) return 'NULL';
                        if (v === undefined) return '';
                        if (typeof v === 'object') return JSON.stringify(v);
                        return String(v);
                    }).join(' | ') + ' |\n';
                });

                if (result.recordset.length > 10) {
                    markdown += `\n_Showing first 10 of ${result.recordset.length} rows._\n\n`;
                }
            } else {
                markdown += `\n**No results returned.**\n\n`;
            }

            // Full results reference
            markdown += `\n📄 Complete results saved with ID: \`${uuid}\`\n\n`;
            markdown += `To view full results:\n`;
            markdown += `\`\`\`javascript\n`;
            markdown += `mcp__get_query_results({ uuid: "${uuid}" })\n`;
            markdown += `\`\`\`\n\n`;

            // Navigation section
            markdown += `## Navigation\n\n`;

            if (nextCursor) {
                markdown += `### Next Page\n\n`;
                markdown += `\`\`\`javascript\n`;
                markdown += `mcp__paginated_query({
  sql: ${JSON.stringify(sql)},
  pageSize: ${pageSize},
  cursorField: "${effectiveCursorField}",
  cursor: "${nextCursor}",
  direction: "next",
  includeCount: ${includeCount},
  returnTotals: ${returnTotals}
})\n`;
                markdown += `\`\`\`\n\n`;
            } else {
                markdown += `**No more results available.**\n\n`;
            }

            if (prevCursor) {
                markdown += `### Previous Page\n\n`;
                markdown += `\`\`\`javascript\n`;
                markdown += `mcp__paginated_query({
  sql: ${JSON.stringify(sql)},
  pageSize: ${pageSize},
  cursorField: "${effectiveCursorField}",
  cursor: "${prevCursor}",
  direction: "prev",
  includeCount: ${includeCount},
  returnTotals: ${returnTotals}
})\n`;
                markdown += `\`\`\`\n\n`;
            }

            // Reset to first page option
            if (cursor) {
                markdown += `### Return to First Page\n\n`;
                markdown += `\`\`\`javascript\n`;
                markdown += `mcp__paginated_query({
  sql: ${JSON.stringify(sql)},
  pageSize: ${pageSize},
  cursorField: "${effectiveCursorField}",
  includeCount: ${includeCount},
  returnTotals: ${returnTotals}
})\n`;
                markdown += `\`\`\`\n`;
            }

            const response = {
                content: [{
                    type: "text",
                    text: markdown
                }],
                result: {
                    rowCount: rowCount,
                    results: result.recordset || [],
                    metadata: {
                        uuid: uuid,
                        pagination: paginationMeta,
                        totalCount: totalCount,
                        executionTimeMs: result.executionTime || 0,
                        requestId: requestIdValue,
                        cacheHit: false
                    }
                }
            };

            if (cacheTtlSeconds) {
                writeCache(cacheKey, { responseText: markdown, result: response.result });
            }

            return response;
        } catch (err) {
            logger.error(`Error executing paginated query: ${err.message}`);

            const retryableCodes = ['ETIMEOUT', 'ECONNCLOSED', 'ECONNRESET', 'ESOCKET'];
            const isTimeout = err.message && err.message.toLowerCase().includes('timeout');
            const retryable = isTimeout || (err.code && retryableCodes.includes(err.code));
            const errorCode = isTimeout ? 'query_timeout' : 'query_failed';

            return {
                content: [{
                    type: "text",
                    text: `Error executing paginated query: ${formatSqlError(err)}`
                }],
                isError: true,
                result: {
                    errorCode,
                    retryable
                }
            };
        }
    };

    const schema = {
        sql: z.string().min(1, "SQL query cannot be empty"),
        cursorField: z.string().optional(),
        pageSize: z.number().min(1).max(1000).optional().default(50),
        cursor: z.string().optional(),
        parameters: z.record(z.any()).optional(),
        includeCount: z.boolean().optional().default(true),
        direction: z.enum(['next', 'prev']).optional().default('next'),
        returnTotals: z.boolean().optional().default(true),
        timeoutMs: z.number().min(1).max(600000).optional(),
        cacheTtlSeconds: z.number().min(1).max(86400).optional(),
        requestId: z.string().optional(),
        maxEstimatedRows: z.number().min(1).max(10000000).optional(),
        compressOutput: z.boolean().optional().default(false)
    };

    if (registerWithAlias) {
        registerWithAlias("paginated_query", schema, handler);
    } else {
        server.tool("mcp_paginated_query", schema, handler);
    }
}

/**
 * Register the query-streamer tool
 * @param {object} server - MCP server instance
 * @param {function} registerWithAlias - Optional helper to register with aliases
 */
function registerQueryStreamerTool(server, registerWithAlias) {
    const handler = async ({
        sql,
        batchSize = 1000,
        maxRows = 100000,
        parameters = {},
        cursorField,
        outputType = 'summary',
        aggregations,
        outputFile,
        compressOutput = false,
        csvDelimiter = ',',
        csvIncludeHeaders = true,
        csvQuoteChar = '"',
        timeoutMs,
        requestId
    }) => {
        // Basic validation to prevent destructive operations
        const lowerSql = sql.toLowerCase();
        const prohibitedOperations = ['drop ', 'delete ', 'truncate ', 'update ', 'alter ', 'insert ', 'merge '];

        if (prohibitedOperations.some(op => lowerSql.includes(op))) {
            return {
                content: [{
                    type: "text",
                    text: "⚠️ Error: Data modification operations (DROP, DELETE, UPDATE, TRUNCATE, ALTER) are not allowed for safety reasons."
                }],
                isError: true
            };
        }

        try {
            // Determine cursor field if not provided
            const defaultCursorField = extractDefaultCursorField(sql);
            const effectiveCursorField = cursorField || defaultCursorField;

            logger.info(`Starting query streamer with cursor field: ${effectiveCursorField}, batch size: ${batchSize}, max rows: ${maxRows}`);

            // Initialize aggregation accumulators if needed
            const aggregationResults = {};
            if (aggregations) {
                aggregations.forEach(agg => {
                    const { field, operation } = agg;
                    switch (operation) {
                        case 'sum':
                        case 'avg':
                            aggregationResults[`${operation}:${field}`] = 0;
                            break;
                        case 'min':
                            aggregationResults[`min:${field}`] = Number.MAX_VALUE;
                            break;
                        case 'max':
                            aggregationResults[`max:${field}`] = Number.MIN_VALUE;
                            break;
                        case 'count':
                            aggregationResults[`count:${field}`] = 0;
                            break;
                        case 'countDistinct':
                            aggregationResults[`countDistinct:${field}`] = new Set();
                            break;
                    }
                });
            }

            // Variables for tracking streaming state
            let cursor = null;
            let totalProcessedRows = 0;
            let hasMore = true;
            let batchCount = 0;
            let allResults = [];

            // Setup for CSV output
            let csvOutput = '';
            let headers = [];

            // UUID for the output file
            const uuid = crypto.randomUUID();
            let outputPath = null;
            if (outputFile) {
                const resolvedOutput = resolveOutputPath(outputFile, outputType === 'csv' ? 'csv' : 'json');
                if (resolvedOutput?.error) {
                    return {
                        content: [{
                            type: "text",
                            text: `Error writing output file: ${resolvedOutput.error}`
                        }],
                        isError: true
                    };
                }
                outputPath = resolvedOutput.path;
                if (compressOutput && !outputPath.endsWith('.gz')) {
                    outputPath = `${outputPath}.gz`;
                }
            } else {
                outputPath = path.join(QUERY_RESULTS_PATH, `${uuid}.${outputType === 'csv' ? 'csv' : 'json'}`);
                if (compressOutput) {
                    outputPath = `${outputPath}.gz`;
                }
            }

            // Start streaming
            logger.info(`Beginning streaming query execution`);
            const startTime = Date.now();

            // Streaming loop
            while (hasMore && totalProcessedRows < maxRows) {
                batchCount++;

                // Apply pagination for this batch
                const { paginatedSql, parameters: paginatedParams } =
                    paginateQuery(sql, {
                        cursorField: effectiveCursorField,
                        pageSize: batchSize,
                        cursor,
                        parameters,
                        defaultCursorField
                    });

                logger.info(`Executing batch ${batchCount} with cursor: ${cursor || 'initial'}`);

                // Execute this batch
                const batchStartTime = Date.now();
                const batchResult = await executeQuery(paginatedSql, paginatedParams, 3, null, timeoutMs);
                const batchTime = Date.now() - batchStartTime;

                const batchRows = batchResult.recordset || [];
                const batchRowCount = batchRows.length;

                // Update total and check if we have more data
                totalProcessedRows += batchRowCount;
                hasMore = batchRowCount >= batchSize && totalProcessedRows < maxRows;

                logger.info(`Batch ${batchCount} returned ${batchRowCount} rows in ${batchTime}ms, total rows: ${totalProcessedRows}`);

                // Set up headers on first batch if needed
                if (batchCount === 1 && batchRowCount > 0) {
                    headers = Object.keys(batchRows[0]);

                    // Initialize CSV with headers if using CSV output
                    if (outputType === 'csv' && csvIncludeHeaders) {
                        csvOutput = headers.join(csvDelimiter) + '\n';
                    }
                }

                // Process this batch
                if (batchRowCount > 0) {
                    // Update cursor for next batch
                    if (hasMore) {
                        cursor = generateNextCursor(batchRows[batchRowCount - 1], effectiveCursorField);
                    }

                    // Process rows according to output type
                    if (outputType === 'json') {
                        // For JSON, collect all results
                        allResults = [...allResults, ...batchRows];
                    } else if (outputType === 'csv') {
                        // For CSV, append rows to the CSV string
                        batchRows.forEach(row => {
                            const csvRow = headers.map(header => {
                                const value = row[header];
                                if (value === null || value === undefined) return '';
                                if (typeof value === 'string') return `${csvQuoteChar}${value.replace(/"/g, '""')}${csvQuoteChar}`;
                                if (typeof value === 'object') return `${csvQuoteChar}${JSON.stringify(value).replace(/"/g, '""')}${csvQuoteChar}`;
                                return String(value);
                            }).join(csvDelimiter);

                            csvOutput += csvRow + '\n';
                        });
                    }

                    // Process aggregations if requested
                    if (aggregations) {
                        batchRows.forEach(row => {
                            aggregations.forEach(agg => {
                                const { field, operation } = agg;
                                const value = row[field];

                                if (value !== null && value !== undefined) {
                                    const key = `${operation}:${field}`;

                                    switch (operation) {
                                        case 'sum':
                                            if (typeof value === 'number') {
                                                aggregationResults[key] += value;
                                            }
                                            break;
                                        case 'avg':
                                            if (typeof value === 'number') {
                                                aggregationResults[key] += value;
                                            }
                                            break;
                                        case 'min':
                                            if (typeof value === 'number' && value < aggregationResults[key]) {
                                                aggregationResults[key] = value;
                                            }
                                            break;
                                        case 'max':
                                            if (typeof value === 'number' && value > aggregationResults[key]) {
                                                aggregationResults[key] = value;
                                            }
                                            break;
                                        case 'count':
                                            aggregationResults[key]++;
                                            break;
                                        case 'countDistinct':
                                            aggregationResults[key].add(value);
                                            break;
                                    }
                                }
                            });
                        });
                    }
                }

                // Stop if we don't have more data
                if (batchRowCount < batchSize) {
                    hasMore = false;
                }
            }

            const totalTime = Date.now() - startTime;
            logger.info(`Streaming query completed in ${totalTime}ms, processed ${totalProcessedRows} rows in ${batchCount} batches`);

            // Finalize aggregations
            if (aggregations) {
                aggregations.forEach(agg => {
                    const { field, operation } = agg;
                    const key = `${operation}:${field}`;

                    if (operation === 'avg') {
                        // Calculate average from sum and count
                        const count = aggregationResults[`count:${field}`] || totalProcessedRows;
                        if (count > 0) {
                            aggregationResults[key] = aggregationResults[key] / count;
                        }
                    } else if (operation === 'countDistinct') {
                        // Convert Set to count
                        aggregationResults[key] = aggregationResults[key].size;
                    }
                });
            }

            // Save results to a file based on output type
            try {
                if (outputType === 'json') {
                    // Save as JSON with metadata
                    const resultWithMetadata = {
                        metadata: {
                            uuid,
                            timestamp: new Date().toISOString(),
                            query: sql,
                            totalRows: totalProcessedRows,
                            batchCount,
                            executionTimeMs: totalTime,
                            aggregations: aggregationResults
                        },
                        results: allResults
                    };

                    const jsonBuffer = Buffer.from(JSON.stringify(resultWithMetadata, null, 2));
                    fs.writeFileSync(outputPath, compressOutput ? zlib.gzipSync(jsonBuffer) : jsonBuffer);
                } else if (outputType === 'csv') {
                    // Save as CSV
                    const csvBuffer = Buffer.from(csvOutput);
                    fs.writeFileSync(outputPath, compressOutput ? zlib.gzipSync(csvBuffer) : csvBuffer);
                } else {
                    // Save summary if not JSON or CSV
                    const summaryData = {
                        metadata: {
                            uuid,
                            timestamp: new Date().toISOString(),
                            query: sql,
                            totalRows: totalProcessedRows,
                            batchCount,
                            executionTimeMs: totalTime,
                            aggregations: aggregationResults
                        }
                    };

                    const summaryBuffer = Buffer.from(JSON.stringify(summaryData, null, 2));
                    fs.writeFileSync(outputPath, compressOutput ? zlib.gzipSync(summaryBuffer) : summaryBuffer);
                }

                logger.info(`Streaming query results saved to ${outputPath}`);
            } catch (writeError) {
                logger.error(`Error saving streaming query results to file: ${writeError.message}`);
            }

            // Format response markdown
            let markdown = `# Streamed Query Results\n\n`;

            // Add summary stats
            markdown += `## Summary\n\n`;
            markdown += `- **Total Rows Processed**: ${totalProcessedRows.toLocaleString()}\n`;
            markdown += `- **Batches**: ${batchCount}\n`;
            markdown += `- **Execution Time**: ${totalTime.toLocaleString()}ms\n`;
            markdown += `- **Average Rate**: ${Math.round(totalProcessedRows / (totalTime / 1000)).toLocaleString()} rows/second\n`;
            markdown += `- **Output Type**: ${outputType}\n`;
            markdown += `- **Output Location**: ${outputPath}\n\n`;

            // Add aggregation results if we have them
            if (aggregations && Object.keys(aggregationResults).length > 0) {
                markdown += `## Aggregation Results\n\n`;
                markdown += '| Field | Operation | Result |\n';
                markdown += '|-------|-----------|--------|\n';

                aggregations.forEach(agg => {
                    const { field, operation } = agg;
                    const key = `${operation}:${field}`;
                    let value = aggregationResults[key];

                    // Format the value for display
                    if (typeof value === 'number') {
                        value = value.toLocaleString(undefined, {
                            maximumFractionDigits: 4
                        });
                    } else if (value instanceof Set) {
                        value = value.size.toLocaleString();
                    }

                    markdown += `| ${field} | ${operation} | ${value} |\n`;
                });

                markdown += '\n';
            }

            // Add data access info
            markdown += `## Accessing Results\n\n`;

            if (outputType === 'json' || outputType === 'summary') {
                markdown += `To access these results, use:\n\n`;
                markdown += `\`\`\`javascript\n`;
                markdown += `mcp__get_query_results({ uuid: "${uuid}" })\n`;
                markdown += `\`\`\`\n\n`;
            } else {
                markdown += `Results have been saved as a CSV file with ID: ${uuid}\n\n`;
            }

            // Add sample data preview if available
            if (allResults.length > 0 && outputType === 'json') {
                markdown += `## Data Sample\n\n`;

                const previewRows = allResults.slice(0, 5);

                // Table headers
                markdown += '| ' + Object.keys(previewRows[0]).join(' | ') + ' |\n';
                markdown += '| ' + Object.keys(previewRows[0]).map(() => '---').join(' | ') + ' |\n';

                // Table rows
                previewRows.forEach(row => {
                    markdown += '| ' + Object.values(row).map(v => {
                        if (v === null) return 'NULL';
                        if (v === undefined) return '';
                        if (typeof v === 'object') return JSON.stringify(v);
                        return String(v);
                    }).join(' | ') + ' |\n';
                });

                markdown += `\n_Sample of ${previewRows.length} rows from ${totalProcessedRows} total rows_\n`;
            }

            return {
                content: [{
                    type: "text",
                    text: markdown
                }],
                metadata: {
                    streaming: {
                        uuid,
                        totalRows: totalProcessedRows,
                        batchCount,
                        executionTimeMs: totalTime,
                        outputType,
                        aggregations: aggregationResults,
                        outputPath,
                        requestId: requestId || crypto.randomUUID()
                    }
                }
            };
        } catch (err) {
            logger.error(`Error executing streaming query: ${err.message}`);

            const retryableCodes = ['ETIMEOUT', 'ECONNCLOSED', 'ECONNRESET', 'ESOCKET'];
            const isTimeout = err.message && err.message.toLowerCase().includes('timeout');
            const retryable = isTimeout || (err.code && retryableCodes.includes(err.code));
            const errorCode = isTimeout ? 'query_timeout' : 'query_failed';

            return {
                content: [{
                    type: "text",
                    text: `Error executing streaming query: ${formatSqlError(err)}`
                }],
                isError: true,
                result: {
                    errorCode,
                    retryable
                }
            };
        }
    };

    const schema = {
        sql: z.string().min(1, "SQL query cannot be empty"),
        batchSize: z.number().min(1).max(10000).optional().default(1000),
        maxRows: z.number().min(1).max(1000000).optional().default(100000),
        parameters: z.record(z.any()).optional(),
        cursorField: z.string().optional(),
        outputType: z.enum(['json', 'csv', 'summary']).optional().default('summary'),
        outputFile: z.string().optional(),
        compressOutput: z.boolean().optional().default(false),
        csvDelimiter: z.string().optional().default(','),
        csvIncludeHeaders: z.boolean().optional().default(true),
        csvQuoteChar: z.string().optional().default('"'),
        timeoutMs: z.number().min(1).max(600000).optional(),
        requestId: z.string().optional(),
        aggregations: z.array(
            z.object({
                field: z.string(),
                operation: z.enum(['sum', 'avg', 'min', 'max', 'count', 'countDistinct'])
            })
        ).optional()
    };

    if (registerWithAlias) {
        registerWithAlias("query_streamer", schema, handler);
    } else {
        server.tool("mcp_query_streamer", schema, handler);
    }
}

// Export the database tools for use in the server
export {
    registerDatabaseTools,
    registerExecuteQueryTool,
    registerTableDetailsTool,
    registerProcedureDetailsTool,
    registerFunctionDetailsTool,
    registerViewDetailsTool,
    registerIndexDetailsTool,
    registerDiscoverTablesTool,
    registerDiscoverDatabaseTool,
    registerGetQueryResultsTool,
    registerDiscoverTool,
    registerCursorGuideTool,
    registerPaginatedQueryTool,
    registerQueryStreamerTool
};

/**
 * Register the health check tool
 * @param {object} server - MCP server instance
 * @param {function} registerWithAllAliases - Helper to register with all name variants
 */
function registerHealthCheckTool(server, registerWithAllAliases) {
    const schema = z.object({}); // No arguments required

    const handler = async (args) => {
        try {
            const dbHealth = await checkDatabaseHealth();
            const uptime = process.uptime();

            // Format response
            let responseText = `# System Health Check\n\n`;
            responseText += `**Uptime**: ${Math.floor(uptime / 60)} minutes\n`;
            responseText += `**Timestamp**: ${new Date().toISOString()}\n\n`;

            responseText += `## Database Connections\n\n`;
            responseText += `| Database ID | Status | Connected | Latency |\n`;
            responseText += `|-------------|--------|-----------|---------|\n`;

            dbHealth.forEach(db => {
                const statusIcon = db.status === 'healthy' ? '🟢' : (db.connected ? '🟡' : '🔴');
                const latency = db.latencyMs ? `${db.latencyMs}ms` : 'N/A';
                responseText += `| ${db.databaseId} | ${statusIcon} ${db.status} | ${db.connected} | ${latency} |\n`;
            });

            return {
                content: [{
                    type: "text",
                    text: responseText
                }],
                result: {
                    uptime,
                    timestamp: new Date().toISOString(),
                    databases: dbHealth
                }
            };
        } catch (err) {
            logger.error(`Health check failed: ${err.message}`);
            return {
                content: [{
                    type: "text",
                    text: `❌ Health check failed: ${err.message}`
                }],
                isError: true
            };
        }
    };

    registerWithAllAliases("server_health", schema, handler);
}
