const { ActivityHandler, TurnContext } = require('botbuilder');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

class GoChatBot extends ActivityHandler {
  constructor() {
    super();

    // Handle messages sent to the bot
    this.onMessage(async (context, next) => {
      const text = (context.activity.text || '').trim();
      const from = context.activity.from?.name || 'Agent';

      console.log('Bot received message:', text, 'from:', from);

      // Handle availability commands
      if (text === '/goonline') {
        await pool.query('UPDATE availability SET is_online = true, updated_at = NOW() WHERE id = 1');
        await context.sendActivity('✅ GoChat is now ONLINE — visitors will see live chat');
        return;
      }

      if (text === '/gooffline') {
        await pool.query('UPDATE availability SET is_online = false, updated_at = NOW() WHERE id = 1');
        await context.sendActivity('✅ GoChat is now OFFLINE — visitors will see lead form');
        return;
      }

      // Extract session ID from message
      const sessionId = extractSessionId(text);

      if (!sessionId) {
        // No session ID — check if it's a reply to a known session
        // Try to find active session for this agent
        await next();
        return;
      }

      // Handle /close command
      if (text.includes('/close')) {
        await pool.query(
          `UPDATE sessions SET status='closed', closed_at=NOW(), updated_at=NOW() WHERE id=$1`,
          [sessionId]
        );
        broadcastToSession(sessionId, { type: 'session_closed' });
        await context.sendActivity('✅ Chat session closed');
        return;
      }

      // Regular reply — extract the message after the session ID
      const messageContent = text.replace(sessionId, '').trim();

      if (!messageContent) {
        await context.sendActivity('Please include a message after the Session ID. Example:\n`' + sessionId + ' Hello, how can I help?`');
        return;
      }

      try {
        const session = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);

        if (!session.rows.length) {
          await context.sendActivity('❌ Session not found: ' + sessionId);
          return;
        }

        if (session.rows[0].status === 'closed') {
          await context.sendActivity('❌ This chat session is already closed.');
          return;
        }

        // Claim session if waiting
        if (session.rows[0].status === 'waiting') {
          await pool.query(
            `UPDATE sessions SET status='active', claimed_by=$1, updated_at=NOW() WHERE id=$2`,
            [from, sessionId]
          );
          broadcastToSession(sessionId, { type: 'agent_joined', agentName: from });
        }

        // Save message to database
        await pool.query(
          `INSERT INTO messages (session_id, sender_type, sender_name, content) VALUES ($1, 'agent', $2, $3)`,
          [sessionId, from, messageContent]
        );

        // Push to visitor via WebSocket
        broadcastToSession(sessionId, {
          type: 'agent_message',
          content: messageContent,
          senderName: from,
        });

        await context.sendActivity('✅ Reply sent to visitor!');

      } catch (err) {
        console.error('Bot error:', err);
        await context.sendActivity('❌ Error sending reply: ' + err.message);
      }

      await next();
    });

    // Welcome message when bot is added to a team
    this.onMembersAdded(async (context, next) => {
      const membersAdded = context.activity.membersAdded;
      for (const member of membersAdded) {
        if (member.id !== context.activity.recipient.id) {
          await context.sendActivity(
            '👋 GoChat Bot is ready!\n\n' +
            'To reply to a visitor, type:\n' +
            '`<Session ID> <your message>`\n\n' +
            'Commands:\n' +
            '• `/goonline` — set agents online\n' +
            '• `/gooffline` — set agents offline\n' +
            '• `<Session ID> /close` — end a chat'
          );
        }
      }
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
