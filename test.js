const db = require('./db');
console.log('TEST START');
(async () => {
  try {
    const result = await db.execute(`SELECT * FROM TBL_USERS`);
    console.log('RESULT:', result.rows);

  } catch (e) {
    console.error(e);
  }
})();