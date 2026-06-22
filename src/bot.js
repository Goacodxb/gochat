const { ActivityHandler } = require('botbuilder');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

class GoChatBot extends ActivityHandler {
  constructor() {
    super();
    this.onMessage(async (context, next) => {
      const text = context.activity.text?.trim() || '';
      const from = context.activity.from?.name || 'Agent';

      if (text === '/goonline') {
        await pool.query('UPDATE availability SET is_online = true, updated_at = NOW() WHERE id = 1');
        await context.sendActivity('✅ GoChat is now ONLINE');
        return;
      }
      if (text === '/gooffline') {
        await pool.query('UPDATE availability SET is_online = false, updated_at = NOW() WHERE id = 1');
        await context.sendActivity('✅ GoChat is now OFFLINE');
        return;
      }

      const sessionId = extractSessionId(text);
      if (!sessionId) return;

      if (text.includes('/close')) {
        await pool.query(
          `UPDATE sessions SET status='closed', closed_at=NOW() WHERE id=$1`,
          [sessionId]
        );
        broadcastToSession(sessionId, { type: 'session_closed' });
        await context.sendActivity('✅ Chat session closed');
        return;
      }

      await pool.query(
        `INSERT INTO messages (session_id, sender_type, sender_name, content)
         VALUES ($1, 'agent', $2, $3)`,
        [sessionId, from, text]
      );

      broadcastToSession(sessionId, {
        type: 'agent_message',
        content: text,
        senderName: from,
      });

      await next();
    });
  }
}

function extractSessionId(text) {
  const match = text?.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  );
  return match ? match[0] : null;
}

function broadcastToSession(sessionId, payload) {
  const clients = global.sessionClients?.get(sessionId);
  if (!clients) return;
  const msg = JSON.stringify(payload);
  clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

module.exports = { GoChatBot };
