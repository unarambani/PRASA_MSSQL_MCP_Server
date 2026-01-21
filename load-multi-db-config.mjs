#!/usr/bin/env node

/**
 * Multi-Database Configuration Loader
 * 
 * This script helps you load multiple database configurations from a JSON file
 * and register them with your MCP server.
 * 
 * SECURITY: Supports environment variable substitution for credentials
 * Use ${ENV_VAR_NAME} in your JSON config to reference environment variables
 * 
 * Usage:
 * 1. Copy multi-db-config.example.json to multi-db-config.json
 * 2. Edit multi-db-config.json with your database connection details
 * 3. Set environment variables for passwords (e.g., KZN_PASSWORD=your_password)
 * 4. Run: node load-multi-db-config.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerDatabase } from './Lib/database.mjs';
import { logger } from './Lib/logger.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_FILE = path.join(__dirname, 'multi-db-config.json');
const EXAMPLE_FILE = path.join(__dirname, 'multi-db-config.example.json');

/**
 * Substitute environment variables in a string
 * Supports ${VAR_NAME} syntax
 * @param {string} str - String that may contain environment variable references
 * @returns {string} - String with environment variables substituted
 */
function substituteEnvironmentVariables(str) {
    if (typeof str !== 'string') return str;

    return str.replace(/\$\{([^}]+)\}/g, (match, envVar) => {
        const value = process.env[envVar];
        if (value === undefined) {
            logger.warn(`Environment variable ${envVar} is not set`);
            return match; // Return original if not found
        }
        return value;
    });
}

/**
 * Convert string values to appropriate types based on field name
 * @param {string} key - The configuration key
 * @param {any} value - The value to convert
 * @returns {any} - Converted value
 */
function convertToProperType(key, value) {
    if (typeof value !== 'string') return value;

    // Convert port to number
    if (key === 'port') {
        const num = parseInt(value);
        return isNaN(num) ? 1433 : num;
    }

    // Return as string for everything else (server, database, user, password)
    return value;
}

/**
 * Recursively substitute environment variables in an object and convert types
 * @param {any} obj - Object to process
 * @param {string} parentKey - Parent key for context
 * @returns {any} - Object with environment variables substituted and types converted
 */
function processEnvironmentVariables(obj, parentKey = '') {
    if (typeof obj === 'string') {
        const substituted = substituteEnvironmentVariables(obj);
        return convertToProperType(parentKey, substituted);
    } else if (Array.isArray(obj)) {
        return obj.map(item => processEnvironmentVariables(item, parentKey));
    } else if (obj && typeof obj === 'object') {
        const processed = {};
        for (const [key, value] of Object.entries(obj)) {
            processed[key] = processEnvironmentVariables(value, key);
        }
        return processed;
    }
    return obj;
}

/**
 * Load and register multiple database configurations
 */
