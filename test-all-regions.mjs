import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    console.log('🚀 Starting MCP All-Regions Connectivity Test...');

    const transport = new StdioClientTransport({
        command: "node",
        args: [path.join(__dirname, "server.mjs")],
        env: { ...process.env, TRANSPORT: "stdio" }
    });

    const client = new Client(
        { name: "test-client-all", version: "1.0.0" },
        { capabilities: {} }
    );

    try {
        console.log('🔌 Connecting to MCP server...');
        await client.connect(transport);
        console.log('✅ Connected to MCP server');

        const regions = ['gp', 'kzn', 'el', 'pe', 'cpt'];

        for (const region of regions) {
            console.log(`\n----------------------------------------`);
            console.log(`🔎 Testing connectivity for region: ${region.toUpperCase()}...`);

            try {
                // Set a timeout for each query to avoid hanging the whole script
                const queryPromise = client.callTool("mcp_SQL_execute_query", {
                    sql: "SELECT 1 as connection_test, @@SERVERNAME as server_name",
                    databaseId: region
                });

                // 20s timeout per region
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Query timed out')), 20000)
                );

                const result = await Promise.race([queryPromise, timeoutPromise]);

                console.log(`✅ ${region.toUpperCase()}: Success!`);

                // Print result details safely
                if (result.content && result.content[0] && result.content[0].text) {
                    console.log(`   Response: ${result.content[0].text.trim()}`);
                } else {
                    console.log(`   Response: ${JSON.stringify(result)}`);
                }

            } catch (err) {
                console.log(`❌ ${region.toUpperCase()}: Failed`);
                console.log(`   Error: ${err.message}`);
            }
        }

    } catch (error) {
        console.error('❌ Fatal error:', error);
    } finally {
        console.log(`\n----------------------------------------`);
        console.log('🛑 Closing connection...');
        await client.close();
    }
}

main();
