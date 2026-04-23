var Database = require('better-sqlite3');
var db = new Database('./data/love-diary.db');
var r = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', JSON.stringify(r));
var cols = db.prepare("PRAGMA table_info(messages)").all();
console.log('Messages columns:', JSON.stringify(cols));
db.close();
