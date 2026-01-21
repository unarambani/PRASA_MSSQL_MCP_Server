import sql from 'mssql';

const config = {
  user: 'tads',
  password: 'biddcom@123',
  server: '10.30.7.70',
  database: 'EastLondon_TSDB',
  options: {
    encrypt: false,
    trustServerCertificate: true,
    connectionTimeout: 15000,
    requestTimeout: 15000
  }
};

async function checkConnection() {
  console.log('🔗 Connecting to EL directly with mssql driver...');
  try {
    const pool = await sql.connect(config);
    console.log('✅ Connected successfully!');

    const result = await pool.request().query('SELECT 1 as result');
    console.log('📄 Query result:', result.recordset);

    await pool.close();
  } catch (err) {
    console.error('❌ Connection failed:', err);
  }
}

checkConnection();