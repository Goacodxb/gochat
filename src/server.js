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
const { BotFrameworkAdapter } = require('botbuilder');
const { GoChatBot } = require('./bot');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const resend = new Resend(process.env.RESEND_API_KEY);

app.use(cors({ origin: true, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-secret'], credentials: true }));
app.use(express.json());
app.set('trust proxy', 1);

const limiter = rateLimit({ windowMs: 60_000, max: 60 });
app.use('/api/', limiter);

const sessionClients = new Map();

function broadcastToSession(sessionId, payload) {
  const clients = sessionClients.get(sessionId);
  if (!clients) return;
  const msg = JSON.stringify(payload);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

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

// ── GET /api/availability
app.get('/api/availability', async (req, res) => {
  try {
    const result = await pool.query('SELECT is_online FROM availability WHERE id = 1');
    res.json({ online: result.rows[0]?.is_online ?? false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── POST /api/sessions
app.post('/api/sessions', async (req, res) => {
  const { name, email, firstMessage } = req.body;
  if (!name || !email || !firstMessage) {
    return res.status(400).json({ error: 'name, email and firstMessage are required' });
  }
  try {
    const sessionResult = await pool.query(
      `INSERT INTO sessions (visitor_name, visitor_email, status) VALUES ($1, $2, 'waiting') RETURNING id`,
      [name.trim(), email.trim().toLowerCase()]
    );
    const sessionId = sessionResult.rows[0].id;
    await pool.query(
      `INSERT INTO messages (session_id, sender_type, sender_name, content) VALUES ($1, 'visitor', $2, $3)`,
      [sessionId, name.trim(), firstMessage.trim()]
    );
    await postToTeams(sessionId, name.trim(), email.trim(), firstMessage.trim());
    res.json({ sessionId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// ── GET /api/sessions/:id/status
app.get('/api/sessions/:id/status', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT status FROM sessions WHERE id = $1', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Session not found' });
    res.json({ status: result.rows[0].status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── POST /api/sessions/:id/end — visitor ends chat
app.post('/api/sessions/:id/end', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query(
      `UPDATE sessions SET status = 'closed', closed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id]
    );
    broadcastToSession(id, { type: 'session_closed' });
    console.log('Session ended by visitor:', id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to end session' });
  }
});

// ── POST /api/sessions/:id/messages
app.post('/api/sessions/:id/messages', async (req, res) => {
  const { id } = req.params;
  const { content, senderName } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });

  // ── Abuse filter
  const abuseWords = ['fuck', 'shit', 'bastard', 'bitch', 'asshole', 'damn', 'crap'];
  const hasAbuse = abuseWords.some(word => content.toLowerCase().includes(word));
  if (hasAbuse) {
    return res.status(400).json({ error: 'Your message contains inappropriate content. Please keep the conversation respectful.' });
  }

  try {
    const session = await pool.query('SELECT * FROM sessions WHERE id = $1', [id]);
    if (!session.rows.length) return res.status(404).json({ error: 'Session not found' });
    if (session.rows[0].status === 'closed') return res.status(400).json({ error: 'Session is closed' });
    await pool.query(
      `INSERT INTO messages (session_id, sender_type, sender_name, content) VALUES ($1, 'visitor', $2, $3)`,
      [id, senderName || session.rows[0].visitor_name, content.trim()]
    );
    await replyToTeamsThread(session.rows[0], content.trim(), senderName || session.rows[0].visitor_name);
    broadcastToSession(id, { type: 'visitor_message', content: content.trim(), senderName });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ── GET /api/sessions/:id/messages
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

// ── POST /api/leads
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
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: process.env.LEAD_NOTIFICATION_EMAIL,
      subject: `New lead from ${name.trim()} — GoChat`,
      html: `<h2>New offline lead</h2><p><strong>Name:</strong> ${name.trim()}</p><p><strong>Email:</strong> ${email.trim()}</p><p><strong>Message:</strong></p><blockquote>${message.trim()}</blockquote>`,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save lead' });
  }
});

// ── POST /api/teams/claim
app.post('/api/teams/claim', async (req, res) => {
  res.sendStatus(200);
  const { sessionId, agentName } = req.body?.value || {};
  if (!sessionId || !agentName) return;
  try {
    const result = await pool.query(
      `UPDATE sessions SET status = 'active', claimed_by = $1, updated_at = NOW() WHERE id = $2 AND status = 'waiting' RETURNING *`,
      [agentName, sessionId]
    );
    if (result.rows.length) broadcastToSession(sessionId, { type: 'agent_joined', agentName });
  } catch (err) { console.error(err); }
});

// ── POST /api/teams/thread
app.post('/api/teams/thread', async (req, res) => {
  const { sessionId, messageId } = req.body;
  if (!sessionId || !messageId) return res.status(400).json({ error: 'Missing data' });
  try {
    await pool.query('UPDATE sessions SET teams_thread_id = $1 WHERE id = $2', [messageId, sessionId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

// ── ADMIN ROUTES
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-secret'] || req.query.secret;
  if (token !== process.env.ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/api/admin/sessions', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, COUNT(m.id) as message_count FROM sessions s LEFT JOIN messages m ON m.session_id = s.id GROUP BY s.id ORDER BY s.created_at DESC LIMIT 100`
    );
    res.json({ sessions: result.rows });
  } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

app.get('/api/admin/sessions/:id', adminAuth, async (req, res) => {
  try {
    const session = await pool.query('SELECT * FROM sessions WHERE id = $1', [req.params.id]);
    const messages = await pool.query('SELECT * FROM messages WHERE session_id = $1 ORDER BY created_at ASC', [req.params.id]);
    res.json({ session: session.rows[0], messages: messages.rows });
  } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

app.get('/api/admin/leads', adminAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM leads ORDER BY created_at DESC LIMIT 100');
    res.json({ leads: result.rows });
  } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

app.post('/api/admin/reply', adminAuth, async (req, res) => {
  const { sessionId, content, agentName } = req.body;
  if (!sessionId || !content) return res.status(400).json({ error: 'sessionId and content required' });
  try {
    const session = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    if (!session.rows.length) return res.status(404).json({ error: 'Session not found' });
    if (session.rows[0].status === 'closed') return res.status(400).json({ error: 'Session is closed' });
    if (session.rows[0].status === 'waiting') {
      await pool.query(
        `UPDATE sessions SET status = 'active', claimed_by = $1, updated_at = NOW() WHERE id = $2`,
        [agentName || 'Agent', sessionId]
      );
      broadcastToSession(sessionId, { type: 'agent_joined', agentName: agentName || 'Agent' });
    }
    await pool.query(
      `INSERT INTO messages (session_id, sender_type, sender_name, content) VALUES ($1, 'agent', $2, $3)`,
      [sessionId, agentName || 'Agent', content.trim()]
    );
    broadcastToSession(sessionId, { type: 'agent_message', content: content.trim(), senderName: agentName || 'Agent' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

app.post('/api/admin/close', adminAuth, async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  try {
    await pool.query(`UPDATE sessions SET status = 'closed', closed_at = NOW(), updated_at = NOW() WHERE id = $1`, [sessionId]);
    broadcastToSession(sessionId, { type: 'session_closed' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Failed to close session' }); }
});

app.post('/api/admin/availability', adminAuth, async (req, res) => {
  const { online } = req.body;
  try {
    await pool.query('UPDATE availability SET is_online = $1, updated_at = NOW() WHERE id = 1', [!!online]);
    res.json({ ok: true, online: !!online });
  } catch (err) { res.status(500).json({ error: 'Database error' }); }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.resolve(__dirname, '..', 'public', 'admin.html'));
});

app.use(express.static(path.join(__dirname, '../public')));

// ── Azure Bot Framework
const adapter = new BotFrameworkAdapter({
  appId: process.env.TEAMS_APP_ID,
  appPassword: process.env.TEAMS_APP_PASSWORD,
});

global.sessionClients = sessionClients;
global.botAdapter = adapter;
const bot = new GoChatBot(adapter);

app.post('/api/messages', async (req, res) => {
  console.log('Received at /api/messages');
  try {
    await adapter.processActivity(req, res, async (context) => {
      await bot.run(context);
    });
  } catch (err) {
    console.error('Bot Framework error:', err.message);
    if (!res.headersSent) res.status(200).send('ok');
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ── Bot Framework token
async function getBotToken() {
  const response = await axios.post(
    'https://login.microsoftonline.com/67b4ecd2-df5b-4b66-8d2b-1203e33c7302/oauth2/v2.0/token',
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.TEAMS_APP_ID,
      client_secret: process.env.TEAMS_APP_PASSWORD,
      scope: 'https://api.botframework.com/.default',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return response.data.access_token;
}

// ── Graph API token
async function getGraphToken() {
  const response = await axios.post(
    `https://login.microsoftonline.com/${process.env.APP_TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.TEAMS_APP_ID,
      client_secret: process.env.TEAMS_APP_PASSWORD,
      scope: 'https://graph.microsoft.com/.default',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return response.data.access_token;
}

// ── Post to Teams
async function postToTeams(sessionId, name, email, message) {
  const serviceUrl = process.env.TEAMS_SERVICE_URL || 'https://smba.trafficmanager.net/uk/67b4ecd2-df5b-4b66-8d2b-1203e33c7302/';
  const channelId = process.env.TEAMS_CHANNEL_ID;

  const cardFacts = [
    { title: 'Name', value: name },
    { title: 'Email', value: email },
    { title: 'Session ID', value: sessionId },
  ];

  if (channelId) {
    try {
      const token = await getBotToken();
      const createConvResponse = await axios.post(
        `${serviceUrl}v3/conversations`,
        {
          isGroup: true,
          channelData: { channel: { id: channelId } },
          activity: {
            type: 'message',
            attachments: [{
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: {
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                type: 'AdaptiveCard',
                version: '1.4',
                body: [
                  { type: 'TextBlock', text: '💬 New chat from website visitor', weight: 'Bolder', size: 'Medium', color: 'Accent' },
                  { type: 'FactSet', facts: cardFacts },
                  { type: 'TextBlock', text: `"${message}"`, wrap: true, isSubtle: true },
                ],
              },
            }],
          },
          bot: { id: `28:${process.env.TEAMS_APP_ID}`, name: 'gochat-bot' },
        },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );

      const conversationId = createConvResponse.data.id;
      const activityId = createConvResponse.data.activityId;
      console.log('Posted to Teams via Bot Framework ✅ conversationId:', conversationId);

      await pool.query(
        'UPDATE sessions SET teams_thread_id = $1, teams_conversation_ref = $2, teams_activity_id = $3 WHERE id = $4',
        [conversationId, JSON.stringify({ conversationId, activityId, serviceUrl, botId: `28:${process.env.TEAMS_APP_ID}` }), activityId, sessionId]
      );
      return;
    } catch (err) {
      console.error('Bot Framework postToTeams error:', err.response?.data || err.message);
      console.log('Falling back to webhook...');
    }
  }

  if (!process.env.TEAMS_WEBHOOK_URL) return;
  await axios.post(process.env.TEAMS_WEBHOOK_URL, {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: '💬 New chat from website visitor', weight: 'Bolder', size: 'Medium', color: 'Accent' },
          { type: 'FactSet', facts: cardFacts },
          { type: 'TextBlock', text: `"${message}"`, wrap: true, isSubtle: true },
        ],
      },
    }],
  })
  .then(() => console.log('Posted to Teams via webhook ✅'))
  .catch(err => console.error('Webhook error:', err.message));
}

// ── Reply to Teams thread
async function replyToTeamsThread(session, message, senderName) {
  console.log('Sending visitor follow-up to Teams:', message);

  // Build @mention if we have agent's Teams ID
  const agentId = session.claimed_by_id;
  const agentName = session.claimed_by;
  
  let mentionText = '';
  let entities = [];
  
  if (agentId && agentName) {
    mentionText = `<at>${agentName}</at> `;
    entities = [{
      type: 'mention',
      text: `<at>${agentName}</at>`,
      mentioned: {
        id: agentId,
        name: agentName
      }
    }];
  }

  const adaptiveCard = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      { type: 'TextBlock', text: `💬 ${senderName} (visitor)`, weight: 'Bolder', color: 'Accent' },
      { type: 'TextBlock', text: message, wrap: true },
      { type: 'TextBlock', text: agentName ? `Claimed by: ${agentName}` : `To reply: @GoChat ${session.id} <your message>`, wrap: true, isSubtle: true, size: 'Small' },
    ],
  };

  if (session.teams_conversation_ref) {
    try {
      const ref = JSON.parse(session.teams_conversation_ref);
      const serviceUrl = ref.serviceUrl;
      const fullConversationId = ref.conversation?.id || session.teams_thread_id;
      const conversationId = fullConversationId.split(';messageid=')[0];
      const activityId = session.teams_activity_id;
      const token = await getBotToken();
      const threadConversationId = activityId ? `${conversationId};messageid=${activityId}` : conversationId;

      // Post with @mention if agent ID is available, otherwise just adaptive card
      const messageBody = agentId ? {
        type: 'message',
        text: `${mentionText}New message from ${senderName}: "${message}"`,
        entities: entities,
      } : {
        type: 'message',
        attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: adaptiveCard }],
      };

      await axios.post(
        `${serviceUrl}v3/conversations/${encodeURIComponent(threadConversationId)}/activities`,
        messageBody,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
      console.log('Visitor follow-up sent via Bot Framework REST ✅' + (agentId ? ' with @mention' : ''));
      return;
    } catch (err) {
      console.error('Bot Framework REST error:', err.response?.data || err.message);
    }
  }

  if (!process.env.TEAMS_WEBHOOK_URL) return;
  await axios.post(process.env.TEAMS_WEBHOOK_URL, {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: adaptiveCard }],
  }).catch(err => console.error('Webhook error:', err.message));
}

function extractSessionFromText(text) {
  const match = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0] : null;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`GoChat server running on port ${PORT}`));

// ── Auto-release idle claimed sessions (every 2 minutes)
const AUTO_RELEASE_MINUTES = 10;
setInterval(async () => {
  try {
    const result = await pool.query(`
      UPDATE sessions
      SET status = 'waiting', claimed_by = NULL, updated_at = NOW()
      WHERE status = 'active'
      AND updated_at < NOW() - INTERVAL '${AUTO_RELEASE_MINUTES} minutes'
      RETURNING id, visitor_name, claimed_by
    `);
    if (result.rows.length > 0) {
      result.rows.forEach(session => {
        console.log('Auto-released idle session:', session.id);
        broadcastToSession(session.id, { type: 'agent_left' });
      });
    }
  } catch (err) {
    console.error('Auto-release error:', err.message);
  }
}, 2 * 60 * 1000);
