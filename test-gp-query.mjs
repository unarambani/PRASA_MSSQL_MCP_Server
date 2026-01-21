import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    console.log('🚀 Starting MCP functionality test...');

    const transport = new StdioClientTransport({
        command: "node",
        args: [path.join(__dirname, "server.mjs")],
        env: { ...process.env, TRANSPORT: "stdio" }
    });

    const client = new Client(
        { name: "test-client", version: "1.0.0" },
        { capabilities: {} }
    );

    try {
        await client.connect(transport);
        console.log('✅ Connected to MCP server');

        const tools = await client.listTools();
        console.log(`🛠️ Discovered ${tools.tools.length} tools`);

        // Query GP database
        console.log('\n🔎 Executing query on GP database...');
        const result = await client.callTool("mcp_SQL_execute_query", {
            sql: "SELECT 1 as connection_test",
            databaseId: "gp"
        });

        console.log('📄 Result content:');
        result.content.forEach(item => {
            if (item.type === 'text') {
                console.log(item.text);
            } else {
                console.log(JSON.stringify(item, null, 2));
            }
        });

    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        await client.close();
    }
}

main();
