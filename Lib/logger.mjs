// lib/logger.js - Logging utilities
import winston from 'winston';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';

// Get the directory name
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

// Configuration
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_FILE_PATH = process.env.LOG_FILE || path.join(__dirname, '../logs/mcp-server.log');
const LOG_FILE = path.isAbsolute(LOG_FILE_PATH) ? LOG_FILE_PATH : path.resolve(path.join(__dirname, '..'), LOG_FILE_PATH);
const LOG_MAX_SIZE = process.env.LOG_MAX_SIZE || '10m';
const LOG_MAX_FILES = parseInt(process.env.LOG_MAX_FILES, 10) || 5;
const LOG_FORMAT = process.env.LOG_FORMAT || 'json';

// Create logs directory if it doesn't exist
const logsDir = path.dirname(LOG_FILE);
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Define log formats
const logFormats = {
    console: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ level, message, timestamp, ...metadata }) => {
            let metaStr = '';
            if (Object.keys(metadata).length > 0 && metadata.service !== 'mcp-server') {
                metaStr = JSON.stringify(metadata);
            }
            return `[${timestamp}] ${level}: ${message} ${metaStr}`;
        })
    ),
    json: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    simple: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ level, message, timestamp }) => {
            return `[${timestamp}] ${level}: ${message}`;
        })
    )
};

const parseSizeToBytes = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(1, Math.floor(value));
    }

    if (typeof value !== 'string') {
        return 10 * 1024 * 1024;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return 10 * 1024 * 1024;
    }

    const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmg])?b?$/i);
    if (!match) {
        return 10 * 1024 * 1024;
    }

    const amount = Number.parseFloat(match[1]);
    if (!Number.isFinite(amount)) {
        return 10 * 1024 * 1024;
    }

    const unit = (match[2] || '').toLowerCase();
    const multiplier = unit === 'g' ? 1024 ** 3 : unit === 'm' ? 1024 ** 2 : unit === 'k' ? 1024 : 1;

    return Math.max(1, Math.floor(amount * multiplier));
};

const LOG_MAX_SIZE_BYTES = parseSizeToBytes(LOG_MAX_SIZE);

// Create Winston logger
export const logger = winston.createLogger({
    level: LOG_LEVEL,
    defaultMeta: { service: 'mcp-server' },
    format: logFormats[LOG_FORMAT] || logFormats.json,
    transports: [
        // Stream transport to stderr to avoid stdout corruption
        new winston.transports.Stream({
            stream: process.stderr
        }),

        // File transport with rotation
        new winston.transports.File({
            filename: LOG_FILE,
            maxsize: LOG_MAX_SIZE_BYTES,
            maxFiles: LOG_MAX_FILES,
            tailable: true
        })
    ],
    exitOnError: false // Don't crash on exception
});

// Create a stream object for Morgan HTTP logging
export const logStream = {
    write: message => {
        logger.http(message.trim());
    }
};

// Add request context middleware for Express
export const addRequestContext = (req, res, next) => {
    // Add a unique request ID if not present
    req.id = req.headers['x-request-id'] || crypto.randomUUID();

    // Add correlation ID for tracing
    const correlationId = req.headers['x-correlation-id'] || req.id;

    // Add request context to logger
    logger.defaultMeta = {
        ...logger.defaultMeta,
        requestId: req.id,
        correlationId,
        method: req.method,
        url: req.url
    };

    // Add response headers for tracing
    res.setHeader('X-Request-ID', req.id);
    res.setHeader('X-Correlation-ID', correlationId);

    next();
};

// Log uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
    logger.error(`Uncaught Exception: ${error.message}`, {
        stack: error.stack,
        name: error.name
    });

    // Only exit for truly fatal errors that prevent server operation
    const fatalErrors = ['EADDRINUSE', 'ERR_SOCKET_BAD_TYPE', 'ERR_SOCKET_ALREADY_BOUND'];
    if (fatalErrors.includes(error.code)) {
        logger.error('Fatal error - server cannot continue, exiting...');
        process.exit(1);
    }
    // For other errors, log but allow server to continue
    logger.warn('Server continuing after uncaught exception - some functionality may be affected');
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', {
        promise: String(promise),
        reason: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined
    });
    // Don't crash on unhandled rejection - log and continue
});

// Export logger
export default logger;
