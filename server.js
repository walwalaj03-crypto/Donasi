
require('dotenv').config();

const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();

const dbPath = process.env.DB_PATH || './data/donations.db';

fs.mkdirSync(path.dirname(path.resolve(dbPath)), {
  recursive: true
});

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS transactions (
  transaction_id TEXT PRIMARY KEY,
  amount INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  counted INTEGER DEFAULT 0,
  donor_name TEXT DEFAULT 'Anonim',
  caption TEXT DEFAULT ''
);
`);

const cols = db.prepare(
  'PRAGMA table_info(transactions)'
).all().map(c => c.name);

if (!cols.includes('donor_name')) {
  db.exec("ALTER TABLE transactions ADD COLUMN donor_name TEXT DEFAULT 'Anonim'");
}

if (!cols.includes('caption')) {
  db.exec("ALTER TABLE transactions ADD COLUMN caption TEXT DEFAULT ''");
}

if (!cols.includes('counted')) {
  db.exec("ALTER TABLE transactions ADD COLUMN counted INTEGER DEFAULT 0");
}

app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ACCOUNT_ID = process.env.ACCOUNT_ID;
const SECRET_TOKEN = process.env.SECRET_TOKEN;
const BASE_URL = (
  process.env.QRIS_BASE_URL || 'https://api.buatqris.site'
).replace(/\/$/, '');

const FIRST_GOAL = 2700000;
const SECOND_GOAL = 3000000;
const GOAL_STEP = 29000;

async function qrisRequest(params) {
  if (!ACCOUNT_ID || !SECRET_TOKEN) {
    throw new Error('ACCOUNT_ID atau SECRET_TOKEN belum diatur.');
  }

  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      account_id: ACCOUNT_ID,
      secret_token: SECRET_TOKEN,
      ...params
    })
  });

  const data = await response.json();

  if (!response.ok || data.success !== true) {
    throw new Error(
      data.message || data.error || 'Permintaan QRIS gagal.'
    );
  }

  return data.data;
}

// TOTAL DONASI DAN GOAL BERIKUTNYA
function summary() {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM transactions
    WHERE status = 'success' AND counted = 1
  `).get();

  const total = Number(row.total || 0);

  let goal;

  if (total < FIRST_GOAL) {
    goal = FIRST_GOAL;
  } else if (total < SECOND_GOAL) {
    goal = SECOND_GOAL;
  } else {
    goal =
      SECOND_GOAL +
      (Math.floor((total - SECOND_GOAL) / GOAL_STEP) + 1) *
      GOAL_STEP;
  }

  const progress = Math.max(0, total - (
    goal === FIRST_GOAL
      ? 0
      : goal === SECOND_GOAL
        ? FIRST_GOAL
        : goal - GOAL_STEP
  ));

  const previousGoal =
    goal === FIRST_GOAL ? 0 :
    goal === SECOND_GOAL ? FIRST_GOAL :
    goal - GOAL_STEP;

  const targetAmount = goal - previousGoal;

  return {
    collected: total,
    goal,
    percent: Math.min(
      100,
      Math.floor((progress / targetAmount) * 100)
    ),
    remaining: Math.max(0, goal - total)
  };
}

// SUMMARY
app.get('/api/summary', (req, res) => {
  res.json(summary());
});

// DAFTAR DONATUR
app.get('/api/donors', (req, res) => {
  const donors = db.prepare(`
    SELECT donor_name, caption, amount, created_at
    FROM transactions
    WHERE status = 'success' AND counted = 1
    ORDER BY created_at DESC
    LIMIT 50
  `).all();

  res.json({ donors });
});

// BUAT QRIS
app.post('/api/create', async (req, res) => {
  try {
    const amount = Number(req.body.amount);

    const name = String(req.body.name || '')
      .trim().slice(0, 40) || 'Anonim';

    const caption = String(req.body.caption || '')
      .trim().slice(0, 180);

    if (
      !Number.isSafeInteger(amount) ||
      amount < 1000 ||
      amount > 100000000
    ) {
      return res.status(400).json({
        error: 'Nominal minimal Rp1.000.'
      });
    }

    const result = await qrisRequest({
      action: 'api_create_qris',
      amount: String(amount),
      description: 'Donasi untuk beli HP - ' + name,
      qris_method: process.env.QRIS_METHOD || 'qris_two',
      fee_by: process.env.FEE_BY || 'user'
    });

    if (
      !result.transaction_id ||
      (!result.qr_url && !result.qris_image && !result.payment_url)
    ) {
      throw new Error('Respons QRIS tidak lengkap.');
    }

    const status = String(
      result.status || 'pending'
    ).toLowerCase();

    db.prepare(`
      INSERT OR REPLACE INTO transactions
      (transaction_id, amount, status, counted, donor_name, caption)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      String(result.transaction_id),
      amount,
      status,
      status === 'success' ? 1 : 0,
      name,
      caption
    );

    res.json({
      transaction_id: String(result.transaction_id),
      qr_url: result.qr_url || null,
      qris_image: result.qris_image || null,
      payment_url: result.payment_url || null,
      amount: result.amount || amount,
      total_amount: result.total_amount || result.amount || amount,
      status
    });

  } catch (error) {
    res.status(502).json({
      error: error.message
    });
  }
});

// CEK STATUS PEMBAYARAN
app.get('/api/status/:id', async (req, res) => {
  try {
    const id = String(req.params.id);

    const saved = db.prepare(
      'SELECT * FROM transactions WHERE transaction_id = ?'
    ).get(id);

    if (!saved) {
      return res.status(404).json({
        error: 'Transaksi tidak ditemukan.'
      });
    }

    if (!['success', 'expired', 'failed'].includes(saved.status)) {
      const result = await qrisRequest({
        action: 'api_check_status',
        transaction_id: id
      });

      const status = String(
        result.status || 'pending'
      ).toLowerCase();

      if (
        ['pending', 'success', 'expired', 'failed'].includes(status)
      ) {
        db.prepare(`
          UPDATE transactions
          SET status = ?, counted = ?
          WHERE transaction_id = ?
        `).run(
          status,
          status === 'success' ? 1 : 0,
          id
        );
      }
    }

    const current = db.prepare(
      'SELECT status FROM transactions WHERE transaction_id = ?'
    ).get(id);

    res.json({
      status: current.status,
      summary: summary()
    });

  } catch (error) {
    res.status(429).json({
      error: error.message,
      retry_after: Number(error.retry_after || 0)
    });
  }
});

app.get('*', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );
});

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, '0.0.0.0', () => {
  console.log('Website Donasi berjalan di port ' + PORT);
});
