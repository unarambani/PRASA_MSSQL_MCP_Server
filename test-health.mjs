import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    console.log('🚀 Starting MCP Health Check Test...');

    const transport = new StdioClientTransport({
        command: "node",
        args: [path.join(__dirname, "server.mjs")],
        env: { ...process.env, TRANSPORT: "stdio" }
    });

    const client = new Client(
        { name: "test-client-health", version: "1.0.0" },
        { capabilities: {} }
    );

    try {
        console.log('🔌 Connecting to MCP server...');
        await client.connect(transport);
        console.log('✅ Connected to MCP server');

        console.log('❤️ Checking server health...');
        // Default timeout 5s
        const healthPromise = client.callTool("mcp_server_health", {});
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Health check timed out')), 5000)
        );

        const result = await Promise.race([healthPromise, timeoutPromise]);

        console.log('✅ Health Check Result:', JSON.stringify(result, null, 2));

    } catch (error) {
        console.error('❌ Fatal error:', error);
        // Dump logs if fail
        // console.log("--- LOGS ---");
        // process.stderr.pipe(process.stdout);
    } finally {
        console.log('🛑 Closing connection...');
        await client.close();
    }
}

main();
