# VSCode MCP Server Setup Guide

This guide explains how to configure and use the MSSQL MCP Server with Visual Studio Code.

## Prerequisites

- Visual Studio Code 1.108 or later
- GitHub Copilot extension installed
- Node.js 16+ installed
- Access to SQL Server databases

## Installation Steps

### 1. Clone and Setup

```bash
# Clone the repository
git clone https://github.com/unarambani/PRASA_MSSQL_MCP_Server.git
cd mssql-mcp-server

# Install dependencies
npm install

# Copy environment template and configure
cp .env.example .env

# Edit .env with your database credentials
nano .env
```

### 2. Configure Environment Variables

Edit the `.env` file with your database configuration:

```env
# Database Configuration
DB_SERVER=your-sql-server-host
DB_PORT=1433
DB_DATABASE=your-database-name
DB_USER=your-username
DB_PASSWORD=your-strong-password
DB_ENCRYPT=false
DB_TRUST_SERVER_CERT=true
```

### 3. VSCode Configuration

The repository includes a `.vscode/mcp.json` file that configures VSCode to use this MCP server. The configuration uses environment variables from your `.env` file.

**Important**: VSCode will automatically use the `.vscode/mcp.json` configuration when you open the project in VSCode.

### 4. Restart VSCode

After configuring your environment variables:

1. Close and reopen VSCode, or
2. Run the **Developer: Reload Window** command (Ctrl+Shift+P → "Reload Window")

## Verifying the Setup

### Check MCP Server Status

1. Open VSCode Command Palette (Ctrl+Shift+P)
2. Run **MCP: List Servers**
3. You should see "mssql-mcp-server" in the list
4. The server status should show as running (green indicator)

### Test the Connection

1. Open the Chat view (Ctrl+Shift+C or Cmd+Shift+C on Mac)
2. Enable Agent Mode if prompted
3. Try a simple query:

```
Can you connect to the database and list all tables?
```

## Using MCP Tools in VSCode

Once configured, you can use the following tools in VSCode's chat:

### Available Tools

- `mcp_SQL_execute_query` - Execute SQL queries
- `mcp_SQL_discover_database` - Explore database structure
- `mcp_SQL_table_details` - Get table schema information
- `mcp_SQL_list_tables` - List all tables in database
- `mcp_SQL_list_databases` - List available databases

### Example Usage

**In Chat:**
```
Query the users table to show me the first 10 rows
```

**In Agent Mode:**
```
I need to check the database schema for the customers table
```

## Troubleshooting

### Server Not Starting

1. Check your `.env` configuration
2. Verify database credentials
3. Check VSCode output logs:
   - Run **MCP: List Servers**
   - Select "mssql-mcp-server"
   - Choose "Show Output"

### Connection Errors

1. Verify SQL Server is running and accessible
2. Check firewall settings
3. Ensure network connectivity
4. Validate credentials in `.env`

### Environment Variables Not Loading

Make sure your `.env` file is in the project root and contains all required variables. VSCode MCP configuration references environment variables using the `${env:VAR_NAME}` syntax.

### Multi-Database Setup

For multi-database configuration, create a `multi-db-config.json` file:

```json
{
  "databases": [
    {
      "id": "primary",
      "name": "Primary Database",
      "server": "localhost",
      "database": "master",
      "user": "${DB_USER}",
      "password": "${DB_PASSWORD}",
      "port": 1433
    }
  ]
}
```

## Development Mode

When developing or debugging the MCP server:

1. The `.vscode/mcp.json` includes development settings
2. Changes to server code will automatically restart the server
3. Check the MCP output channel for detailed logs

## Security Considerations

- Never commit `.env` files with real credentials
- Use environment variables for sensitive data
- The MCP server runs locally in stdio mode for security
- Database credentials are not transmitted externally

## File Structure

```
mssql-mcp-server/
├── .vscode/
│   └── mcp.json          # VSCode MCP configuration
├── .env                   # Your database credentials (not committed)
├── server.mjs            # MCP Server implementation
├── Lib/
│   ├── database.mjs      # Database connection management
│   ├── tools.mjs         # Tool implementations
│   ├── resources.mjs     # Resource implementations
│   └── prompts.mjs       # Prompt implementations
└── package.json          # Project dependencies
```

## Support

For issues with:
- **MCP Server**: Check VSCode MCP output logs
- **Database Connection**: Verify `.env` configuration
- **VSCode Integration**: Review VSCode documentation

## Related Documentation

- [VSCode MCP Documentation](https://code.visualstudio.com/api/extension-guides/mcp)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [VSCode MCP Servers Guide](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)
