const Database = require('better-sqlite3');
const db = new Database('game.db');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  balance INTEGER DEFAULT 0,
  wallet TEXT,
  last_tap INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  reward INTEGER,
  url TEXT
);

CREATE TABLE IF NOT EXISTS user_tasks (
  telegram_id TEXT,
  task_id INTEGER,
  completed INTEGER DEFAULT 0,
  PRIMARY KEY (telegram_id, task_id)
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT,
  amount INTEGER,
  wallet TEXT,
  status TEXT DEFAULT 'pending',
  created_at INTEGER
);
`);

const count = db.prepare('SELECT COUNT(*) as c FROM tasks').get().c;
if (count === 0) {
  const insert = db.prepare('INSERT INTO tasks (title, reward, url) VALUES (?, ?, ?)');
  insert.run('Tham gia kênh Telegram ARXC', 100, 'https://t.me/telegram');
  insert.run('Theo dõi X (Twitter) của ARXC', 150, 'https://x.com/telegram');
  insert.run('Mời 1 người bạn', 200, 'https://t.me/share/url?url=https://t.me');
}

module.exports = db;
