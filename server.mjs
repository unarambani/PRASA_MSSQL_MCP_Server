// server.js - Main MCP Server Implementation
import dotenv from 'dotenv';
import express from 'express';
import bodyParser from 'body-parser';
import sql from 'mssql';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';

// Import database utilities
import { initializeDbPool, executeQuery, getDbConfig } from './Lib/database.mjs';

// Import multi-database configuration loader
import { loadMultiDatabaseConfig } from './load-multi-db-config.mjs';

// Import tool implementations
import { registerDatabaseTools } from './Lib/tools.mjs';

// Import resource implementations
import { registerDatabaseResources } from './Lib/resources.mjs';

// Import prompt implementations
import { registerPrompts } from './Lib/prompts.mjs';

// Import utilities
import { logger } from './Lib/logger.mjs';
import { getReadableErrorMessage, createJsonRpcError } from './Lib/errors.mjs';

// Load environment variables
dotenv.config();

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const PORT = process.env.PORT || 3333;
const TRANSPORT = process.env.TRANSPORT || 'stdio';
const HOST = process.env.HOST || '0.0.0.0';
const QUERY_RESULTS_PATH = process.env.QUERY_RESULTS_PATH || path.join(__dirname, 'query_results');
const PING_INTERVAL = process.env.PING_INTERVAL || 60000; // Ping every 60 seconds by default

// Create results directory if it doesn't exist
if (!fs.existsSync(QUERY_RESULTS_PATH)) {
    fs.mkdirSync(QUERY_RESULTS_PATH, { recursive: true });
    logger.info(`Created results directory: ${QUERY_RESULTS_PATH}`);
}

// Create Express app to handle HTTP requests for SSE transport
const app = express();
const httpServer = http.createServer(app);

// Security middleware
app.use(helmet({ contentSecurityPolicy: false })); // Modified helmet config for SSE
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // Limit each IP to 100 requests per minute
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        status: 429,
        message: 'Too many requests, please try again later.'
    }
});
app.use(limiter);

