import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    console.log('🚀 Starting MCP EL Connectivity Test...');

    const transport = new StdioClientTransport({
        command: "node",
        args: [path.join(__dirname, "server.mjs")],
        env: { ...process.env, TRANSPORT: "stdio" }
    });

    const client = new Client(
        { name: "test-client-el", version: "1.0.0" },
        { capabilities: {} }
    );

    try {
        await client.connect(transport);
        console.log('✅ Connected to MCP server');

        // Query EL database
        console.log('\n🔎 Executing query on EL database...');
        const result = await client.callTool("mcp_SQL_execute_query", {
            sql: "SELECT 1 as connection_test, 'EL Works' as status",
            databaseId: "el"
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
