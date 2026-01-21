import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  console.log('🚀 Starting MCP SSE Connectivity Test...');

  const transport = new SSEClientTransport(
    new URL("http://localhost:3333/sse")
  );

  const client = new Client(
    { name: "test-client-sse", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    console.log('🔌 Connecting to MCP server via SSE...');
    await client.connect(transport);
    console.log('✅ Connected to MCP server');

    const regions = ['gp', 'kzn', 'el', 'pe', 'cpt'];

    for (const region of regions) {
      console.log(`\n----------------------------------------`);
      console.log(`🔎 Testing connectivity for region: ${region.toUpperCase()}...`);

      try {
        // Set a timeout for each query
        const queryPromise = client.callTool("mcp_SQL_execute_query", {
          sql: "SELECT 1 as connection_test, @@SERVERNAME as server_name, 'SSE Works' as status",
          databaseId: region
        });

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Query timed out')), 20000)
        );

        const result = await Promise.race([queryPromise, timeoutPromise]);

        console.log(`✅ ${region.toUpperCase()}: Success!`);
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
    await client.close(); // This might hang if SSE doesn't close cleanly, but fine for script
    process.exit(0);
  }
}

main();