async function loadMultiDatabaseConfig() {
    try {
        // Check if config file exists
        if (!fs.existsSync(CONFIG_FILE)) {
            console.error('❌ Configuration file not found: multi-db-config.json');

            if (fs.existsSync(EXAMPLE_FILE)) {
                console.error('📝 Example file found. Run: npm run setup-multi-db');
                console.error('   Then edit multi-db-config.json with your database details');
            }

            return false;
        }

        // Read and parse configuration
        const configContent = fs.readFileSync(CONFIG_FILE, 'utf8');
        const rawConfig = JSON.parse(configContent);

        // Process environment variables and convert types
        const config = processEnvironmentVariables(rawConfig);

        if (!config.databases || !Array.isArray(config.databases)) {
            console.error('❌ Invalid configuration: "databases" array not found');
            return false;
        }

        console.error(`📋 Loading ${config.databases.length} database configurations...`);

        let successCount = 0;
        let failureCount = 0;
        const missingEnvVars = new Set();

        // Register each database
        for (const dbConfig of config.databases) {
            try {
                // Validate required fields
                const requiredFields = ['id', 'server', 'database', 'user', 'password'];
                const missingFields = requiredFields.filter(field => !dbConfig[field]);

                if (missingFields.length > 0) {
                    console.error(`❌ ${dbConfig.id || 'Unknown'}: Missing required fields: ${missingFields.join(', ')}`);
                    failureCount++;
                    continue;
                }

                // Check for unresolved environment variables
                const stillHasEnvVars = requiredFields.some(field =>
                    typeof dbConfig[field] === 'string' && dbConfig[field].includes('${')
                );

                if (stillHasEnvVars) {
                    const envVarMatches = JSON.stringify(dbConfig).match(/\$\{([^}]+)\}/g);
                    if (envVarMatches) {
                        envVarMatches.forEach(match => {
                            const envVar = match.slice(2, -1); // Remove ${ and }
                            missingEnvVars.add(envVar);
                        });
                    }
                    console.error(`❌ ${dbConfig.id}: Unresolved environment variables found`);
                    failureCount++;
                    continue;
                }

                // Prepare config for registration with proper types
                const dbConnectionConfig = {
                    user: dbConfig.user,
                    password: dbConfig.password,
                    server: dbConfig.server,
                    database: dbConfig.database,
                    port: dbConfig.port || 1433,
                    options: {
                        encrypt: dbConfig.options?.encrypt !== undefined ? dbConfig.options.encrypt : false,
                        trustServerCertificate: dbConfig.options?.trustServerCertificate !== undefined ? dbConfig.options.trustServerCertificate : true,
                        connectionTimeout: dbConfig.options?.connectionTimeout || 15000,
                        requestTimeout: dbConfig.options?.requestTimeout || 15000,
                        pool: {
                            max: dbConfig.options?.pool?.max || 10,
                            min: dbConfig.options?.pool?.min || 0,
                            idleTimeoutMillis: dbConfig.options?.pool?.idleTimeoutMillis || 30000
                        }
                    }
                };

                // Log configuration details (without sensitive info)
                logger.info(`Processing ${dbConfig.id}: ${dbConfig.server}:${dbConnectionConfig.port}/${dbConnectionConfig.database} (encrypt: ${dbConnectionConfig.options.encrypt})`);

                // Register the database
                const success = registerDatabase(dbConfig.id, dbConnectionConfig);

                if (success) {
                    console.error(`✅ ${dbConfig.id}: ${dbConfig.name || dbConfig.id} (${dbConfig.server}/${dbConfig.database})`);
                    successCount++;
                } else {
                    console.error(`❌ ${dbConfig.id}: Registration failed`);
                    failureCount++;
                }

            } catch (err) {
                console.error(`❌ ${dbConfig.id || 'Unknown'}: ${err.message}`);
                failureCount++;
            }
        }

        // Print summary
        console.error('\n📊 Registration Summary:');
        console.error(`   ✅ Successful: ${successCount}`);
        console.error(`   ❌ Failed: ${failureCount}`);

        // Show missing environment variables
        if (missingEnvVars.size > 0) {
            console.error('\n🔐 Missing Environment Variables:');
            const sortedVars = Array.from(missingEnvVars).sort();
            for (const envVar of sortedVars) {
                console.error(`   export ${envVar}="your_value_here"`);
            }
            console.error('\n💡 Tip: Copy env.example to .env and fill in your values:');
            console.error('   cp env.example .env');
            console.error('   chmod 600 .env');
            console.error('   # Edit .env with your actual values');
        }

        return successCount > 0;

    } catch (err) {
        console.error('❌ Failed to load multi-database configuration:', err.message);
        return false;
    }
}

/**
 * Export the function for use in other modules
 * @returns {Promise<boolean>} - True if at least one database was loaded successfully
 */
export { loadMultiDatabaseConfig };

// If run directly, load the configuration
if (import.meta.url === `file://${process.argv[1]}`) {
    loadMultiDatabaseConfig().then(success => {
        if (success) {
            console.error('\n🎉 Multi-database configuration loaded successfully!');
            console.error('   You can now use the registered databases in your MCP server.');
        } else {
            console.error('\n❌ Failed to load any database configurations.');
            process.exit(1);
        }
    });
} 