import sql from 'mssql';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const config = {
    user: process.env.GP_USER,
    password: process.env.GP_PASSWORD,
    server: process.env.GP_SERVER,
    database: process.env.GP_DB,
    port: 1433,
    options: {
        encrypt: false,
        trustServerCertificate: true,
        connectTimeout: 30000,
        requestTimeout: 30000
    }
};

console.log(`Connecting to GP: ${config.server}/${config.database} as ${config.user}`);

try {
    const pool = await new sql.ConnectionPool(config).connect();
    console.log('Connected to GP!');

    const result = await pool.request().query('SELECT COUNT(*) as record_count FROM ta_tim');
    console.log('ta_tim record count:', result.recordset[0].record_count);

    await pool.close();
} catch (err) {
    console.error('Error:', err.message);
}
