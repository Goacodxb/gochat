require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const { Resend } = require('resend');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// ── App setup ────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ── Database ─────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── Resend (email) ────────────────────────────
const resend = new Resend(process.env.RESEND_API_KEY);

// ── CORS ──────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim());
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// ── Rate limiting ─────────────────────────────
const limiter = rateLimit({ windowMs: 60_000, max: 60 });
app.use('/api/', limiter);

// ── WebSocket session map ─────────────────────
// sessionId -> Set of WebSocket clients
const sessionClients = new Map();

function broadcastToSession(sessionId, payload) {
  const clients = sessionClients.get(sessionId);
  if (!clients) return;
  const msg = JSON.stringify(payload);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

// ── WebSocket handler ─────────────────────────
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');

  if (!sessionId) { ws.close(1008, 'Missing sessionId'); return; }

  if (!sessionClients.has(sessionId)) sessionClients.set(sessionId, new Set());
  sessionClients.get(sessionId).add(ws);

  ws.on('close', () => {
    const clients = sessionClients.get(sessionId);
    if (clients) {
      clients.delete(ws);
      if (clients.size === 0) sessionClients.delete(sessionId);
    }
  });

  ws.on('error', console.error);
});

// ═══════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════

// ── GET /api/availability ─────────────────────
app.get('/api/availability', async (req, res) => {
  try {
    const result = await pool.query('SELECT is_online FROM availability WHERE id = 1');
    res.json({ online: result.rows[0]?.is_online ?? false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── POST /api/sessions — start a new chat ─────
app.post('/api/sessions', async (req, res) => {
  const { name, email, firstMessage } = req.body;
  if (!name || !email || !firstMessage) {
    return res.status(400).json({ error: 'name, email and firstMessage are required' });
  }

  try {
    // Create session
    const sessionResult = await pool.query(
      `INSERT INTO sessions (visitor_name, visitor_email, status)
       VALUES ($1, $2, 'waiting') RETURNING id`,
      [name.trim(), email.trim().toLowerCase()]
    );
    const sessionId = sessionResult.rows[0].id;

    // Save first message
    await pool.query(
      `INSERT INTO messages (session_id, sender_type, sender_name, content)
       VALUES ($1, 'visitor', $2, $3)`,
      [sessionId, name.trim(), firstMessage.trim()]
    );

    // Post to Teams
    await postToTeams(sessionId, name.trim(), email.trim(), firstMessage.trim());

    res.json({ sessionId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// ── POST /api/sessions/:id/messages — visitor sends message ──
app.post('/api/sessions/:id/messages', async (req, res) => {
  const { id } = req.params;
  const { content, senderName } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });

  try {
    const session = await pool.query('SELECT * FROM sessions WHERE id = $1', [id]);
    if (!session.rows.length) return res.status(404).json({ error: 'Session not found' });
    if (session.rows[0].status === 'closed') return res.status(400).json({ error: 'Session is closed' });

    await pool.query(
      `INSERT INTO messages (session_id, sender_type, sender_name, content)
       VALUES ($1, 'visitor', $2, $3)`,
      [id, senderName || session.rows[0].visitor_name, content.trim()]
    );

    // Forward to Teams thread
    await replyToTeamsThread(session.rows[0], content.trim(), senderName || session.rows[0].visitor_name);

    // Broadcast to any other open WebSocket connections for this session
    broadcastToSession(id, { type: 'visitor_message', content: content.trim(), senderName });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── GET /api/sessions/:id/messages — poll for messages ──
app.get('/api/sessions/:id/messages', async (req, res) => {
  const { id } = req.params;
  const since = req.query.since || '1970-01-01';
  try {
    const result = await pool.query(
      `SELECT * FROM messages WHERE session_id = $1 AND created_at > $2 ORDER BY created_at ASC`,
      [id, since]
    );
    res.json({ messages: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── POST /api/leads — offline lead capture ────
app.post('/api/leads', async (req, res) => {
  const { name, email, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'name, email and message are required' });
  }

  try {
    await pool.query(
      `INSERT INTO leads (name, email, message) VALUES ($1, $2, $3)`,
      [name.trim(), email.trim().toLowerCase(), message.trim()]
    );

    // Send email alert via Resend
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: process.env.LEAD_NOTIFICATION_EMAIL,
      subject: `New lead from ${name.trim()} — GoChat`,
      html: `
        <h2>New offline lead captured</h2>
        <p><strong>Name:</strong> ${name.trim()}</p>
        <p><strong>Email:</strong> ${email.trim()}</p>
        <p><strong>Message:</strong></p>
        <blockquote>${message.trim()}</blockquote>
        <p><a href="${process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : ''}/admin">View in admin dashboard</a></p>
      `,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save lead' });
  }
});

// ── POST /api/teams/webhook — Teams bot replies ──
app.post('/api/teams/webhook', async (req, res) => {
  res.sendStatus(200); // Acknowledge immediately

  const body = req.body;
  const text = body?.text?.trim() || '';
  const channelData = body?.channelData || {};
  const from = body?.from?.name || 'Agent';

  // Extract session ID from the conversation context
  // We store it in the channel data when posting the card
  const sessionId = body?.value?.sessionId || extractSessionFromText(text);

  if (!sessionId) return;

  try {
    // Handle bot commands
    if (text.toLowerCase().includes('/gooffline')) {
      await pool.query(`UPDATE availability SET is_online = false, updated_at = NOW() WHERE id = 1`);
      return;
    }
    if (text.toLowerCase().includes('/goonline')) {
      await pool.query(`UPDATE availability SET is_online = true, updated_at = NOW() WHERE id = 1`);
      return;
    }
    if (text.toLowerCase().includes('/close')) {
      await pool.query(
        `UPDATE sessions SET status = 'closed', closed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [sessionId]
      );
      broadcastToSession(sessionId, { type: 'session_closed' });
      return;
    }

    // Regular agent reply — only the claiming agent's messages go through
    const session = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    if (!session.rows.length || session.rows[0].status === 'closed') return;

    // Save message
    await pool.query(
      `INSERT INTO messages (session_id, sender_type, sender_name, content)
       VALUES ($1, 'agent', $2, $3)`,
      [sessionId, from, text]
    );

    // Push to visitor via WebSocket
    broadcastToSession(sessionId, {
      type: 'agent_message',
      content: text,
      senderName: from,
    });

  } catch (err) {
    console.error('Teams webhook error:', err);
  }
});

// ── POST /api/teams/claim — agent claims a chat ──
app.post('/api/teams/claim', async (req, res) => {
  res.sendStatus(200);
  const { sessionId, agentName } = req.body?.value || {};
  if (!sessionId || !agentName) return;

  try {
    // Only claim if still waiting
    const result = await pool.query(
      `UPDATE sessions SET status = 'active', claimed_by = $1, updated_at = NOW()
       WHERE id = $2 AND status = 'waiting' RETURNING *`,
      [agentName, sessionId]
    );
    if (result.rows.length) {
      broadcastToSession(sessionId, { type: 'agent_joined', agentName });
    }
  } catch (err) {
    console.error(err);
  }
});

// ═══════════════════════════════════════════════
// ADMIN DASHBOARD ROUTES
// ═══════════════════════════════════════════════

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-secret'] || req.query.secret;
  if (token !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// GET /api/admin/sessions
app.get('/api/admin/sessions', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, COUNT(m.id) as message_count
       FROM sessions s
       LEFT JOIN messages m ON m.session_id = s.id
       GROUP BY s.id
       ORDER BY s.created_at DESC
       LIMIT 100`
    );
    res.json({ sessions: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/admin/sessions/:id
app.get('/api/admin/sessions/:id', adminAuth, async (req, res) => {
  try {
    const session = await pool.query('SELECT * FROM sessions WHERE id = $1', [req.params.id]);
    const messages = await pool.query(
      'SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ session: session.rows[0], messages: messages.rows });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// GET /api/admin/leads
app.get('/api/admin/leads', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM leads ORDER BY created_at DESC LIMIT 100');
    res.json({ leads: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// POST /api/admin/availability — toggle from dashboard
app.post('/api/admin/availability', adminAuth, async (req, res) => {
  const { online } = req.body;
  try {
    await pool.query(
      'UPDATE availability SET is_online = $1, updated_at = NOW() WHERE id = 1',
      [!!online]
    );
    res.json({ ok: true, online: !!online });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Serve admin dashboard HTML
app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/../public/admin.html');
});

app.use(express.static(path.join(__dirname, '../public')));

// ── Health check ──────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true }));

// ═══════════════════════════════════════════════
// TEAMS HELPERS
// ═══════════════════════════════════════════════

async function postToTeams(sessionId, name, email, message) {
  if (!process.env.TEAMS_WEBHOOK_URL) return;

  const card = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          {
            type: 'TextBlock',
            text: '💬 New chat from website visitor',
            weight: 'Bolder',
            size: 'Medium',
            color: 'Accent',
          },
          {
            type: 'FactSet',
            facts: [
              { title: 'Name', value: name },
              { title: 'Email', value: email },
              { title: 'Session ID', value: sessionId },
            ],
          },
          {
            type: 'TextBlock',
            text: `"${message}"`,
            wrap: true,
            isSubtle: true,
          },
        ],
        actions: [
          {
            type: 'Action.Http',
            title: '✋ Claim this chat',
            method: 'POST',
            url: `${getBackendUrl()}/api/teams/claim`,
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            body: JSON.stringify({ value: { sessionId, agentName: '{{agentName}}' } }),
          },
        ],
      },
    }],
  };

  await axios.post(process.env.TEAMS_WEBHOOK_URL, card).catch(console.error);
}

async function replyToTeamsThread(session, message, senderName) {
  if (!process.env.TEAMS_WEBHOOK_URL) return;
  const card = {
    type: 'message',
    text: `**${senderName}:** ${message}`,
  };
  await axios.post(process.env.TEAMS_WEBHOOK_URL, card).catch(console.error);
}

function getBackendUrl() {
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `http://localhost:${process.env.PORT || 3000}`;
}

function extractSessionFromText(text) {
  const match = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0] : null;
}

// ── Start server ──────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`GoChat server running on port ${PORT}`));
