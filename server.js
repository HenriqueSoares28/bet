const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- DB Setup ---
const db = new Database(process.env.DB_PATH || './data/betfriends.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    balance REAL DEFAULT 1000,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    league TEXT NOT NULL,
    home_name TEXT NOT NULL,
    home_emoji TEXT NOT NULL,
    away_name TEXT NOT NULL,
    away_emoji TEXT NOT NULL,
    odd_home REAL NOT NULL,
    odd_draw REAL NOT NULL,
    odd_away REAL NOT NULL,
    live INTEGER DEFAULT 0,
    minute INTEGER DEFAULT 0,
    time_label TEXT NOT NULL,
    status TEXT DEFAULT 'open',
    result TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    match_id INTEGER NOT NULL,
    pick TEXT NOT NULL,
    pick_name TEXT NOT NULL,
    odd REAL NOT NULL,
    amount REAL NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (match_id) REFERENCES matches(id)
  );
`);

// Seed matches if empty
const matchCount = db.prepare('SELECT COUNT(*) as c FROM matches').get().c;
if (matchCount === 0) {
  const insert = db.prepare(`
    INSERT INTO matches (league, home_name, home_emoji, away_name, away_emoji, odd_home, odd_draw, odd_away, live, minute, time_label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seeds = [
    ['Brasileirão - Série A', 'Flamengo', '🔴⚫', 'Palmeiras', '🟢⚪', 2.10, 3.25, 3.40, 1, 34, 'Ao Vivo'],
    ['Brasileirão - Série A', 'Corinthians', '⚫⚪', 'São Paulo', '🔴⚪', 2.50, 3.10, 2.80, 0, 0, 'Hoje 19:00'],
    ['Champions League', 'Real Madrid', '⚪🟡', 'Man City', '🔵⚪', 1.95, 3.50, 3.80, 0, 0, 'Hoje 16:00'],
    ['Champions League', 'Barcelona', '🔵🔴', 'Bayern', '🔴⚪', 2.30, 3.40, 2.90, 1, 67, 'Ao Vivo'],
    ['Premier League', 'Liverpool', '🔴🔴', 'Arsenal', '🔴⚪', 1.80, 3.60, 4.20, 0, 0, 'Amanhã 13:30'],
    ['La Liga', 'Atlético', '🔴⚪', 'Sevilla', '⚪🔴', 1.65, 3.70, 5.00, 0, 0, 'Amanhã 16:00'],
    ['Brasileirão - Série A', 'Grêmio', '🔵⚫', 'Internacional', '🔴⚪', 2.40, 3.15, 2.95, 1, 12, 'Ao Vivo'],
    ['Serie A Itália', 'Juventus', '⚫⚪', 'Milan', '🔴⚫', 2.20, 3.30, 3.10, 0, 0, 'Hoje 15:45'],
  ];

  const insertMany = db.transaction((rows) => {
    for (const r of rows) insert.run(...r);
  });
  insertMany(seeds);
}

// --- Helpers ---
function getMatches() {
  return db.prepare("SELECT * FROM matches WHERE status = 'open' ORDER BY live DESC, id ASC").all();
}

function getRanking() {
  return db.prepare('SELECT id, name, balance FROM users ORDER BY balance DESC LIMIT 50').all();
}

function getUserBets(userId) {
  return db.prepare(`
    SELECT b.*, m.home_name, m.away_name
    FROM bets b JOIN matches m ON b.match_id = m.id
    WHERE b.user_id = ? ORDER BY b.created_at DESC
  `).all(userId);
}

function broadcast(event, data) {
  io.emit(event, data);
}

