require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const db = new Database(process.env.DB_PATH || './data/donations.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    transaction_id TEXT PRIMARY KEY,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    counted INTEGER NOT NULL DEFAULT 0
  );
`);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ACCOUNT_ID = process.env.ACCOUNT_ID;
const SECRET_TOKEN = process.env.SECRET_TOKEN;
const BASE_URL = (process.env.QRIS_BASE_URL || 'https://api.buatqris.site').replace(/\/$/, '');
const GOAL = Math.max(1, Number(process.env.DONATION_GOAL || 2700000));

function rupiah(n) {
  return new Intl.NumberFormat('id-ID').format(n);
}
async function qrisRequest(params) {
  if (!ACCOUNT_ID || !SECRET_TOKEN) throw new Error('ACCOUNT_ID dan SECRET_TOKEN belum diatur di Railway Variables.');
  const body = new URLSearchParams({
    account_id: ACCOUNT_ID,
    secret_token: SECRET_TOKEN,
    ...params
  });
  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await response.json();
  if (!response.ok || data.success !== true) {
    throw new Error(data.message || data.error || 'Permintaan QRIS gagal.');
  }
  return data.data;
}
function summary() {
  const row = db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE status='success' AND counted=1").get();
  const total = Number(row.total || 0);
  return { goal: GOAL, collected: total, percent: Math.min(100, Math.round(total / GOAL * 100)) };
}

app.get('/api/summary', (req, res) => res.json(summary()));

app.post('/api/create', async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isSafeInteger(amount) || amount < 1000 || amount > 100000000) {
      return res.status(400).json({ error: 'Nominal minimal Rp1.000 dan maksimal Rp100.000.000.' });
    }
    const result = await qrisRequest({
      action: 'api_create_qris',
      amount: String(amount),
      description: 'Donasi untuk beli HP',
      qris_method: process.env.QRIS_METHOD || 'qris_two',
      fee_by: process.env.FEE_BY || 'user'
    });
    if (!result.transaction_id || (!result.qr_url && !result.qris_image && !result.payment_url)) {
      throw new Error('Respons QRIS tidak lengkap.');
    }
    db.prepare(`INSERT OR REPLACE INTO transactions (transaction_id, amount, status, counted)
      VALUES (?, ?, ?, 0)`).run(String(result.transaction_id), amount, result.status || 'pending');
    res.json({
      transaction_id: String(result.transaction_id),
      qr_url: result.qr_url || null,
      qris_image: result.qris_image || null,
      payment_url: result.payment_url || null,
      amount: result.amount || amount,
      total_amount: result.total_amount || result.amount || amount,
      status: result.status || 'pending'
    });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Gagal membuat QRIS.' });
  }
});

app.get('/api/status/:id', async (req, res) => {
  try {
    const id = String(req.params.id);
    const saved = db.prepare('SELECT * FROM transactions WHERE transaction_id=?').get(id);
    if (!saved) return res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
    if (saved.status !== 'success' && saved.status !== 'expired' && saved.status !== 'failed') {
      const result = await qrisRequest({ action: 'api_check_status', transaction_id: id });
      const status = String(result.status || 'pending').toLowerCase();
      if (['pending', 'success', 'expired', 'failed'].includes(status)) {
        const counted = status === 'success' ? 1 : 0;
        db.prepare('UPDATE transactions SET status=?, counted=? WHERE transaction_id=?')
          .run(status, counted, id);
      }
    }
    const current = db.prepare('SELECT status FROM transactions WHERE transaction_id=?').get(id);
    res.json({ status: current.status, summary: summary() });
  } catch (err) {
    const retry = Number(err.retry_after || 0);
    res.status(429).json({ error: err.message || 'Gagal mengecek status.', retry_after: retry });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => console.log(`Website berjalan di port ${port}`));
