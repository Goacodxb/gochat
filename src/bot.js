const { ActivityHandler, TurnContext } = require('botbuilder');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

class GoChatBot extends ActivityHandler {
  constructor(adapter) {
    super();
    this.adapter = adapter;

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

      // Remove messageid suffix from conversation ID for lookup
      const rawConversationId = context.activity.conversation?.id || '';
      const teamsConversationId = rawConversationId.split(';messageid=')[0];

      // Extract messageId for thread replies
      const messageId = rawConversationId.includes(';messageid=')
        ? rawConversationId.split(';messageid=')[1]
        : null;

      console.log('Bot received clean message:', text, 'from:', from);
      console.log('teamsConversationId:', teamsConversationId, 'messageId:', messageId);

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

      // Try by messageId range — find session whose thread started closest to this message
      if (!sessionId && messageId) {
        const sessionByMessage = await pool.query(
          `SELECT id, claimed_by FROM sessions 
           WHERE teams_activity_id IS NOT NULL 
           AND status != 'closed'
           AND CAST(teams_activity_id AS BIGINT) <= $1
           ORDER BY CAST(teams_activity_id AS BIGINT) DESC LIMIT 1`,
          [messageId]
        ).catch(() => ({ rows: [] }));

        if (sessionByMessage.rows.length > 0) {
          sessionId = sessionByMessage.rows[0].id;
          console.log('Found session by messageId range:', sessionId);
        }
      }

      // Fallback — look up by base Teams conversation ID
      if (!sessionId && teamsConversationId) {
        const sessionByThread = await pool.query(
          `SELECT id, claimed_by FROM sessions WHERE teams_thread_id = $1 AND status != 'closed' ORDER BY created_at DESC LIMIT 1`,
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

      // Handle /close or /end
      if (text.includes('/close') || text.includes('/end')) {
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
      const messageContent = text.replace(sessionId, '').replace(/^[\s.]+/, '').trim();

      if (!messageContent) {
        console.log('No message content found');
        await next();
        return;
      }

      try {
        const session = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);

        if (!session.rows.length || session.rows[0].status === 'closed') {
          console.log('Session not found or closed:', sessionId);
          // Notify agent that session is closed
          if (process.env.TEAMS_WEBHOOK_URL) {
            const axios = require('axios');
            await axios.post(process.env.TEAMS_WEBHOOK_URL, {
              type: 'message',
              text: `❌ This chat session has already been closed. The visitor is no longer available.`
            }).catch(err => console.error('Webhook notify error:', err.message));
          }
          await next();
          return;
        }

        let justClaimed = false;

        // Claim if waiting
        if (session.rows[0].status === 'waiting') {
          await pool.query(
            `UPDATE sessions SET status='active', claimed_by=$1, updated_at=NOW() WHERE id=$2`,
            [from, sessionId]
          );
          broadcastToSession(sessionId, { type: 'agent_joined', agentName: from });
          console.log('Session claimed by:', from);
          justClaimed = true;
        }
        // If already claimed by another agent — notify via webhook and ignore
        else if (session.rows[0].status === 'active' &&
                 session.rows[0].claimed_by &&
                 session.rows[0].claimed_by !== from) {
          console.log('Session already claimed by:', session.rows[0].claimed_by, '— ignoring:', from);
          // Notify agent via webhook (always works)
          if (process.env.TEAMS_WEBHOOK_URL) {
            const axios = require('axios');
            await axios.post(process.env.TEAMS_WEBHOOK_URL, {
              type: 'message',
              text: `🚫 **${from}** — You cannot reply to this chat.\nThis conversation was claimed by **${session.rows[0].claimed_by}**.\nPlease look for unclaimed chats to assist visitors.`
            }).catch(err => console.error('Webhook notify error:', err.message));
          }
          await next();
          return;
        }

        // Save EXACT conversation reference from TurnContext
        const conversationRef = TurnContext.getConversationReference(context.activity);

        if (session.rows[0].status === 'waiting') {
          // First reply — save everything including activity ID
          await pool.query(
            `UPDATE sessions SET teams_thread_id = $1, teams_conversation_ref = $2, teams_activity_id = $3 WHERE id = $4`,
            [teamsConversationId, JSON.stringify(conversationRef), messageId, sessionId]
          );
          console.log('Saved first reply — teams_activity_id:', messageId);
        } else {
          // Subsequent replies — only update conversation ref, NOT activity ID
          await pool.query(
            `UPDATE sessions SET teams_thread_id = $1, teams_conversation_ref = $2 WHERE id = $3`,
            [teamsConversationId, JSON.stringify(conversationRef), sessionId]
          );
          console.log('Updated conversation ref — keeping original teams_activity_id');
        }

        // ── ISOLATED, FAIL-SAFE: visually update the original card to show "Claimed by"
        // This is wrapped in its own try/catch so it can NEVER break claiming or messaging below.
        if (justClaimed) {
          try {
            const originalActivityId = session.rows[0].teams_activity_id || messageId;
            const updatedCard = {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              type: 'AdaptiveCard',
              version: '1.4',
              body: [
                { type: 'TextBlock', text: '💬 New chat from website visitor', weight: 'Bolder', size: 'Medium', color: 'Accent' },
                { type: 'FactSet', facts: [
                  { title: 'Name', value: session.rows[0].visitor_name },
                  { title: 'Email', value: session.rows[0].visitor_email },
                ]},
                { type: 'TextBlock', text: `✅ Claimed by ${from}`, weight: 'Bolder', color: 'Good' },
              ],
            };

            await this.adapter.continueConversation(conversationRef, async (updateContext) => {
              await updateContext.updateActivity({
                type: 'message',
                id: originalActivityId,
                attachments: [{
                  contentType: 'application/vnd.microsoft.card.adaptive',
                  content: updatedCard,
                }],
              });
            });
            console.log('Card visually updated to show claimed status ✅');
          } catch (cardErr) {
            // Never let this break the main flow — just log it
            console.error('Card update failed (non-critical):', cardErr.message);
          }
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
