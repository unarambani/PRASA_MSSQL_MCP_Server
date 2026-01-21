
async function main() {
    console.log('🚀 Sending Raw JSON-RPC request to MCP Server...');

    const body = {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
            name: "mcp_server_health",
            arguments: {}
        },
        id: 1
    };

    try {
        const response = await fetch("http://localhost:3334/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });

        console.log(`Response Status: ${response.status}`);
        const text = await response.text();
        console.log(`Response Body: ${text}`);

    } catch (err) {
        console.error("Error:", err);
    }
}

main();
