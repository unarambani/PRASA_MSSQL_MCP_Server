// Lib/pagination.mjs - Pagination utilities for SQL Server
import { logger } from './logger.mjs';

/**
 * Transform a SQL query to support cursor-based pagination
 * @param {string} sql - Original SQL query
 * @param {Object} options - Pagination options
 * @param {string} options.cursorField - Field to use for cursor
 * @param {number} options.pageSize - Number of rows per page
 * @param {string} options.cursor - Base64 encoded cursor string
 * @param {Object} options.parameters - Existing query parameters
 * @returns {Object} - Object with transformed SQL and updated parameters
 */
export function paginateQuery(sql, options) {
    const {
        cursorField = null,
        pageSize = 100,
        cursor = null,
        parameters = {},
        defaultCursorField = 'id'
    } = options;

    // Make a copy of the parameters to avoid mutation
    const updatedParameters = { ...parameters };
    let paginatedSql = sql.trim();

    // Check if SQL already has ORDER BY
    const hasOrderBy = /\border\s+by\b/i.test(paginatedSql);

    // Extract the ORDER BY clause if it exists
    let orderByClause = '';
    let actualCursorField = cursorField;

    if (hasOrderBy) {
        // Extract the ORDER BY clause to determine the cursor field if not provided
        const orderByMatch = paginatedSql.match(/ORDER\s+BY\s+([^)]+?)(?:\s+OFFSET|\s+FOR\s+JSON|\s+FOR\s+XML|\s*$)/i);
        if (orderByMatch) {
            orderByClause = orderByMatch[1].trim();

            // If no cursor field provided, use the first field in ORDER BY
            if (!actualCursorField) {
                const firstOrderField = orderByClause.split(',')[0].trim();
                // Extract just the field name, not the ASC/DESC part
                actualCursorField = firstOrderField.split(/\s+/)[0].replace(/\[|\]/g, '');
            }
        }
    } else if (actualCursorField) {
        // If no ORDER BY but cursor field provided, add ORDER BY
        orderByClause = `${actualCursorField} ASC`;
        paginatedSql = `${paginatedSql} ORDER BY ${orderByClause}`;
    } else {
        // No ORDER BY and no cursor field, use default and add ORDER BY
        actualCursorField = defaultCursorField;
        orderByClause = `${actualCursorField} ASC`;
        paginatedSql = `${paginatedSql} ORDER BY ${orderByClause}`;

        logger.warn(`No ORDER BY or cursor field provided, using default: ${defaultCursorField}`);
    }

    // Process cursor if provided - must be inserted BEFORE ORDER BY
    if (cursor) {
        try {
            // Decode the cursor
            const decodedCursor = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
            const { field, value, operator } = decodedCursor;

            // Validate cursor
            if (!field || value === undefined) {
                throw new Error('Invalid cursor format');
            }

            const fieldToUse = field || actualCursorField;
            const comparator = operator || '>';
            const cursorParamName = `cursor_${fieldToUse.replace(/[^a-zA-Z0-9_]/g, '_')}`;

            // Find the ORDER BY position to insert the cursor condition before it
            const orderByMatch = paginatedSql.match(/\bORDER\s+BY\b/i);

            if (orderByMatch) {
                const orderByIndex = paginatedSql.toLowerCase().indexOf(orderByMatch[0].toLowerCase());
                const beforeOrderBy = paginatedSql.substring(0, orderByIndex).trim();
                const orderByAndAfter = paginatedSql.substring(orderByIndex);

                // Determine if we need WHERE or AND
                const whereClause = beforeOrderBy.toLowerCase().includes('where') ? 'AND' : 'WHERE';

                // Insert the cursor condition before ORDER BY
                paginatedSql = `${beforeOrderBy} ${whereClause} [${fieldToUse}] ${comparator} @${cursorParamName} ${orderByAndAfter}`;
            } else {
                // No ORDER BY found, just append the WHERE clause
                const whereClause = paginatedSql.toLowerCase().includes('where') ? 'AND' : 'WHERE';
                paginatedSql = `${paginatedSql} ${whereClause} [${fieldToUse}] ${comparator} @${cursorParamName}`;
            }

            // Add cursor value as a parameter
            updatedParameters[cursorParamName] = value;

            logger.info(`Applied cursor: ${field} ${comparator} ${value}`);
        } catch (err) {
            logger.error(`Error processing cursor: ${err.message}`);
            // Continue without cursor if invalid
        }
    }

    // Add OFFSET/FETCH for SQL Server pagination syntax if not already present
    // Note: OFFSET/FETCH requires ORDER BY and must come after it
    if (!paginatedSql.toLowerCase().includes('offset') && !paginatedSql.toLowerCase().includes('fetch')) {
        // Check if query uses TOP clause - if so, we can't add OFFSET/FETCH
        if (!/\bTOP\s+\d+/i.test(paginatedSql)) {
            paginatedSql = `${paginatedSql} OFFSET 0 ROWS FETCH NEXT ${pageSize} ROWS ONLY`;
        }
    }

    return {
        paginatedSql,
        parameters: updatedParameters,
        cursorField: actualCursorField
    };
}

/**
 * Generate a cursor for the next page based on the last row of results
 * @param {Object} lastRow - Last row in the current page
 * @param {string} cursorField - Field to use for cursor
 * @returns {string|null} - Base64 encoded cursor or null if no cursor can be generated
 */
