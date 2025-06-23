# Team Setup Guide - MSSQL MCP Server

This guide will help your team members quickly set up and configure the MSSQL MCP Server on their local machines.

## 🚀 Quick Setup (5 minutes)

### Prerequisites
- **Node.js** (version 16 or higher) - [Download here](https://nodejs.org/)
- **Git** - [Download here](https://git-scm.com/)
- Access to your organization's SQL Server databases

### Step 1: Clone the Repository
```bash
# Clone the repository
git clone [YOUR_REPO_URL_HERE]
cd mssql-mcp-server

# Install dependencies
npm install
```

### Step 2: Environment Setup
```bash
# Create your environment file (this will be ignored by git)
npm run setup-env

# Create your multi-database configuration
npm run setup-multi-db
```

### Step 3: Configure Your Databases

#### Option A: Single Database Setup
Edit the `.env` file:
```bash
# Database Configuration
DB_USER=your_username
DB_PASSWORD=your_password
DB_SERVER=your_server_name_or_ip
DB_DATABASE=your_database_name
DB_PORT=1433

# Server Configuration
PORT=3333
HOST=localhost
TRANSPORT=stdio
SERVER_URL=http://localhost:3333
DEBUG=false
```

#### Option B: Multi-Database Setup (Recommended)
Edit `multi-db-config.json` with your regional databases:
```json
{
  "databases": [
    {
      "id": "kzn",
      "name": "KwaZulu-Natal",
      "server": "your_kzn_server",
      "database": "your_kzn_database",
      "user": "your_username",
      "password": "your_password",
      "port": 1433,
      "options": {
        "encrypt": true,
        "trustServerCertificate": true,
        "connectionTimeout": 15000,
        "requestTimeout": 15000
      }
    }
  ]
}
```

**For databases with named instances (like GP region):**
```json
{
  "id": "gp",
  "name": "Gauteng",
  "server": "your_server\\SQLPROD01",
  "database": "your_database",
  "user": "your_username",
  "password": "your_password",
  "port": 1433,
  "options": {
    "encrypt": true,
    "trustServerCertificate": true,
    "connectionTimeout": 15000,
    "requestTimeout": 15000
  }
}
```

### Step 4: Test Your Setup
```bash
# Test the connection
npm start

# In another terminal, test with the client
npm run client
```

### Step 5: Configure Cursor (Optional)
If you're using Cursor IDE:
```bash
# This will help configure Cursor to use the MCP server
node update-cursor-config.cjs
```

## 🔧 Configuration Details

### Environment Variables (.env)
- `DB_USER` - Your SQL Server username
- `DB_PASSWORD` - Your SQL Server password  
- `DB_SERVER` - Server hostname or IP address
- `DB_DATABASE` - Database name
- `DB_PORT` - Port number (usually 1433)
- `PORT` - Port for the MCP server (default: 3333)
- `HOST` - Host to bind to (default: localhost)
- `TRANSPORT` - Transport method (stdio or sse)
- `DEBUG` - Enable debug logging (true/false)

### Multi-Database Configuration
The `multi-db-config.json` file allows you to configure multiple databases:
- Each database needs a unique `id`
- Use environment variables for sensitive data
- For named instances, use `server\\instance` format
- SSL/TLS settings are in the `options` section

## 🚦 Getting Updates

### Updating to Latest Version
```bash
# Pull latest changes
git pull origin main

# Install any new dependencies
npm install

# Restart the server
npm start
```

### Checking for Updates
```bash
# Check what's changed
git log --oneline origin/main..HEAD

# See current version
npm run version
```

## 🧪 Testing Your Setup

### Basic Connection Test
```bash
# Start the server
npm start

# In another terminal, test with curl
curl -X POST http://localhost:3333/execute-query \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT @@VERSION", "returnResults": true}'
```

### Multi-Database Test
```bash
# Test specific database
curl -X POST http://localhost:3333/execute-query \
  -H "Content-Type: application/json" \
  -d '{"query": "SELECT COUNT(*) FROM ta_tim", "databaseId": "kzn", "returnResults": true}'
```

## 🔍 Troubleshooting

### Common Issues

**Connection Timeouts**
- Check firewall settings
- Verify server/port are correct
- For named instances, ensure you're using `server\\instance` format

**Certificate Errors**
- Set `trustServerCertificate: true` in your configuration
- Ensure `encrypt: true` is set correctly

**Permission Errors**
- Verify your SQL Server user has appropriate permissions
- Check that the database exists and is accessible

**Port Already in Use**
- Change the `PORT` in your `.env` file
- Kill any existing processes: `pkill -f "node.*server.mjs"`

### Debug Mode
Enable debug logging:
```bash
# In .env file
DEBUG=true

# Or start with debug
DEBUG=true npm start
```

### Getting Help
1. Check the logs in the console
2. Review the `SECURITY_GUIDELINES.md` for security best practices
3. Check `MULTI_DATABASE_SUPPORT.md` for multi-database specific help
4. Contact the team lead if you're still having issues

## 📋 Team Workflow

### Development
1. Create a feature branch: `git checkout -b feature/your-feature`
2. Make your changes
3. Test thoroughly
4. Create a pull request

### Configuration Management
- Never commit actual credentials to git
- Use environment variables for sensitive data
- Share configuration templates, not actual config files
- Keep `.env` and `multi-db-config.json` in `.gitignore`

### Deployment
- Pull latest changes
- Update dependencies: `npm install`
- Restart services
- Test connections

## 🛡️ Security Reminders

- Never commit passwords or connection strings
- Use strong, unique passwords for database accounts
- Regularly rotate credentials
- Keep the server updated
- Review `CREDENTIAL_SECURITY.md` for detailed security guidelines

---

## 🆘 Quick Reference

### Start Commands
```bash
npm start              # Start with stdio transport
npm run start:sse      # Start with HTTP/SSE transport
npm run client         # Interactive client
npm run load-multi-db  # Load multi-database config
```

### Configuration Commands
```bash
npm run setup-env      # Create .env file
npm run setup-multi-db # Create multi-db config
npm run secure-setup   # Complete secure setup
```

### Useful URLs (when running with SSE)
- Server Status: http://localhost:3333/status
- Test Query: http://localhost:3333/test-query
- SSE Test: http://localhost:3333/test-sse 