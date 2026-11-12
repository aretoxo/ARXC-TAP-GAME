require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'aretoxo').toLowerCase(); // Không xét first_name/last_name

// Xác thực Telegram
function verifyTelegramInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (calculatedHash !== hash) return null;
    return JSON.parse(params.get('user'));
  } catch (e) { return null; }
}

function auth(req, res, next) {
  const initData = req.headers['x-init-data'] || req.body.initData;
  if (!initData) return res.status(401).json({ error: 'Thiếu initData' });
  const user = verifyTelegramInitData(initData);
  if (!user) return res.status(401).json({ error: 'initData không hợp lệ' });
  req.tgUser = user;
  next();
}

// ================= CÁC API CHO NGƯỜI DÙNG =================

app.post('/api/auth', auth, (req, res) => {
  const { id, username, first_name } = req.tgUser;
  const existing = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(id));
  if (!existing) {
    db.prepare('INSERT INTO users (telegram_id, username, first_name, balance) VALUES (?, ?, ?, ?)')
      .run(String(id), username || '', first_name || '', 0);
  } else {
    db.prepare('UPDATE users SET username = ?, first_name = ? WHERE telegram_id = ?')
      .run(username || '', first_name || '', String(id));
  }
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(id));
  
  // Trả về thông tin, bao gồm cờ isAdmin (chỉ xét username)
  const isAdmin = (user.username || '').toLowerCase() === ADMIN_USERNAME;
  
  res.json({
    telegram_id: user.telegram_id,
    username: user.username,
    first_name: user.first_name,
    balance: user.balance,
    wallet: user.wallet,
    isAdmin: isAdmin
  });
});

app.post('/api/tap', auth, (req, res) => {
  const { count } = req.body;
  const taps = Math.min(Math.max(parseInt(count) || 1, 1), 20);
  const id = String(req.tgUser.id);
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'Không tìm thấy user' });
  const now = Date.now();
  if (now - user.last_tap < 100 * taps) return res.status(429).json({ error: 'Tap quá nhanh' });
  const newBalance = user.balance + taps;
  db.prepare('UPDATE users SET balance = ?, last_tap = ? WHERE telegram_id = ?').run(newBalance, now, id);
  res.json({ balance: newBalance });
});

app.get('/api/tasks', auth, (req, res) => {
  const id = String(req.tgUser.id);
  const tasks = db.prepare('SELECT * FROM tasks').all();
  const completed = db.prepare('SELECT task_id FROM user_tasks WHERE telegram_id = ? AND completed = 1').all(id);
  const completedIds = completed.map(c => c.task_id);
  res.json(tasks.map(t => ({ ...t, completed: completedIds.includes(t.id) })));
});

app.post('/api/tasks/:id/claim', auth, (req, res) => {
  const id = String(req.tgUser.id);
  const taskId = parseInt(req.params.id);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return res.status(404).json({ error: 'Task không tồn tại' });
  const already = db.prepare('SELECT * FROM user_tasks WHERE telegram_id = ? AND task_id = ? AND completed = 1').get(id, taskId);
  if (already) return res.status(400).json({ error: 'Đã nhận rồi' });
  db.prepare('INSERT OR REPLACE INTO user_tasks (telegram_id, task_id, completed) VALUES (?, ?, 1)').run(id, taskId);
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(id);
  const newBalance = user.balance + task.reward;
  db.prepare('UPDATE users SET balance = ? WHERE telegram_id = ?').run(newBalance, id);
  res.json({ balance: newBalance, reward: task.reward });
});

app.post('/api/wallet', auth, (req, res) => {
  const { wallet } = req.body;
  if (!wallet || (!wallet.startsWith('EQ') && !wallet.startsWith('UQ'))) {
    return res.status(400).json({ error: 'Địa chỉ ví không hợp lệ' });
  }
  const id = String(req.tgUser.id);
  db.prepare('UPDATE users SET wallet = ? WHERE telegram_id = ?').run(wallet, id);
  res.json({ wallet });
});

app.post('/api/withdraw', auth, (req, res) => {
  const { amount } = req.body;
  const amt = parseInt(amount);
  if (!amt || amt < 1000) return res.status(400).json({ error: 'Tối thiểu 1000 ARXC' });
  const id = String(req.tgUser.id);
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(id);
  if (!user.wallet) return res.status(400).json({ error: 'Vui lòng kết nối ví TON trước' });
  if (user.balance < amt) return res.status(400).json({ error: 'Số dư không đủ' });
  db.prepare('UPDATE users SET balance = balance - ? WHERE telegram_id = ?').run(amt, id);
  db.prepare('INSERT INTO withdrawals (telegram_id, amount, wallet, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, amt, user.wallet, 'pending', Date.now());
  res.json({ ok: true, message: 'Yêu cầu rút đã được ghi nhận. Vui lòng chờ Admin xử lý!' });
});

app.get('/api/me', auth, (req, res) => {
  const id = String(req.tgUser.id);
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(id);
  const withdrawals = db.prepare('SELECT * FROM withdrawals WHERE telegram_id = ? ORDER BY id DESC LIMIT 10').all(id);
  res.json({ ...user, withdrawals });
});

// ================= CÁC API CHO ADMIN (Bảo mật) =================
// Middleware kiểm tra quyền Admin
function isAdmin(req, res, next) {
  if (!req.tgUser || !req.tgUser.username) {
    return res.status(403).json({ error: 'Bạn không phải Admin' });
  }
  if (req.tgUser.username.toLowerCase() !== ADMIN_USERNAME) {
    return res.status(403).json({ error: 'Bạn không có quyền truy cập' });
  }
  next();
}

// Lấy danh sách yêu cầu rút
app.get('/api/admin/withdrawals', auth, isAdmin, (req, res) => {
  const list = db.prepare("SELECT * FROM withdrawals WHERE status = 'pending' ORDER BY id ASC").all();
  res.json(list);
});

// Đánh dấu đã trả
app.post('/api/admin/withdrawals/:id/approve', auth, isAdmin, (req, res) => {
  const id = req.params.id;
  db.prepare("UPDATE withdrawals SET status = 'success' WHERE id = ?").run(id);
  res.json({ ok: true });
});

// Từ chối yêu cầu rút (Hoàn tiền)
app.post('/api/admin/withdrawals/:id/reject', auth, isAdmin, (req, res) => {
  const id = req.params.id;
  const w = db.prepare("SELECT * FROM withdrawals WHERE id = ? AND status = 'pending'").get(id);
  if (w) {
    db.prepare("UPDATE withdrawals SET status = 'rejected' WHERE id = ?").run(id);
    db.prepare("UPDATE users SET balance = balance + ? WHERE telegram_id = ?").run(w.amount, w.telegram_id);
  }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Server chạy trên cổng ' + PORT));