// --- Odds fluctuation ---
function fluctuateOdds() {
  const matches = db.prepare("SELECT * FROM matches WHERE status = 'open'").all();
  const update = db.prepare('UPDATE matches SET odd_home=?, odd_draw=?, odd_away=?, minute=? WHERE id=?');

  const doUpdate = db.transaction(() => {
    for (const m of matches) {
      let oh = m.odd_home + (Math.random() - 0.5) * 0.12;
      let od = m.odd_draw + (Math.random() - 0.5) * 0.12;
      let oa = m.odd_away + (Math.random() - 0.5) * 0.12;
      oh = Math.max(1.05, Math.round(oh * 100) / 100);
      od = Math.max(1.05, Math.round(od * 100) / 100);
      oa = Math.max(1.05, Math.round(oa * 100) / 100);
      let min = m.minute;
      if (m.live && min < 90) min += Math.random() < 0.3 ? 1 : 0;
      update.run(oh, od, oa, min, m.id);
    }
  });

  doUpdate();
  broadcast('matches', getMatches());
}

setInterval(fluctuateOdds, 4000);

// --- Resolve bets randomly (for fun) ---
function resolveRandomBets() {
  const pending = db.prepare("SELECT * FROM bets WHERE status = 'pending' AND created_at < strftime('%s','now') - 15").all();

  for (const bet of pending) {
    const won = Math.random() < 0.4;
    const status = won ? 'won' : 'lost';

    db.prepare('UPDATE bets SET status = ? WHERE id = ?').run(status, bet.id);

    if (won) {
      const winnings = bet.amount * bet.odd;
      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(winnings, bet.user_id);
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(bet.user_id);
    if (user) {
      io.to('user_' + user.id).emit('bet_resolved', {
        betId: bet.id,
        status,
        won,
        winnings: won ? bet.amount * bet.odd : 0,
        newBalance: user.balance
      });
    }
  }

  if (pending.length > 0) {
    broadcast('ranking', getRanking());
  }
}

setInterval(resolveRandomBets, 5000);

// --- Socket.IO ---
io.on('connection', (socket) => {
  // Join / create user
  socket.on('join', (name, callback) => {
    name = (name || '').trim().substring(0, 20);
    if (name.length < 2) return callback({ error: 'Nome muito curto' });

    let user = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
    if (!user) {
      db.prepare('INSERT INTO users (name) VALUES (?)').run(name);
      user = db.prepare('SELECT * FROM users WHERE name = ?').get(name);
    }

    socket.userId = user.id;
    socket.join('user_' + user.id);

    callback({
      user: { id: user.id, name: user.name, balance: user.balance },
      matches: getMatches(),
      bets: getUserBets(user.id),
      ranking: getRanking()
    });

    broadcast('ranking', getRanking());
  });

  // Place bet
  socket.on('place_bet', (data, callback) => {
    if (!socket.userId) return callback({ error: 'Não logado' });

    const { matchId, pick, pickName, amount } = data;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(socket.userId);
    const match = db.prepare("SELECT * FROM matches WHERE id = ? AND status = 'open'").get(matchId);

    if (!user || !match) return callback({ error: 'Jogo não encontrado' });
    if (amount <= 0 || amount > user.balance) return callback({ error: 'Saldo insuficiente' });

    const oddKey = pick === 'home' ? 'odd_home' : pick === 'draw' ? 'odd_draw' : 'odd_away';
    const odd = match[oddKey];

    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amount, user.id);
    db.prepare('INSERT INTO bets (user_id, match_id, pick, pick_name, odd, amount) VALUES (?, ?, ?, ?, ?, ?)')
      .run(user.id, matchId, pick, pickName, odd, amount);

    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);

    callback({
      success: true,
      newBalance: updated.balance,
      bets: getUserBets(user.id)
    });

    broadcast('ranking', getRanking());
    broadcast('recent_bet', { userName: user.name, matchName: `${match.home_name} vs ${match.away_name}`, pickName, amount, odd });
  });

  // Refresh data
  socket.on('get_data', (callback) => {
    if (!socket.userId) return callback({});
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(socket.userId);
    callback({
      user: { id: user.id, name: user.name, balance: user.balance },
      matches: getMatches(),
      bets: getUserBets(socket.userId),
      ranking: getRanking()
    });
  });
});

// --- Static files ---
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`BetFriends rodando em http://localhost:${PORT}`);
});