// Logging middleware
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.url}`);
    next();
});

// Error handling middleware
app.use((err, req, res, next) => {
    logger.error(`Express error: ${err.message}`);
    res.status(500).json({
        jsonrpc: "2.0",
        error: createJsonRpcError(-32603, `Internal error: ${err.message}`)
    });
});

// Create MCP server instance
const server = new McpServer({
    name: "MSSQL-MCP-Server",
    version: "1.1.0",
    capabilities: {
        resources: {
            listChanged: true
        },
        tools: {
            listChanged: true
        },
        prompts: {
            listChanged: true
        }
    }
});

// Make sure server._tools exists
if (!server._tools) {
    server._tools = {};
}

// Add a helper method to the server to execute tools directly
server.executeToolCall = async function (toolName, args) {
    // Find the tool in the registered tools
    logger.info(`Looking for tool: ${toolName}`);
    const tool = this._tools ? this._tools[toolName] : null;

    if (!tool) {
        const availableTools = Object.keys(this._tools || {}).join(', ');
        logger.error(`Tool ${toolName} not found. Available tools: ${availableTools}`);
        throw new Error(`Tool ${toolName} not found. Available tools: ${availableTools.length > 100 ? availableTools.substring(0, 100) + '...' : availableTools}`);
    }

    try {
        logger.info(`Executing tool ${toolName} directly with args: ${JSON.stringify(args)}`);
        const result = await tool.handler(args);
        logger.info(`Tool ${toolName} executed successfully`);
        return result;
    } catch (err) {
        logger.error(`Error executing tool ${toolName}: ${err.message}`);
        throw err;
    }
};

// Load multi-database configuration if available
try {
    logger.info("Checking for multi-database configuration...");
    await loadMultiDatabaseConfig();
} catch (error) {
    logger.info("No multi-database configuration found or failed to load. Using default configuration.");
}

// IMPORTANT: Register database tools BEFORE setting up HTTP routes
try {
    // Register database tools (execute-query, table-details, etc.)
    logger.info("Registering database tools...");
    registerDatabaseTools(server);

    // Debug log of registered tools
    console.log("DEBUG: Tools after registration:");
    console.log(Object.keys(server._tools || {}));

    // Register database resources (tables, schema, views, etc.)
    logger.info("Registering database resources...");
    registerDatabaseResources(server);

    // Register prompts (generate-query, etc.)
    logger.info("Registering prompts...");
    registerPrompts(server);

    // Debug log for tools
    const registeredTools = Object.keys(server._tools || {});
    logger.info(`Registered tools (${registeredTools.length}): ${registeredTools.join(', ')}`);
} catch (error) {
    logger.error(`Failed to register tools: ${error.message}`);
    logger.error(error.stack);
}

// Transport variables
let currentTransport = null;
let activeConnections = new Set();
let pingIntervalId = null;

// Add HTTP server status endpoint
app.get('/', (req, res) => {
    const dbConfig = getDbConfig(true); // Get sanitized config (no password)

    res.status(200).json({
        status: 'ok',
        message: 'MCP Server is running',
        transport: TRANSPORT,
        endpoints: {
            sse: '/sse',
            messages: '/messages',
            diagnostics: '/diagnostic',
            query_results: {
                list: '/query-results',
                detail: '/query-results/:uuid'
            }
        },
        connection_info: {
            ping_interval_ms: PING_INTERVAL,
            active_connections: activeConnections.size
        },
        database_info: {
            server: dbConfig.server,
            database: dbConfig.database,
            user: dbConfig.user
        },
        version: server.options?.version || "1.1.0"
    });
});

// Add an endpoint to list all tools
app.get('/tools', (req, res) => {
    try {
        // Access tools directly from the server instance
        const tools = server._tools || {};

        const toolList = Object.keys(tools).map(name => {
            return {
                name,
                schema: tools[name].schema,
                source: 'internal'
            };
        });

        logger.info(`Tool listing requested. Found ${toolList.length} tools.`);
        logger.info(`Tools from internal: ${Object.keys(tools).join(', ')}`);

        res.status(200).json({
            count: toolList.length,
            tools: toolList,
            debug: {
                internalToolKeys: Object.keys(tools)
            }
        });
    } catch (error) {
        logger.error(`Error listing tools: ${error.message}`);
        res.status(500).json({
            error: `Failed to list tools: ${error.message}`,
            stack: error.stack
        });
    }
});

// Diagnostic endpoint 
app.get('/diagnostic', async (req, res) => {
    try {
        const dbConfig = getDbConfig(true); // Get sanitized config (no password)

        const diagnosticInfo = {
            status: 'ok',
            server: {
                version: process.version,
                platform: process.platform,
                arch: process.arch,
                uptime: process.uptime()
            },
            mcp: {
                transport: TRANSPORT,
                activeConnections: activeConnections.size,
                hasCurrentTransport: currentTransport !== null,
                version: server.options?.version || "1.1.0",
                pingIntervalMs: PING_INTERVAL,
                pingActive: pingIntervalId !== null
            },
            database: {
                server: dbConfig.server,
                database: dbConfig.database,
                user: dbConfig.user,
                port: dbConfig.port
            },
            endpoints: {
                sse: `${req.protocol}://${req.get('host')}/sse`,
                messages: `${req.protocol}://${req.get('host')}/messages`,
                queryResults: `${req.protocol}://${req.get('host')}/query-results`
            }
        };

        // Test database connection
        try {
            await executeQuery('SELECT 1 AS TestConnection');
            diagnosticInfo.database.connectionTest = 'successful';
        } catch (err) {
            diagnosticInfo.database.connectionTest = 'failed';
            diagnosticInfo.database.connectionError = err.message;
        }

        res.status(200).json(diagnosticInfo);
    } catch (error) {
        logger.error(`Diagnostic error: ${error.message}`);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

// Direct cursor guide endpoint
app.get('/cursor-guide', (req, res) => {
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
   - Always include an ORDER BY clause that includes your cursor field
   - Consistent ordering is essential (always ASC or always DESC)

3. **Handle edge cases**:
   - First/last page detection
   - Empty result sets
   - Missing or invalid cursors

4. **Performance considerations**:
   - Use indexed fields for cursors
   - Avoid expensive joins in paginated queries
   - Consider caching results for frequently accessed pages
`;

    // Send both JSON and plain text formats
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
        res.status(200).json({
            jsonrpc: "2.0",
            result: {
                content: [{
                    type: "text",
                    text: guideText
                }]
            }
        });
    } else {
        res.status(200).type('text/markdown').send(guideText);
    }
});

// SSE endpoint for client to connect
app.get('/sse', async (req, res) => {
    logger.info('New SSE connection request received');

    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Prevents buffering in Nginx

    try {
        // Create new SSE transport for this connection
        const messagesEndpoint = `/messages`;
        logger.info(`Creating SSE transport with messages endpoint: ${messagesEndpoint}`);

        // Create the transport
        currentTransport = new SSEServerTransport(messagesEndpoint, res);

        // Set up message handlers before connecting
        currentTransport.onmessage = function (message) {
            logger.info(`Transport received message: ${JSON.stringify(message)}`);
        };

        // Error handler
        currentTransport.onerror = function (error) {
            logger.error(`Transport error: ${error}`);
        };

        // Close handler
        currentTransport.onclose = function () {
            logger.info(`Transport closed`);
        };

        // Connect the server to this transport
        await server.connect(currentTransport);

        logger.info('SSE transport connected successfully');

        // Add this connection to tracking
        activeConnections.add(res);
        logger.info(`Active SSE connections: ${activeConnections.size}`);

        // Clear any existing ping interval
        if (pingIntervalId) {
            clearInterval(pingIntervalId);
        }

        // Set up ping interval to keep connection alive
        pingIntervalId = setInterval(() => {
            if (res && !res.finished) {
                logger.debug('Sending ping to client');
                res.write('event: ping\n');
                res.write(`data: ${Date.now()}\n\n`);
            } else {
                // Connection is closed, clear interval
                clearInterval(pingIntervalId);
                pingIntervalId = null;
            }
        }, PING_INTERVAL);

        // Handle client disconnect
        req.on('close', () => {
            logger.info('SSE client disconnected');
            activeConnections.delete(res);
            currentTransport = null;

            // Clear ping interval when client disconnects
            if (pingIntervalId) {
                clearInterval(pingIntervalId);
                pingIntervalId = null;
            }

            logger.info(`Active SSE connections: ${activeConnections.size}`);
        });

        // Send a welcome message after connection is established
        setTimeout(async () => {
            try {
                if (!currentTransport) return;

                // Create a simple welcome notification
                const welcomeMessage = {
                    jsonrpc: "2.0",
                    method: "notification",
                    params: {
                        type: "info",
                        message: `# Welcome to MSSQL MCP Server v${server.options?.version || "1.1.0"} 🚀\n\n` +
                            `To explore the database, use these commands:\n\n` +
                            `\`\`\`javascript\n` +
                            `mcp__discover_database()\n` +
                            `\`\`\``
                    }
                };

                currentTransport.send(welcomeMessage);
                logger.info('Welcome message sent');

                // Try to get a sample table for additional guidance
                try {
                    const tablesResult = await executeQuery(`
                        SELECT TOP 1
                            TABLE_NAME 
                        FROM 
                            INFORMATION_SCHEMA.TABLES 
                        WHERE 
                            TABLE_TYPE = 'BASE TABLE' 
                        ORDER BY 
                            TABLE_NAME
                    `);

                    if (tablesResult.recordset?.length > 0) {
                        const sampleTable = tablesResult.recordset[0].TABLE_NAME;

                        // Send additional examples
                        const examplesMessage = {
                            jsonrpc: "2.0",
                            method: "notification",
                            params: {
                                type: "info",
                                message: `## Example Commands\n\n` +
                                    `Get table details:\n` +
                                    `\`\`\`javascript\n` +
                                    `mcp__table_details({ tableName: "${sampleTable}" })\n` +
                                    `\`\`\`\n\n` +
                                    `Execute a query:\n` +
                                    `\`\`\`javascript\n` +
                                    `mcp__execute_query({ sql: "SELECT TOP 10 * FROM ${sampleTable}" })\n` +
                                    `\`\`\``
                            }
                        };

                        currentTransport.send(examplesMessage);
                    }
                } catch (dbErr) {
                    logger.warn(`Database query failed in welcome message: ${dbErr.message}`);
                    // Continue without table example
                }
            } catch (err) {
                logger.error(`Error sending welcome message: ${err.message}`);
                // Don't terminate connection on welcome message error
            }
        }, 1000);
    } catch (error) {
        logger.error(`Failed to set up SSE transport: ${error.message}`);
        res.status(500).end(`Error: ${error.message}`);
    }
});

