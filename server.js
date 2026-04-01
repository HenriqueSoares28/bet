const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- DB ---
const db = new Database(process.env.DB_PATH || './data/betfriends.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    balance REAL DEFAULT 1000,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    status TEXT DEFAULT 'open',
    result TEXT,
    total_yes REAL DEFAULT 0,
    total_no REAL DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    resolved_at INTEGER,
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    question_id INTEGER NOT NULL,
    pick TEXT NOT NULL,
    odd REAL NOT NULL,
    amount REAL NOT NULL,
    status TEXT DEFAULT 'pending',
    payout REAL DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (question_id) REFERENCES questions(id)
  );
`);

// --- Helpers ---
function calcOdds(totalYes, totalNo) {
  const total = totalYes + totalNo;
  if (total === 0) return { yes: 2.00, no: 2.00 };

  const margin = 0.08; // 8% margem da casa
  const pYes = (totalYes + 1) / (total + 2); // smoothing
  const pNo = (totalNo + 1) / (total + 2);

  let oddYes = (1 / pNo) * (1 - margin); // mais gente aposta sim -> odd do sim abaixa
  let oddNo = (1 / pYes) * (1 - margin);

  oddYes = Math.max(1.10, Math.min(20, Math.round(oddYes * 100) / 100));
  oddNo = Math.max(1.10, Math.min(20, Math.round(oddNo * 100) / 100));

  return { yes: oddYes, no: oddNo };
}

function getQuestions() {
  const questions = db.prepare(`
    SELECT q.*, u.name as creator_name
    FROM questions q JOIN users u ON q.created_by = u.id
    ORDER BY q.status = 'open' DESC, q.created_at DESC
  `).all();

  return questions.map(q => ({
    ...q,
    odds: calcOdds(q.total_yes, q.total_no),
    bet_count: db.prepare('SELECT COUNT(*) as c FROM bets WHERE question_id = ?').get(q.id).c
  }));
}

function getRanking() {
  return db.prepare('SELECT id, name, balance FROM users ORDER BY balance DESC LIMIT 50').all();
}

function getUserBets(userId) {
  return db.prepare(`
    SELECT b.*, q.text as question_text
    FROM bets b JOIN questions q ON b.question_id = q.id
    WHERE b.user_id = ? ORDER BY b.created_at DESC
  `).all(userId);
}

function broadcast(event, data) {
  io.emit(event, data);
}

// --- Socket.IO ---
io.on('connection', (socket) => {

  // Join
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
      questions: getQuestions(),
      bets: getUserBets(user.id),
      ranking: getRanking()
    });

    broadcast('ranking', getRanking());
  });

  // Create question
  socket.on('create_question', (text, callback) => {
    if (!socket.userId) return callback({ error: 'Não logado' });
    text = (text || '').trim();
    if (text.length < 5) return callback({ error: 'Pergunta muito curta' });
    if (text.length > 200) return callback({ error: 'Pergunta muito longa' });

    db.prepare('INSERT INTO questions (text, created_by) VALUES (?, ?)').run(text, socket.userId);
    broadcast('questions', getQuestions());
    callback({ success: true });
  });

  // Place bet
  socket.on('place_bet', (data, callback) => {
    if (!socket.userId) return callback({ error: 'Não logado' });

    const { questionId, pick, amount } = data;
    if (pick !== 'yes' && pick !== 'no') return callback({ error: 'Pick inválido' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(socket.userId);
    const question = db.prepare("SELECT * FROM questions WHERE id = ? AND status = 'open'").get(questionId);

    if (!question) return callback({ error: 'Pergunta não encontrada ou fechada' });
    if (amount <= 0 || amount > user.balance) return callback({ error: 'Saldo insuficiente' });

    const odds = calcOdds(question.total_yes, question.total_no);
    const odd = pick === 'yes' ? odds.yes : odds.no;

    // Update totals
    if (pick === 'yes') {
      db.prepare('UPDATE questions SET total_yes = total_yes + ? WHERE id = ?').run(amount, questionId);
    } else {
      db.prepare('UPDATE questions SET total_no = total_no + ? WHERE id = ?').run(amount, questionId);
    }

    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amount, user.id);
    db.prepare('INSERT INTO bets (user_id, question_id, pick, odd, amount) VALUES (?, ?, ?, ?, ?)')
      .run(user.id, questionId, pick, odd, amount);

    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);

    callback({
      success: true,
      newBalance: updated.balance,
      bets: getUserBets(user.id)
    });

    broadcast('questions', getQuestions());
    broadcast('ranking', getRanking());
    broadcast('recent_bet', {
      userName: user.name,
      question: question.text,
      pick: pick === 'yes' ? 'SIM' : 'NÃO',
      amount, odd
    });
  });

  // Resolve question (only creator can)
  socket.on('resolve_question', (data, callback) => {
    if (!socket.userId) return callback({ error: 'Não logado' });

    const { questionId, result } = data;
    if (result !== 'yes' && result !== 'no') return callback({ error: 'Resultado inválido' });

    const question = db.prepare("SELECT * FROM questions WHERE id = ? AND status = 'open'").get(questionId);
    if (!question) return callback({ error: 'Pergunta não encontrada' });
    if (question.created_by !== socket.userId) return callback({ error: 'Só quem criou pode resolver' });

    // Resolve
    db.prepare("UPDATE questions SET status = 'resolved', result = ?, resolved_at = strftime('%s','now') WHERE id = ?")
      .run(result, questionId);

    // Pay winners
    const winningBets = db.prepare("SELECT * FROM bets WHERE question_id = ? AND pick = ? AND status = 'pending'")
      .all(questionId, result);

    for (const bet of winningBets) {
      const payout = bet.amount * bet.odd;
      db.prepare("UPDATE bets SET status = 'won', payout = ? WHERE id = ?").run(payout, bet.id);
      db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(payout, bet.user_id);

      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(bet.user_id);
      io.to('user_' + bet.user_id).emit('bet_resolved', {
        betId: bet.id, status: 'won', payout, newBalance: u.balance
      });
    }

    // Mark losers
    db.prepare("UPDATE bets SET status = 'lost' WHERE question_id = ? AND pick != ? AND status = 'pending'")
      .run(questionId, result);

    const losingBets = db.prepare("SELECT DISTINCT user_id FROM bets WHERE question_id = ? AND status = 'lost'")
      .all(questionId);
    for (const lb of losingBets) {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(lb.user_id);
      io.to('user_' + lb.user_id).emit('bet_resolved', {
        status: 'lost', newBalance: u.balance
      });
    }

    broadcast('questions', getQuestions());
    broadcast('ranking', getRanking());
    callback({ success: true });
  });

  // Refresh
  socket.on('get_data', (callback) => {
    if (!socket.userId) return callback({});
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(socket.userId);
    callback({
      user: { id: user.id, name: user.name, balance: user.balance },
      questions: getQuestions(),
      bets: getUserBets(socket.userId),
      ranking: getRanking()
    });
  });
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`BetOXG rodando em http://localhost:${PORT}`);
});
