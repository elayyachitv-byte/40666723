import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';

app.use(express.json());

// ─────────────────────────────────────────────
// STATE & STORAGE
// ─────────────────────────────────────────────
interface PaymentRecord {
  status: 'pending' | 'approved' | 'rejected';
  plan: string;
  price: number;
  crypto: string;
  exactAmount: string;
  createdAt: Date;
}

const payments: Record<string, PaymentRecord> = {};
let lastUpdateId = 0;

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// ─────────────────────────────────────────────
// TELEGRAM POLLING
// ─────────────────────────────────────────────
async function pollTelegram() {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('ℹ️ BOT_TOKEN or CHAT_ID not set. Telegram polling skipped (admin simulation enabled in UI).');
    return;
  }

  console.log('🔄 Telegram Bot polling started...');

  while (true) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=25`
      );
      const data: any = await res.json();

      if (data?.ok && data.result?.length > 0) {
        for (const update of data.result) {
          lastUpdateId = update.update_id;

          if (update.message?.text) {
            const text = update.message.text.trim();
            console.log(`📨 Telegram message: ${text}`);

            if (text.startsWith('/approve')) {
              const paymentId = text.split(' ')[1];
              if (paymentId && payments[paymentId]) {
                payments[paymentId].status = 'approved';
                console.log(`✅ Payment ${paymentId} APPROVED via Telegram`);

                fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: CHAT_ID,
                    text: `✅ Payment ${paymentId} APPROVED! User can now download.`
                  })
                }).catch(() => {});
              }
            }

            if (text.startsWith('/reject')) {
              const paymentId = text.split(' ')[1];
              if (paymentId && payments[paymentId]) {
                payments[paymentId].status = 'rejected';
                console.log(`❌ Payment ${paymentId} REJECTED via Telegram`);

                fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: CHAT_ID,
                    text: `❌ Payment ${paymentId} REJECTED.`
                  })
                }).catch(() => {});
              }
            }
          }
        }
      }
    } catch (err: any) {
      console.error('Telegram polling error:', err?.message || err);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
}

// ─────────────────────────────────────────────
// CRYPTO PRICING
// ─────────────────────────────────────────────
const fallbackCoinPrices: Record<string, number> = {
  btc: 96500,
  eth: 3100,
  ltc: 98,
  'usdt-trc20': 1,
  'usdt-erc20': 1,
  'usdt-bep20': 1,
};

async function getCryptoPrice(coin: string): Promise<number | null> {
  const norm = coin.toLowerCase();
  if (norm.includes('usdt')) return 1;

  const coinMap: Record<string, string> = {
    btc: 'bitcoin',
    eth: 'ethereum',
    ltc: 'litecoin',
  };

  const id = coinMap[norm];
  if (!id) return fallbackCoinPrices[norm] || 1;

  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`, {
      headers: { 'Accept': 'application/json' }
    });
    const data: any = await res.json();
    if (data && data[id]?.usd) {
      return Number(data[id].usd);
    }
  } catch (err) {
    console.warn(`Price API fallback used for ${coin}`);
  }

  return fallbackCoinPrices[norm] || 1;
}

function formatCryptoAmount(amount: number, coin: string): string {
  const norm = coin.toLowerCase();
  const decimals: Record<string, number> = {
    btc: 6,
    eth: 5,
    ltc: 4,
    'usdt-trc20': 2,
    'usdt-erc20': 2,
    'usdt-bep20': 2,
  };
  const dec = decimals[norm] ?? 4;
  return amount.toFixed(dec);
}

// ─────────────────────────────────────────────
// API ENDPOINTS
// ─────────────────────────────────────────────
app.get('/api/price/:crypto/:usd', async (req, res) => {
  try {
    const { crypto: coin, usd } = req.params;
    const priceUSD = parseFloat(usd);
    const rate = await getCryptoPrice(coin);

    if (rate) {
      const exactAmount = formatCryptoAmount(priceUSD / rate, coin);
      res.json({
        success: true,
        exactAmount,
        rate,
        crypto: coin.toUpperCase(),
      });
    } else {
      res.status(500).json({ success: false, error: 'Could not calculate price' });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Server error' });
  }
});

app.post('/api/notify', async (req, res) => {
  try {
    const { plan, price, crypto: coin } = req.body;

    if (!plan || !price || !coin) {
      return res.status(400).json({ success: false, error: 'Missing required parameters' });
    }

    const priceUSD = parseFloat(price);
    const rate = await getCryptoPrice(coin) || 1;
    const exactAmount = formatCryptoAmount(priceUSD / rate, coin);
    const cryptoSymbol = coin.toUpperCase().replace('-', ' ');
    const paymentId = 'PAY-' + crypto.randomBytes(3).toString('hex').toUpperCase();

    payments[paymentId] = {
      status: 'pending',
      plan,
      price: priceUSD,
      crypto: coin,
      exactAmount,
      createdAt: new Date(),
    };

    console.log(`📩 Payment request created: ${paymentId} (${plan} - $${priceUSD} via ${coin})`);

    // If Telegram is configured, notify admin
    if (BOT_TOKEN && CHAT_ID) {
      const message = `🔔 *NEW PAYMENT REQUEST*

📦 *Plan:* ${plan}
💰 *Price:* $${priceUSD}
🪙 *Crypto:* ${cryptoSymbol}
🔢 *Amount:* ${exactAmount} ${cryptoSymbol}
🆔 *ID:* \`${paymentId}\`
⏰ *Time:* ${new Date().toLocaleString()}

_Reply with:_
✅ \`/approve ${paymentId}\`
❌ \`/reject ${paymentId}\``;

      fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
          parse_mode: 'Markdown',
        }),
      }).catch((e) => console.error('Telegram notification error:', e));
    }

    res.json({
      success: true,
      paymentId,
      exactAmount,
      cryptoSymbol,
      status: 'pending',
    });
  } catch (err: any) {
    console.error('Notify route error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/status/:id', (req, res) => {
  const payment = payments[req.params.id];
  if (!payment) {
    return res.json({ status: 'unknown' });
  }
  res.json({
    status: payment.status,
    plan: payment.plan,
    price: payment.price,
    exactAmount: payment.exactAmount,
  });
});

app.post('/api/approve/:id', (req, res) => {
  const payment = payments[req.params.id];
  if (!payment) {
    // create and approve if test ID
    payments[req.params.id] = {
      status: 'approved',
      plan: 'Lifetime Access',
      price: 99,
      crypto: 'btc',
      exactAmount: '0.00099',
      createdAt: new Date(),
    };
    return res.json({ success: true, status: 'approved' });
  }
  payment.status = 'approved';
  console.log(`✅ Payment ${req.params.id} manually approved via API`);
  res.json({ success: true, status: 'approved' });
});

app.post('/api/reject/:id', (req, res) => {
  const payment = payments[req.params.id];
  if (payment) {
    payment.status = 'rejected';
  }
  res.json({ success: true, status: 'rejected' });
});

app.get('/api/payments', (req, res) => {
  res.json({ payments, telegramConfigured: Boolean(BOT_TOKEN && CHAT_ID) });
});

// ─────────────────────────────────────────────
// SERVE FRONTEND (Vite Middleware in dev / static in prod)
// ─────────────────────────────────────────────
async function startServer() {
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve('dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve('dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Stake Bot Predictor running on https://stake-jcb8g.bunny.run/:${PORT}`);
    pollTelegram().catch(console.error);
  });
}

startServer().catch(console.error);
