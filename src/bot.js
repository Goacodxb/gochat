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
      // Remove @mentions and clean the text
      let text = (context.activity.text || '');
      // Ignore messages from the bot itself
  if (context.activity.from?.id === context.activity.recipient?.id) return;
  // Ignore bot confirmation messages
  if (text.includes('✅') || text.includes('❌') || text.includes('⚠️')) return;
      // Remove all <at>...</at> tags
      text = text.replace(/<at>[^<]*<\/at>/gi, '').trim();
      
      const from = context.activity.from?.name || 'Agent';

      console.log('Bot received clean message:', text, 'from:', from);

      // Handle availability commands
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

      // Extract session ID
      const sessionId = extractSessionId(text);

      if (!sessionId) {
        await context.sendActivity('⚠️ Please include a Session ID.\nExample: `SESSION-ID your message`');
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

      // Extract message after session ID
      const messageContent = text.replace(sessionId, '').trim();

      if (!messageContent) {
        await context.sendActivity('⚠️ Please include a message after the Session ID.');
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

        // Check if message already saved (prevent duplicates)
        const existing = await pool.query(
          `SELECT id FROM messages WHERE session_id=$1 AND sender_name=$2 AND content=$3 
           AND created_at > NOW() - INTERVAL '5 seconds'`,
          [sessionId, from, messageContent]
        );

        if (existing.rows.length > 0) {
          console.log('Duplicate message detected, skipping');
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

        await context.sendActivity('✅ Reply sent to visitor!');
        console.log('Reply sent to visitor:', messageContent);

      } catch (err) {
        console.error('Bot error:', err);
        await context.sendActivity('❌ Error: ' + err.message);
      }

      await next();
    });

    this.onMembersAdded(async (context, next) => {
      const membersAdded = context.activity.membersAdded;
      for (const member of membersAdded) {
        if (member.id !== context.activity.recipient.id) {
          await context.sendActivity(
            '👋 GoChat Bot ready!\n\nTo reply: `SESSION-ID your message`\n\nCommands:\n• `/goonline` — set online\n• `/gooffline` — set offline\n• `SESSION-ID /close` — end chat'
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