// Messages endpoint for client to send messages
app.post('/messages', (req, res) => {
    logger.info('Received message from client');

    if (!currentTransport) {
        logger.error('No SSE transport available to process message');
        return res.status(503).json({
            jsonrpc: "2.0",
            id: req.body.id || null,
            error: {
                code: -32000,
                message: "Server transport not initialized. Connect to /sse endpoint first."
            }
        });
    }

    try {
        // Extract the request ID for better debugging
        const requestId = req.body.id || "unknown";
        const method = req.body.method || "unknown";

        logger.info(`Processing message ID: ${requestId}, method: ${method}`);
        logger.info(`Request body: ${JSON.stringify(req.body)}`);

        // Special handling for cursor guide tool
        if (method === 'tools/call' &&
            (req.body.params?.name === 'mcp_cursor_guide' ||
                req.body.params?.name === 'cursor_guide')) {

            logger.info('Direct handling for cursor guide tool');

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
   - Always include an ORDER BY clause that includes your cursor field
   - Consistent ordering is essential (always ASC or always DESC)

3. **Handle edge cases**:
   - First/last page detection
   - Empty result sets
   - Missing or invalid cursors

4. **Performance considerations**:
   - Use indexed fields for cursors
   - Avoid expensive joins in paginated queries
   - Consider caching results for frequently accessed pages
`;

            const result = {
                content: [{
                    type: "text",
                    text: guideText
                }]
            };

            // Don't send response via HTTP, just SSE which is what Claude expects
            // Also send via SSE for any listeners
            if (currentTransport) {
                // Proper JSON-RPC formatting is critical
                const sseResponse = {
                    jsonrpc: "2.0",
                    id: requestId,
                    result: result
                };

                // Write direct to the SSE connection with event: message format
                if (currentTransport.res && !currentTransport.res.finished) {
                    currentTransport.res.write(`event: message\n`);
                    currentTransport.res.write(`data: ${JSON.stringify(sseResponse)}\n\n`);

                    // Send a success response to the HTTP POST
                    res.status(200).json({ success: true });
                } else {
                    // If SSE connection is closed, fallback to HTTP response
                    res.status(200).json(sseResponse);
                }
            } else {
                // Fallback to HTTP response if no SSE transport
                res.status(200).json({
                    jsonrpc: "2.0",
                    id: requestId,
                    result: result
                });
            }

            return;
        }

        // Special handling for tool calls - properly send via SSE transport
        if (method === 'tools/call') {
            const toolName = req.body.params?.name;
            const toolArgs = req.body.params?.arguments || {};

            logger.info(`Direct handling for tool call: ${toolName}`);

            // Try to find the tool with various name patterns
            const possibleToolNames = [
                toolName,                                   // Original name
                toolName.startsWith('mcp_') ? toolName : `mcp_${toolName}`, // Ensure mcp_ prefix
                toolName.startsWith('mcp_SQL_') ? toolName : `mcp_SQL_${toolName}`, // Ensure mcp_SQL_ prefix
                toolName.replace('mcp_', 'mcp_SQL_'),       // Convert mcp_ to mcp_SQL_
                toolName.replace('mcp_SQL_', 'mcp_')        // Convert mcp_SQL_ to mcp_
            ];

            let foundToolName = null;

            for (const name of possibleToolNames) {
                if (server._tools && server._tools[name]) {
                    foundToolName = name;
                    logger.info(`Found tool handler for: ${name}`);
                    break;
                }
            }

            if (foundToolName) {
                // Execute the tool and get result
                server.executeToolCall(foundToolName, toolArgs)
                    .then(result => {
                        logger.info(`Direct tool result obtained successfully for ${foundToolName}`);
                        logger.info(`Result type: ${typeof result}, has content: ${!!result.content}`);

                        // Send result via SSE transport
                        if (currentTransport && currentTransport.res && !currentTransport.res.finished) {
                            // Proper JSON-RPC formatting
                            const sseResponse = {
                                jsonrpc: "2.0",
                                id: requestId,
                                result: result
                            };

                            // Write directly to the SSE connection with event: message format
                            currentTransport.res.write(`event: message\n`);
                            currentTransport.res.write(`data: ${JSON.stringify(sseResponse)}\n\n`);
                            
                            // Ensure the data is flushed immediately
                            if (typeof currentTransport.res.flush === 'function') {
                                currentTransport.res.flush();
                            }

                            // Respond to HTTP request
                            res.status(200).json({ success: true, sent: 'sse' });
                            logger.info(`SSE response sent for request ID: ${requestId}`);
                        } else {
                            // Fallback to HTTP response if SSE not available
                            res.status(200).json({
                                jsonrpc: "2.0",
                                id: requestId,
                                result: result
                            });
                        }
                    })
                    .catch(err => {
                        logger.error(`Error executing tool directly: ${err.message}`);

                        // Send error via SSE
                        if (currentTransport && currentTransport.res && !currentTransport.res.finished) {
                            const errorResponse = {
                                jsonrpc: "2.0",
                                id: requestId,
                                error: {
                                    code: -32603,
                                    message: `Error executing tool: ${err.message}`
                                }
                            };

                            currentTransport.res.write(`event: message\n`);
                            currentTransport.res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
                            
                            // Ensure the data is flushed immediately
                            if (typeof currentTransport.res.flush === 'function') {
                                currentTransport.res.flush();
                            }

                            res.status(200).json({ success: true });
                        } else {
                            res.status(500).json({
                                jsonrpc: "2.0",
                                id: requestId,
                                error: {
                                    code: -32603,
                                    message: `Error executing tool: ${err.message}`
                                }
                            });
                        }
                    });

                // Return early - response will be sent by the promise
                return;
            } else {
                logger.error(`Tool not found with any name variant: ${toolName}`);
                logger.error(`Available tools: ${Object.keys(server._tools || {}).join(', ')}`);

                // Send error via SSE
                if (currentTransport && currentTransport.res && !currentTransport.res.finished) {
                    const errorResponse = {
                        jsonrpc: "2.0",
                        id: requestId,
                        error: {
                            code: -32601,
                            message: `Tool not found: ${toolName}`
                        }
                    };

                    currentTransport.res.write(`event: message\n`);
                    currentTransport.res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);

                    res.status(200).json({ success: true });
                } else {
                    return res.status(404).json({
                        jsonrpc: "2.0",
                        id: requestId,
                        error: {
                            code: -32601,
                            message: `Tool not found: ${toolName}`
                        }
                    });
                }
                return;
            }
        }

        // Special case for SSEServerTransport - monkey patch its send method to ensure correct format
        // This affects all other tool calls that go through the standard transport
        if (currentTransport && typeof currentTransport.send === 'function') {
            const originalSend = currentTransport.send;
            currentTransport.send = function (message) {
                logger.info(`Intercepting SSE transport send: ${JSON.stringify(message)}`);

                // Don't use the original send for JSON-RPC responses, write directly to the stream
                if (message.jsonrpc === "2.0" && message.id && (message.result || message.error)) {
                    if (this.res && !this.res.finished) {
                        // Write the message with event: message format as per GitHub reference
                        this.res.write(`event: message\n`);
                        this.res.write(`data: ${JSON.stringify(message)}\n\n`);
                        
                        // Ensure the data is flushed immediately
                        if (typeof this.res.flush === 'function') {
                            this.res.flush();
                        }

                        // No need for separate completion event with this format
                        logger.info(`Sent message event for request ID: ${message.id}`);
                        return;
                    }
                }

                // Fall back to original behavior for other messages
                return originalSend.call(this, message);
            };
        }

        // For standard message handling (non-tool calls or tools we couldn't handle directly)
        // Let the SSEServerTransport handle it with our monkey-patched send method
        currentTransport.handlePostMessage(req, res, req.body);
        logger.info(`Message processed via SSE transport for request ID: ${requestId}`);

    } catch (error) {
        logger.error(`Error processing message: ${error.message}`);

        // Send error via SSE if possible
        if (currentTransport && currentTransport.res && !currentTransport.res.finished) {
            const errorResponse = {
                jsonrpc: "2.0",
                id: req.body.id || null,
                error: {
                    code: -32603,
                    message: "Internal server error: " + error.message
                }
            };

            currentTransport.res.write(`event: message\n`);
            currentTransport.res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);

            res.status(200).json({ success: true });
        } else {
            return res.status(500).json({
                jsonrpc: "2.0",
                id: req.body.id || null,
                error: {
                    code: -32603,
                    message: "Internal server error: " + error.message
                }
            });
        }
    }
});

// Add a test endpoint for SSE debugging
app.post('/test-sse', (req, res) => {
    logger.info('Test SSE endpoint called');
    
    if (!currentTransport || !currentTransport.res || currentTransport.res.finished) {
        return res.status(503).json({ error: 'No active SSE connection' });
    }
    
    try {
        const testMessage = {
            jsonrpc: "2.0",
            id: req.body.id || "test-" + Date.now(),
            result: {
                content: [{
                    type: "text",
                    text: "Test SSE message sent successfully at " + new Date().toISOString()
                }]
            }
        };
        
        currentTransport.res.write(`event: message\n`);
        currentTransport.res.write(`data: ${JSON.stringify(testMessage)}\n\n`);
        
        if (typeof currentTransport.res.flush === 'function') {
            currentTransport.res.flush();
        }
        
        logger.info('Test SSE message sent');
        res.status(200).json({ success: true, message: 'Test message sent via SSE' });
        
    } catch (error) {
        logger.error(`Error sending test SSE message: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// Add HTTP endpoints to list and retrieve saved query results
app.get('/query-results', (req, res) => {
    try {
        if (!fs.existsSync(QUERY_RESULTS_PATH)) {
            return res.status(200).json({ results: [] });
        }

        // Read all JSON files in the results directory
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
                        filename: file
                    };
                } catch (err) {
                    logger.error(`Error reading file ${file}: ${err.message}`);
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
            });

        res.status(200).json({ results: files });
    } catch (err) {
        logger.error(`Error listing query results: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.get('/query-results/:uuid', (req, res) => {
    const { uuid } = req.params;
    const filepath = path.join(QUERY_RESULTS_PATH, `${uuid}.json`);

    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ error: `Result with UUID ${uuid} not found` });
    }

    try {
        const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        res.status(200).json(data);
    } catch (err) {
        logger.error(`Error retrieving query result ${uuid}: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Add a debugging endpoint to directly register the cursor guide tool
app.get('/debug/register-cursor-guide', (req, res) => {
    try {
        logger.info('Manually registering cursor guide tool');

        // Create cursor guide tool schema and handler
        const cursorGuideSchema = {
            random_string: z.string().optional().describe("Dummy parameter for no-parameter tools")
        };

        const cursorGuideHandler = async (args) => {
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
   - Always include an ORDER BY clause that includes your cursor field
   - Consistent ordering is essential (always ASC or always DESC)

3. **Handle edge cases**:
   - First/last page detection
   - Empty result sets
   - Missing or invalid cursors

4. **Performance considerations**:
   - Use indexed fields for cursors
   - Avoid expensive joins in paginated queries
   - Consider caching results for frequently accessed pages
`;

            return {
                content: [{
                    type: "text",
                    text: guideText
                }]
            };
        };

        // Register with only mcp_ prefix for consistency
        server.tool("mcp_cursor_guide", cursorGuideSchema, cursorGuideHandler);

        // Make sure these are directly accessible in _tools
        if (!server._tools) server._tools = {};
        server._tools["mcp_cursor_guide"] = { schema: cursorGuideSchema, handler: cursorGuideHandler };

        const toolNames = Object.keys(server._tools || {});

        res.status(200).json({
            success: true,
            message: 'Cursor guide tool manually registered',
            tools: toolNames
        });
    } catch (error) {
        logger.error(`Error registering cursor guide tool: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Add a debugging endpoint to list all tools and their details
app.get('/debug-tools', (req, res) => {
    try {
        // Examine server._tools directly
        const toolKeys = Object.keys(server._tools || {});

        // Build detailed response
        const toolDetails = {};
        for (const key of toolKeys) {
            try {
                const tool = server._tools[key];
                toolDetails[key] = {
                    hasHandler: !!tool.handler,
                    handlerType: typeof tool.handler,
                    hasSchema: !!tool.schema,
                    schemaKeys: tool.schema ? Object.keys(tool.schema) : []
                };
            } catch (err) {
                toolDetails[key] = { error: err.message };
            }
        }

        res.status(200).json({
            toolCount: toolKeys.length,
            toolNames: toolKeys,
            toolDetails,
            raw: server._tools
        });
    } catch (error) {
        res.status(500).json({
            error: error.message,
            stack: error.stack
        });
    }
});

// Add debugging endpoint to list all registered tools
app.get('/debug/tools', (req, res) => {
    try {
        const allTools = server._tools || {};
        const toolNames = Object.keys(allTools);

        // Group tools by their base name (without prefix)
        const toolsByBaseName = {};

        toolNames.forEach(name => {
            let baseName = name;

            // Remove known prefixes
            if (name.startsWith('mcp_SQL_')) {
                baseName = name.substring(8);
            } else if (name.startsWith('mcp_')) {
                baseName = name.substring(4);
            } else if (name.startsWith('SQL_')) {
                baseName = name.substring(4);
            }

            if (!toolsByBaseName[baseName]) {
                toolsByBaseName[baseName] = [];
            }

            toolsByBaseName[baseName].push(name);
        });

        res.status(200).json({
            totalTools: toolNames.length,
            toolNamesByGroup: toolsByBaseName,
            allToolNames: toolNames
        });
    } catch (error) {
        res.status(500).json({
            error: error.message,
            stack: error.stack
        });
    }
});

// Setup and start server
async function startServer() {
    try {
        logger.info(`Starting MS SQL MCP Server v${server.options?.version || "1.1.0"}...`);

        // Initialize database connection pool only if not using multi-database mode
        // Multi-database pools are initialized by the loadMultiDatabaseConfig function
        const hasMultiDatabaseConfig = fs.existsSync(path.join(__dirname, 'multi-db-config.json'));
        if (!hasMultiDatabaseConfig) {
            logger.info("No multi-database configuration found, initializing default database pool...");
        await initializeDbPool();
        } else {
            logger.info("Multi-database configuration detected, skipping default database initialization");
        }

        // Select transport based on configuration
        if (TRANSPORT === 'sse') {
            logger.info(`Setting up SSE transport on port ${PORT}`);

            // Start HTTP server for SSE transport
            await new Promise((resolve, reject) => {
                httpServer.listen(PORT, HOST, () => {
                    logger.info(`HTTP server listening on port ${PORT} and host ${HOST}`);
                    logger.info(`SSE endpoint: http://${HOST}:${PORT}/sse`);
                    logger.info(`Messages endpoint: http://${HOST}:${PORT}/messages`);
                    resolve();
                });

                httpServer.on('error', (error) => {
                    logger.error(`Failed to start HTTP server: ${error.message}`);
                    reject(error);
                });
            });

            logger.info('Waiting for SSE client connection...');
        } else if (TRANSPORT === 'stdio') {
            logger.info('Setting up STDIO transport');

            // For stdio transport, we can set up and connect immediately
            const transport = new StdioServerTransport();
            await server.connect(transport);

            logger.info('STDIO transport ready');
        } else {
            throw new Error(`Unsupported transport type: ${TRANSPORT}`);
        }

        // Add graceful shutdown handler
        process.on('SIGINT', async () => {
            logger.info('Shutting down server gracefully...');

            // Clear ping interval if it exists
            if (pingIntervalId) {
                logger.info('Clearing ping interval');
                clearInterval(pingIntervalId);
                pingIntervalId = null;
            }

            // Close active connections
            if (activeConnections.size > 0) {
                logger.info(`Closing ${activeConnections.size} active SSE connections`);
                for (const connection of activeConnections) {
                    try {
                        connection.end();
                    } catch (error) {
                        logger.error(`Error closing SSE connection: ${error.message}`);
                    }
                }
                activeConnections.clear();
            }

            // Close HTTP server if it's running
            if (httpServer && httpServer.listening) {
                logger.info('Closing HTTP server');
                await new Promise(resolve => httpServer.close(resolve));
            }

            // Close database pool
            try {
                await sql.close();
                logger.info('Database connections closed');
            } catch (err) {
                logger.error(`Error closing database connections: ${err.message}`);
            }

            logger.info('Server shutdown complete');
            process.exit(0);
        });

        logger.info('MCP Server startup complete');
    } catch (err) {
        logger.error(`Failed to start MCP server: ${err.message}`);
        process.exit(1);
    }
}

// Start the server
startServer();

export { app, server, httpServer };