export function generateNextCursor(lastRow, cursorField) {
    if (!lastRow || !cursorField) return null;

    // Get the value from the last row
    const value = lastRow[cursorField];
    if (value === undefined) {
        logger.warn(`Cursor field "${cursorField}" not found in result row`);
        return null;
    }

    // Create cursor object
    const cursor = {
        field: cursorField,
        value: value,
        operator: '>'
    };

    // Encode as base64 for URL-friendliness
    return Buffer.from(JSON.stringify(cursor)).toString('base64');
}

/**
 * Generate a cursor for the previous page based on the first row of results
 * @param {Object} firstRow - First row in the current page
 * @param {string} cursorField - Field to use for cursor
 * @returns {string|null} - Base64 encoded cursor or null if no cursor can be generated
 */
export function generatePrevCursor(firstRow, cursorField) {
    if (!firstRow || !cursorField) return null;

    // Get the value from the first row
    const value = firstRow[cursorField];
    if (value === undefined) {
        logger.warn(`Cursor field "${cursorField}" not found in result row`);
        return null;
    }

    // Create cursor object
    const cursor = {
        field: cursorField,
        value: value,
        operator: '<=' // Use <= for backward pagination
    };

    // Encode as base64 for URL-friendliness
    return Buffer.from(JSON.stringify(cursor)).toString('base64');
}

/**
 * Decode a cursor to extract its components
 * @param {string} cursor - Base64 encoded cursor
 * @returns {Object|null} - Decoded cursor object or null if invalid
 */
export function decodeCursor(cursor) {
    if (!cursor) return null;

    try {
        return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    } catch (err) {
        logger.error(`Error decoding cursor: ${err.message}`);
        return null;
    }
}

/**
 * Format SQL pagination metadata as markdown text
 * @param {Object} pagination - Pagination metadata object
 * @param {string} sql - Original SQL query
 * @returns {string} - Formatted markdown text
 */
export function formatPaginationMetadata(pagination, sql) {
    const {
        pageSize,
        returnedRows,
        hasMore,
        nextCursor,
        prevCursor,
        cursorField
    } = pagination;

    let text = `## Pagination\n\n`;
    text += `- **Page Size**: ${pageSize}\n`;
    text += `- **Returned Rows**: ${returnedRows}\n`;
    text += `- **Has More**: ${hasMore ? 'Yes' : 'No'}\n`;

    if (cursorField) {
        text += `- **Cursor Field**: ${cursorField}\n`;
    }

    text += '\n';

    if (nextCursor) {
        text += `### Next Page\n\n`;
        text += `To fetch the next page, use:\n`;
        text += `\`\`\`javascript\n`;
        text += `mcp__execute_query({ 
  sql: ${JSON.stringify(sql)}, 
  pageSize: ${pageSize}, 
  cursor: "${nextCursor}",
  cursorField: "${cursorField}"
})\n`;
        text += `\`\`\`\n\n`;
    }

    if (prevCursor) {
        text += `### Previous Page\n\n`;
        text += `To fetch the previous page, use:\n`;
        text += `\`\`\`javascript\n`;
        text += `mcp__execute_query({ 
  sql: ${JSON.stringify(sql)}, 
  pageSize: ${pageSize}, 
  cursor: "${prevCursor}",
  cursorField: "${cursorField}"
})\n`;
        text += `\`\`\`\n`;
    }

    return text;
}

/**
 * Extract a default cursor field from a SQL query
 * @param {string} sql - SQL query
 * @returns {string} - Default cursor field or 'id' if none found
 */
export function extractDefaultCursorField(sql) {
    // Try to extract from ORDER BY clause
    const orderByMatch = sql.match(/ORDER\s+BY\s+([^)]+?)(?:\s+OFFSET|\s+FOR\s+JSON|\s+FOR\s+XML|\s*$)/i);

    if (orderByMatch) {
        const orderByClause = orderByMatch[1].trim();
        const firstOrderField = orderByClause.split(',')[0].trim();
        // Extract just the field name, not the ASC/DESC part
        return firstOrderField.split(/\s+/)[0].replace(/\[|\]/g, '');
    }

    // Try to extract from SELECT clause for potential primary key fields
    const commonIdFields = ['id', 'ID', 'Id', 'key', 'KEY', 'Key', 'primary_key', 'PrimaryKey'];
    const selectMatch = sql.match(/SELECT\s+(.+?)\s+FROM/is);

    if (selectMatch) {
        const selectClause = selectMatch[1].trim();
        // If not SELECT *, try to find ID fields
        if (selectClause !== '*') {
            const fields = selectClause.split(',').map(f => f.trim());

            // Check for common ID field names
            for (const idField of commonIdFields) {
                const matchingField = fields.find(f => {
                    const cleanField = f.split(/\s+AS\s+|\s+/).pop().replace(/\[|\]/g, '');
                    return cleanField.toLowerCase() === idField.toLowerCase();
                });

                if (matchingField) {
                    return matchingField.split(/\s+AS\s+|\s+/).pop().replace(/\[|\]/g, '');
                }
            }
        }
    }

    // Default to 'id' if no suitable field found
    return 'id';
}