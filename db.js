const oracledb = require('oracledb');
const path = require('path');
require('dotenv').config();

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.autoCommit = true;

const walletPath = path.join(__dirname, 'Wallet_lfquiztg');

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectString: process.env.DB_CONNECT_STRING,
  configDir: walletPath,
  walletLocation: walletPath,
  walletPassword: process.env.DB_WALLET_PASSWORD
};

async function getConnection() {
  try {
    console.log('DB: connecting...');
    const connection = await oracledb.getConnection(dbConfig);
    console.log('DB: connected');
    return connection;
  } catch (error) {
    console.error('DB CONNECTION ERROR:', error);
    throw error;
  }
}

async function execute(sql, binds = {}, options = {}) {
  let connection;

  try {
    console.log('DB: execute start');
    console.log('SQL:', sql);
    console.log('BINDS:', binds);

    connection = await getConnection();

    const result = await connection.execute(sql, binds, options);

    console.log('DB: execute success');
    return result;
  } catch (error) {
    console.error('DB EXECUTE ERROR:', error);
    throw error;
  } finally {
    if (connection) {
      try {
        await connection.close();
        console.log('DB: connection closed');
      } catch (closeError) {
        console.error('DB CLOSE ERROR:', closeError);
      }
    }
  }
}

module.exports = {
  getConnection,
  execute
};