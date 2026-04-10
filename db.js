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
    const connection = await oracledb.getConnection(dbConfig);
    return connection;
  } catch (error) {
    console.error('DB CONNECTION ERROR:', error);
    throw error;
  }
}

async function execute(sql, binds = {}, options = {}) {
  let connection;

  try {
    connection = await getConnection();

    const result = await connection.execute(sql, binds, options);
    return result;
  } catch (error) {
    console.error('DB EXECUTE ERROR:', error);
    throw error;
  } finally {
    if (connection) {
      try {
        await connection.close();
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