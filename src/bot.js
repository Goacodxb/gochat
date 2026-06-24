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
      // Ignore messages from the bot itself
      if (context.activity.from?.id === context.activity.recipient?.id) {
        await next();
        return;
      }

      // Clean text - remove @mention tags
      let text = (context.activity.text || '');
      text = text.replace(/<at>[^<]*<\/at>/gi, '').trim();

      // Ignore empty or bot confirmation messages
      if (!text || text.startsWith('✅') || text.startsWith('❌') || text.startsWith('⚠️') || text.startsWith('👋')) {
        await next();
        return;
      }

      const from = context.activity.from?.name || 'Agent';
      console.log('Bot received clean message:', text, 'from:', from);

      // Handle commands - no sendActivity to avoid 401 loop
      if (text === '/goonline') {
        await pool.query('UPDATE availability SET is_online = true, updated_at = NOW() WHERE id = 1');
        console.log('GoChat set ONLINE');
        await next();
        return;
      }

      if (text === '/gooffline') {
        await pool.query('UPDATE availability SET is_online = false, updated_at = NOW() WHERE id = 1');
        console.log('GoChat set OFFLINE');
        await next();
        return;
      }

      // Extract session ID
      const sessionId = extractSessionId(text);

      if (!sessionId) {
        console.log('No session ID found in message');
        await next();
        return;
      }

      // Handle /close
      if (text.includes('/close')) {
        await pool.query(
          `UPDATE sessions SET status='closed', closed_at=NOW(), updated_at=NOW() WHERE id=$1`,
          [sessionId]
        );
        broadcastToSession(sessionId, { type: 'session_closed' });
        console.log('Session closed:', sessionId);
        await next();
        return;
      }

      // Extract message after session ID
      const messageContent = text.replace(sessionId, '').trim();

      if (!messageContent) {
        console.log('No message content found');
        await next();
        return;
      }

      try {
        const session = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);

        if (!session.rows.length) {
          console.log('Session not found:', sessionId);
          await next();
          return;
        }

        if (session.rows[0].status === 'closed') {
          console.log('Session already closed:', sessionId);
          await next();
          return;
        }

        // Claim if waiting
        if (session.rows[0].status === 'waiting') {
          await pool.query(
            `UPDATE sessions SET status='active', claimed_by=$1, updated_at=NOW() WHERE id=$2`,
            [from, sessionId]
          );
          broadcastToSession(sessionId, { type: 'agent_joined', agentName: from });
        }

        // Check for duplicate within 5 seconds
        const existing = await pool.query(
          `SELECT id FROM messages WHERE session_id=$1 AND sender_name=$2 AND content=$3 AND created_at > NOW() - INTERVAL '5 seconds'`,
          [sessionId, from, messageContent]
        );

        if (existing.rows.length > 0) {
          console.log('Duplicate message ignored');
          await next();
          return;
        }

        // Save message
        await pool.query(
          `INSERT INTO messages (session_id, sender_type, sender_name, content) VALUES ($1, 'agent', $2, $3)`,
          [sessionId, from, messageContent]
        );

        // Push to visitor
        broadcastToSession(sessionId, {
          type: 'agent_message',
          content: messageContent,
          senderName: from,
        });

        console.log('Reply sent to visitor:', messageContent);

      } catch (err) {
        console.error('Bot error:', err.message);
      }

      await next();
    });

    this.onMembersAdded(async (context, next) => {
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
