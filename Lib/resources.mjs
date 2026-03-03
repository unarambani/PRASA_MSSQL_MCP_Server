// lib/resources.js - Database resource implementations
import { executeQuery, sanitizeSqlIdentifier, formatSqlError } from './database.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.mjs';
import { createJsonRpcError } from './errors.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const QUERY_RESULTS_PATH = process.env.QUERY_RESULTS_PATH || path.join(__dirname, '../query_results');
const SCHEMA_CACHE_TTL_SECONDS = parseInt(process.env.SCHEMA_CACHE_TTL_SECONDS || '300', 10);
const SCHEMA_CACHE_FILE = path.join(QUERY_RESULTS_PATH, 'schema-cache.json');

function readSchemaCache() {
    if (!fs.existsSync(SCHEMA_CACHE_FILE)) return null;
    try {
        const cached = JSON.parse(fs.readFileSync(SCHEMA_CACHE_FILE, 'utf8'));
        const ageMs = Date.now() - new Date(cached.timestamp).getTime();
        if (ageMs > SCHEMA_CACHE_TTL_SECONDS * 1000) return null;
        return cached.text || null;
    } catch {
        return null;
    }
}

function writeSchemaCache(text) {
    try {
        const data = {
            timestamp: new Date().toISOString(),
            text
        };
        fs.writeFileSync(SCHEMA_CACHE_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        logger.warn(`Failed to write schema cache: ${err.message}`);
    }
}

/**
 * Register all database-related resources with the MCP server
 * @param {object} server - MCP server instance
 */
export function registerDatabaseResources(server) {
    logger.info('Registering database resources');
    
    // Wrap the original resource method to add logging and error handling
    const originalResource = server.resource.bind(server);
    server.resource = function(name, uriPattern, handler) {
        const wrappedHandler = async function(...args) {
            logger.info(`Reading resource: ${name}`);
            logger.debug(`URI: ${args[0]?.href}`);
            
            try {
                const result = await handler(...args);
                logger.info(`Resource ${name} read successfully`);
                return result;
            } catch (err) {
                logger.error(`Resource ${name} read failed: ${err.message}`);
                
                // Format error for response
                const errorMessage = formatSqlError(err);
                
                return {
                    contents: [{
                        uri: args[0]?.href || `${name}://error`,
                        text: `Error reading resource: ${errorMessage}`
                    }]
                };
            }
        };
        
        return originalResource(name, uriPattern, wrappedHandler);
    };
    
    // Register all database resources
    registerDatabaseSchemaResource(server);
    registerTablesListResource(server);
    registerProceduresListResource(server);
    registerFunctionsListResource(server);
    registerViewsListResource(server);
    registerIndexesListResource(server);
    registerAiSchemaResource(server);
    registerDiscoveryResource(server);
    
    logger.info('Database resources registered successfully');
}

/**
 * Register the database schema resource
 * @param {object} server - MCP server instance
 */
function registerDatabaseSchemaResource(server) {
    server.resource(
        "schema",
        "schema://database",
        async (uri) => {
            try {
                logger.info('Fetching database schema...');

                const cached = readSchemaCache();
                if (cached) {
                    logger.info('Schema cache hit');
                    return {
                        contents: [{
                            uri: uri.href,
                            text: cached
                        }]
                    };
                }
                
                const result = await executeQuery(`
                    SELECT 
                        TABLE_NAME,
                        COLUMN_NAME,
                        DATA_TYPE,
                        IS_NULLABLE,
                        CHARACTER_MAXIMUM_LENGTH,
                        COLUMN_DEFAULT
                    FROM 
                        INFORMATION_SCHEMA.COLUMNS
                    ORDER BY 
                        TABLE_NAME, ORDINAL_POSITION
                `);
                
                // Format schema data into human-readable text
                const formattedSchema = formatSchemaData(result.recordset);
                writeSchemaCache(formattedSchema);
                logger.info('Schema retrieved successfully');
                
                return {
                    contents: [{
                        uri: uri.href,
                        text: formattedSchema
                    }]
                };
            } catch (err) {
                logger.error(`Error retrieving schema: ${err.message}`);
                throw err;
            }
        }
    );
}

/**
 * Register the tables list resource
 * @param {object} server - MCP server instance
 */
function registerTablesListResource(server) {
    server.resource(
        "tables",
        "tables://list",
        async (uri) => {
            try {
                logger.info('Fetching tables list...');
                
                const result = await executeQuery(`
                    SELECT 
                        TABLE_SCHEMA,
                        TABLE_NAME,
                        TABLE_TYPE
                    FROM 
                        INFORMATION_SCHEMA.TABLES
                    WHERE 
                        TABLE_TYPE = 'BASE TABLE'
                    ORDER BY 
                        TABLE_SCHEMA, TABLE_NAME
                `);
                
                // Format as markdown list grouped by schema
                let markdown = `# Database Tables\n\n`;
                
                // Group by schema
                const tablesBySchema = {};
                result.recordset.forEach(table => {
                    if (!tablesBySchema[table.TABLE_SCHEMA]) {
                        tablesBySchema[table.TABLE_SCHEMA] = [];
                    }
                    tablesBySchema[table.TABLE_SCHEMA].push(table.TABLE_NAME);
                });
                
                // Add tables by schema
                for (const [schema, tables] of Object.entries(tablesBySchema)) {
                    markdown += `## ${schema} Schema\n\n`;
                    tables.forEach(table => {
                        markdown += `- ${table}\n`;
                    });
                    markdown += '\n';
                }
                
                logger.info(`Retrieved ${result.recordset.length} tables`);
                
                return {
                    contents: [{
                        uri: uri.href,
                        text: markdown
                    }]
                };
            } catch (err) {
                logger.error(`Error retrieving tables: ${err.message}`);
                throw err;
            }
        }
    );
}

/**
 * Register the stored procedures list resource
 * @param {object} server - MCP server instance
 */
function registerProceduresListResource(server) {
    server.resource(
        "procedures",
        "procedures://list",
        async (uri) => {
            try {
                logger.info('Fetching stored procedures list...');
                
                const result = await executeQuery(`
                    SELECT 
                        ROUTINE_SCHEMA,
                        ROUTINE_NAME
                    FROM 
                        INFORMATION_SCHEMA.ROUTINES
                    WHERE 
                        ROUTINE_TYPE = 'PROCEDURE'
                    ORDER BY 
                        ROUTINE_SCHEMA, ROUTINE_NAME
                `);
                
                // Format as markdown list grouped by schema
                let markdown = `# Database Stored Procedures\n\n`;
                
                // Group by schema
                const procsBySchema = {};
                result.recordset.forEach(proc => {
                    if (!procsBySchema[proc.ROUTINE_SCHEMA]) {
                        procsBySchema[proc.ROUTINE_SCHEMA] = [];
                    }
                    procsBySchema[proc.ROUTINE_SCHEMA].push(proc.ROUTINE_NAME);
                });
                
                // Add procedures by schema
                for (const [schema, procs] of Object.entries(procsBySchema)) {
                    markdown += `## ${schema} Schema\n\n`;
                    procs.forEach(proc => {
                        markdown += `- ${proc}\n`;
                    });
                    markdown += '\n';
                }
                
                logger.info(`Retrieved ${result.recordset.length} stored procedures`);
                
                return {
                    contents: [{
                        uri: uri.href,
                        text: markdown
                    }]
                };
            } catch (err) {
                logger.error(`Error retrieving stored procedures: ${err.message}`);
                throw err;
            }
        }
    );
}

/**
 * Register the functions list resource
 * @param {object} server - MCP server instance
 */
function registerFunctionsListResource(server) {
    server.resource(
        "functions",
        "functions://list",
        async (uri) => {
            try {
                logger.info('Fetching functions list...');
                
                const result = await executeQuery(`
                    SELECT 
                        ROUTINE_SCHEMA,
                        ROUTINE_NAME,
                        DATA_TYPE AS RETURN_TYPE
                    FROM 
                        INFORMATION_SCHEMA.ROUTINES
                    WHERE 
                        ROUTINE_TYPE = 'FUNCTION'
                    ORDER BY 
                        ROUTINE_SCHEMA, ROUTINE_NAME
                `);
                
                // Format as markdown list grouped by schema
                let markdown = `# Database Functions\n\n`;
                
                // Group by schema
                const funcsBySchema = {};
                result.recordset.forEach(func => {
                    if (!funcsBySchema[func.ROUTINE_SCHEMA]) {
                        funcsBySchema[func.ROUTINE_SCHEMA] = [];
                    }
                    funcsBySchema[func.ROUTINE_SCHEMA].push({
                        name: func.ROUTINE_NAME,
                        returnType: func.RETURN_TYPE
                    });
                });
                
                // Add functions by schema
                for (const [schema, funcs] of Object.entries(funcsBySchema)) {
                    markdown += `## ${schema} Schema\n\n`;
                    markdown += '| Function | Return Type |\n';
                    markdown += '|----------|------------|\n';
                    
                    funcs.forEach(func => {
                        markdown += `| ${func.name} | ${func.returnType} |\n`;
                    });
                    
                    markdown += '\n';
                }
                
                logger.info(`Retrieved ${result.recordset.length} functions`);
                
                return {
                    contents: [{
                        uri: uri.href,
                        text: markdown
                    }]
                };
            } catch (err) {
                logger.error(`Error retrieving functions: ${err.message}`);
                throw err;
            }
        }
    );
}

/**
 * Register the views list resource
 * @param {object} server - MCP server instance
 */
function registerViewsListResource(server) {
    server.resource(
        "views",
        "views://list",
        async (uri) => {
            try {
                logger.info('Fetching views list...');
                
                const result = await executeQuery(`
                    SELECT 
                        TABLE_SCHEMA,
                        TABLE_NAME
                    FROM 
                        INFORMATION_SCHEMA.VIEWS
                    ORDER BY 
                        TABLE_SCHEMA, TABLE_NAME
                `);
                
                // Format as markdown list grouped by schema
                let markdown = `# Database Views\n\n`;
                
                // Group by schema
                const viewsBySchema = {};
                result.recordset.forEach(view => {
                    if (!viewsBySchema[view.TABLE_SCHEMA]) {
                        viewsBySchema[view.TABLE_SCHEMA] = [];
                    }
                    viewsBySchema[view.TABLE_SCHEMA].push(view.TABLE_NAME);
                });
                
                // Add views by schema
                for (const [schema, views] of Object.entries(viewsBySchema)) {
                    markdown += `## ${schema} Schema\n\n`;
                    views.forEach(view => {
                        markdown += `- ${view}\n`;
                    });
                    markdown += '\n';
                }
                
                logger.info(`Retrieved ${result.recordset.length} views`);
                
                return {
                    contents: [{
                        uri: uri.href,
                        text: markdown
                    }]
                };
            } catch (err) {
                logger.error(`Error retrieving views: ${err.message}`);
                throw err;
            }
        }
    );
}

/**
 * Register the indexes list resource
 * @param {object} server - MCP server instance
 */
function registerIndexesListResource(server) {
    server.resource(
        "indexes",
        "indexes://list",
        async (uri) => {
            try {
                logger.info('Fetching indexes list...');
                
                const result = await executeQuery(`
                    SELECT 
                        s.name AS SchemaName,
                        t.name AS TableName,
                        i.name AS IndexName,
                        i.type_desc AS IndexType,
                        i.is_unique AS IsUnique,
                        i.is_primary_key AS IsPrimaryKey
                    FROM 
                        sys.indexes i
                    INNER JOIN 
                        sys.tables t ON i.object_id = t.object_id
                    INNER JOIN 
                        sys.schemas s ON t.schema_id = s.schema_id
                    WHERE 
                        i.name IS NOT NULL
                    ORDER BY 
                        s.name, t.name, i.name
                `);
                
                // Format as markdown table
                let markdown = `# Database Indexes\n\n`;
                
                // Group by table
                const indexesByTable = {};
                result.recordset.forEach(idx => {
                    const tableKey = `${idx.SchemaName}.${idx.TableName}`;
                    if (!indexesByTable[tableKey]) {
                        indexesByTable[tableKey] = [];
                    }
                    indexesByTable[tableKey].push({
                        name: idx.IndexName,
                        type: idx.IndexType,
                        isUnique: idx.IsUnique,
                        isPrimaryKey: idx.IsPrimaryKey
                    });
                });
                
                // Add indexes by table
                for (const [table, indexes] of Object.entries(indexesByTable)) {
                    markdown += `## ${table}\n\n`;
                    markdown += '| Index Name | Type | Unique | Primary Key |\n';
                    markdown += '|------------|------|--------|------------|\n';
                    
                    indexes.forEach(idx => {
                        markdown += `| ${idx.name} | ${idx.type} | ${idx.isUnique ? 'Yes' : 'No'} | ${idx.isPrimaryKey ? 'Yes' : 'No'} |\n`;
                    });
                    
                    markdown += '\n';
                }
                
                logger.info(`Retrieved ${result.recordset.length} indexes`);
                
                return {
                    contents: [{
                        uri: uri.href,
                        text: markdown
                    }]
                };
            } catch (err) {
                logger.error(`Error retrieving indexes: ${err.message}`);
                throw err;
            }
        }
    );
}

/**
 * Register the AI schema resource
 * @param {object} server - MCP server instance
 */
function registerAiSchemaResource(server) {
    server.resource(
        "ai-schema",
        "ai-schema://database",
        async (uri) => {
            try {
                logger.info('Generating AI-friendly database schema...');
                
                // Get tables
                const tablesResult = await executeQuery(`
                    SELECT 
                        TABLE_SCHEMA,
                        TABLE_NAME
                    FROM 
                        INFORMATION_SCHEMA.TABLES
                    WHERE
                        TABLE_TYPE = 'BASE TABLE'
                    ORDER BY 
                        TABLE_SCHEMA, TABLE_NAME
                `);
                
                // Generate a comprehensive schema description for AI
                let aiSchemaText = '# AI Assistant Database Guide\n\n';
                aiSchemaText += 'This is a guide for AI assistants to interact with this SQL Server database.\n\n';
                
                // Add tables section
                aiSchemaText += '## Available Tables\n\n';
                
                // Group by schema
                const tablesBySchema = {};
                tablesResult.recordset.forEach(table => {
                    if (!tablesBySchema[table.TABLE_SCHEMA]) {
                        tablesBySchema[table.TABLE_SCHEMA] = [];
                    }
                    tablesBySchema[table.TABLE_SCHEMA].push(table.TABLE_NAME);
                });
                
                // Add tables by schema
                for (const [schema, tables] of Object.entries(tablesBySchema)) {
                    aiSchemaText += `### ${schema} Schema\n\n`;
                    aiSchemaText += '```\n';
                    tables.forEach(table => {
                        aiSchemaText += `${table}\n`;
                    });
                    aiSchemaText += '```\n\n';
                }
                
                // Add usage examples
                aiSchemaText += '## MCP Usage Examples\n\n';
                
                aiSchemaText += '### Listing Tables\n';
                aiSchemaText += 'To list tables, use the `tables://list` resource:\n';
                aiSchemaText += '```javascript\n';
                aiSchemaText += 'mcp__resources_read("tables://list")\n';
                aiSchemaText += '```\n\n';
                
                aiSchemaText += '### Executing Queries\n';
                aiSchemaText += 'To execute a SQL query, use the `execute-query` tool:\n';
                aiSchemaText += '```javascript\n';
                aiSchemaText += 'mcp__execute_query({ sql: "SELECT TOP 100 * FROM [table_name]" })\n';
                aiSchemaText += '```\n\n';
                
                aiSchemaText += '### Getting Table Details\n';
                aiSchemaText += 'To get details about a specific table, use the `table-details` tool:\n';
                aiSchemaText += '```javascript\n';
                aiSchemaText += 'mcp__table_details({ tableName: "table_name" })\n';
                aiSchemaText += '```\n\n';
                
                aiSchemaText += '## Best Practices for AI Assistants\n\n';
                aiSchemaText += '1. Always check table existence before querying\n';
                aiSchemaText += '2. Use `SELECT TOP N` for safety when exploring large tables\n';
                aiSchemaText += '3. Explore table schema with `table-details` before constructing complex queries\n';
                aiSchemaText += '4. Use `discover-database()` to get a comprehensive overview\n';
                
                logger.info('AI-friendly schema generated');
                
                return {
                    contents: [{
                        uri: uri.href,
                        text: aiSchemaText
                    }]
                };
            } catch (err) {
                logger.error(`Error generating AI schema: ${err.message}`);
                throw err;
            }
        }
    );
}

/**
 * Register the discovery resource
 * @param {object} server - MCP server instance
 */
function registerDiscoveryResource(server) {
    server.resource(
        "discovery",
        "discovery://tables",
        async (uri) => {
            try {
                logger.info('Generating table discovery guide...');
                
                // Get tables with sample data for better understanding
                const tablesResult = await executeQuery(`
                    SELECT 
                        TABLE_SCHEMA,
                        TABLE_NAME,
                        TABLE_TYPE
                    FROM 
                        INFORMATION_SCHEMA.TABLES
                    WHERE
                        TABLE_TYPE = 'BASE TABLE'
                    ORDER BY 
                        TABLE_SCHEMA, TABLE_NAME
                `);
                
                // Get a sample of common tables with row counts for context
                const sampleTablesWithRowCounts = [];
                
                // Get row counts for the first 5 tables (limited to avoid performance issues)
                for (let i = 0; i < Math.min(5, tablesResult.recordset.length); i++) {
                    const tableSchema = tablesResult.recordset[i].TABLE_SCHEMA;
                    const tableName = tablesResult.recordset[i].TABLE_NAME;
                    
                    try {
                        const countResult = await executeQuery(`
                            SELECT 
                                COUNT(*) AS TotalRows
                            FROM 
                                [${tableSchema}].[${tableName}]
                        `, {
                            schemaName: tableSchema,
                            tableName: tableName
                        });
                        
                        const rowCount = countResult.recordset[0].TotalRows || 0;
                        sampleTablesWithRowCounts.push({ 
                            schema: tableSchema, 
                            name: tableName, 
                            rowCount 
                        });
                    } catch (err) {
                        logger.error(`Error getting row count for ${tableSchema}.${tableName}: ${err.message}`);
                        sampleTablesWithRowCounts.push({ 
                            schema: tableSchema, 
                            name: tableName, 
                            rowCount: "Unknown" 
                        });
                    }
                }
                
                // Generate a comprehensive table discovery guide
                let discoveryText = '# Table Discovery Guide\n\n';
                discoveryText += 'This guide will help you discover and explore tables in this SQL Server database.\n\n';
                
                // Step 1: List all tables
                discoveryText += '## Step 1: List All Tables\n\n';
                discoveryText += 'To get a complete list of all tables in the database, use this command:\n\n';
                discoveryText += '```javascript\n';
                discoveryText += 'mcp__execute_query({ sql: "SELECT TOP 100 TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = \'BASE TABLE\' ORDER BY TABLE_SCHEMA, TABLE_NAME" })\n';
                discoveryText += '```\n\n';
                
                // Step 2: Explore table structure
                discoveryText += '## Step 2: Explore Table Structure\n\n';
                discoveryText += 'Once you have table names, explore their structure using either table-details or SQL:\n\n';
                discoveryText += '```javascript\n';
                discoveryText += '// Option 1: Using the dedicated tool\n';
                if (sampleTablesWithRowCounts.length > 0) {
                    discoveryText += `mcp__table_details({ tableName: "${sampleTablesWithRowCounts[0].name}" })\n\n`;
                } else {
                    discoveryText += `mcp__table_details({ tableName: "example_table_name" })\n\n`;
                }
                discoveryText += '// Option 2: Using SQL query\n';
                discoveryText += 'mcp__execute_query({ sql: "SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = \'example_table_name\' ORDER BY ORDINAL_POSITION" })\n';
                discoveryText += '```\n\n';
                
                // Step 3: Query with example
                discoveryText += '## Step 3: Execute Safe Queries\n\n';
                discoveryText += 'After discovering tables and their structure, execute queries with TOP clause for safety:\n\n';
                discoveryText += '```javascript\n';
                discoveryText += `// Example query for a sample table\n`;
                if (sampleTablesWithRowCounts.length > 0) {
                    discoveryText += `mcp__execute_query({ sql: "SELECT TOP 100 * FROM [${sampleTablesWithRowCounts[0].schema}].[${sampleTablesWithRowCounts[0].name}]" })\n`;
                } else {
                    discoveryText += `mcp__execute_query({ sql: "SELECT TOP 100 * FROM [schema].[table_name]" })\n`;
                }
                discoveryText += '```\n\n';
                
                // Sample information about tables
                discoveryText += '## Sample Tables Information\n\n';
                discoveryText += 'Here are some tables in this database with approximate row counts:\n\n';
                discoveryText += '| Schema | Table Name | Approximate Row Count |\n';
                discoveryText += '|--------|------------|----------------------|\n';
                
                sampleTablesWithRowCounts.forEach(table => {
                    discoveryText += `| ${table.schema} | ${table.name} | ${table.rowCount} |\n`;
                });
                
                discoveryText += '\n## Total Tables Count\n\n';
                discoveryText += `This database contains ${tablesResult.recordset.length} tables in total.\n\n`;
                
                discoveryText += '## Best Practices for Table Discovery\n\n';
                discoveryText += '1. Always start with listing available tables\n';
                discoveryText += '2. Examine table structure before querying\n';
                discoveryText += '3. Use TOP clauses for initial queries to avoid performance issues\n';
                discoveryText += '4. For large tables, filter with WHERE clauses when possible\n';
                
                logger.info('Table discovery guide generated');
                
                return {
                    contents: [{
                        uri: uri.href,
                        text: discoveryText
                    }]
                };
            } catch (err) {
                logger.error(`Error generating table discovery guide: ${err.message}`);
                throw err;
            }
        }
    );
}

/**
 * Format schema data into human-readable text
 * @param {Array} records - Records from INFORMATION_SCHEMA.COLUMNS
 * @returns {string} - Formatted markdown
 */
function formatSchemaData(records) {
    const tables = {};
    
    // Group columns by table
    records.forEach(record => {
        if (!tables[record.TABLE_NAME]) {
            tables[record.TABLE_NAME] = [];
        }
        
        tables[record.TABLE_NAME].push({
            name: record.COLUMN_NAME,
            type: record.DATA_TYPE,
            length: record.CHARACTER_MAXIMUM_LENGTH,
            nullable: record.IS_NULLABLE === 'YES',
            default: record.COLUMN_DEFAULT
        });
    });
    
    // Format as text
    let output = '# Database Schema\n\n';
    
    for (const [tableName, columns] of Object.entries(tables)) {
        output += `## Table: ${tableName}\n\n`;
        output += '| Column | Type | Length | Nullable | Default |\n';
        output += '|--------|------|--------|----------|--------|\n';
        
        columns.forEach(col => {
            const length = col.length !== null ? col.length : 'N/A';
            const defaultVal = col.default !== null ? col.default : 'N/A';
            
            output += `| ${col.name} | ${col.type} | ${length} | ${col.nullable ? 'Yes' : 'No'} | ${defaultVal} |\n`;
        });
        
        output += '\n';
    }
    
    return output;
}
