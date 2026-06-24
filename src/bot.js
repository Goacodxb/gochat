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
      if (!text || text.startsWith('✅') || text.startsWith('❌') || text.startsWith('⚠️') || text.startsWith('👋') || text.startsWith('💬')) {
        await next();
        return;
      }

      const from = context.activity.from?.name || 'Agent';
      console.log('Bot received clean message:', text, 'from:', from);

      // Get Teams conversation ID to find session
      const teamsConversationId = context.activity.conversation?.id;
      console.log('Teams conversation ID:', teamsConversationId);

      // Handle commands
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

      // Try to find session ID from message first
      let sessionId = extractSessionId(text);

      // If no session ID in message, look up by Teams conversation ID
      if (!sessionId && teamsConversationId) {
        const sessionByThread = await pool.query(
          `SELECT id FROM sessions WHERE teams_thread_id = $1 AND status != 'closed' ORDER BY created_at DESC LIMIT 1`,
          [teamsConversationId]
        ).catch(() => ({ rows: [] }));

        if (sessionByThread.rows.length > 0) {
          sessionId = sessionByThread.rows[0].id;
          console.log('Found session by Teams conversation ID:', sessionId);
        }
      }

      if (!sessionId) {
        console.log('No session found for this conversation');
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

      // Extract message — remove session ID if present
      const messageContent = text.replace(sessionId, '').trim();

      if (!messageContent) {
        console.log('No message content found');
        await next();
        return;
      }

      try {
        const session = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);

        if (!session.rows.length || session.rows[0].status === 'closed') {
          console.log('Session not found or closed:', sessionId);
          await next();
          return;
        }

        // Save Teams conversation ID for future replies without session ID
        if (teamsConversationId && !session.rows[0].teams_thread_id) {
          await pool.query(
            `UPDATE sessions SET teams_thread_id = $1 WHERE id = $2`,
            [teamsConversationId, sessionId]
          );
          console.log('Saved Teams conversation ID for session');
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
