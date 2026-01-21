
import sql from 'mssql';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const configs = {
    'el': {
        user: process.env.EL_USER,
        password: process.env.EL_PASSWORD,
        server: process.env.EL_SERVER,
        database: process.env.EL_DB,
        port: parseInt(process.env.EL_PORT) || 1433,
        options: { encrypt: false, trustServerCertificate: true, connectionTimeout: 5000 }
    },
    'pe': {
        user: process.env.PE_USER,
        password: process.env.PE_PASSWORD,
        server: process.env.PE_SERVER, // Same as EL often
        database: process.env.PE_DB,
        port: parseInt(process.env.PE_PORT) || 1433,
        options: { encrypt: false, trustServerCertificate: true, connectionTimeout: 5000 }
    },
    'cpt': {
        user: process.env.CPT_USER,
        password: process.env.CPT_PASSWORD,
        server: process.env.CPT_SERVER,
        database: process.env.CPT_DB,
        port: parseInt(process.env.CPT_PORT) || 1433,
        options: { encrypt: false, trustServerCertificate: true, connectionTimeout: 5000 }
    },
    'kzn': {
        user: process.env.KZN_USER,
        password: process.env.KZN_PASSWORD,
        server: process.env.KZN_SERVER,
        database: process.env.KZN_DB,
        port: parseInt(process.env.KZN_PORT) || 1433,
        options: { encrypt: false, trustServerCertificate: true, connectionTimeout: 5000 }
    },
    'gp': {
        user: process.env.GP_USER,
        password: process.env.GP_PASSWORD,
        server: process.env.GP_SERVER,
        database: process.env.GP_DB,
        port: 1433, // Defaulting even for named instance if resolved
        options: { encrypt: false, trustServerCertificate: true, connectionTimeout: 5000 }
    }
};

async function checkRegion(name, config) {
    console.log(`\n----------------------------------------`);
    console.log(`🔎 Testing region: ${name.toUpperCase()}...`);
    console.log(`   Server: ${config.server}, User: ${config.user}, DB: ${config.database}`);

    try {
        const pool = await new sql.ConnectionPool(config).connect();
        console.log(`✅ ${name.toUpperCase()}: Connected!`);

        const result = await pool.request().query('SELECT 1 as works');
        console.log(`   Query Result: ${JSON.stringify(result.recordset)}`);

        await pool.close();
        return true;
    } catch (err) {
        console.log(`❌ ${name.toUpperCase()}: Failed`);
        console.log(`   Error: ${err.message}`);
        return false;
    }
}

async function main() {
    console.log('🚀 Starting Direct MSSQL Connectivity Test...');

    // Fix GP server if it has instance name backslashes which might need escaping in JS string if not careful, 
    // but dotenv handles it. 
    // However, for Named Instances, we might need to enable browser service or dynamic ports.
    // For this test, we assume standard port or 1433.

    for (const [region, config] of Object.entries(configs)) {
        await checkRegion(region, config);
    }
}

main();
