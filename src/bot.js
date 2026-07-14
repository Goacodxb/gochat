const { ActivityHandler, TurnContext } = require('botbuilder');
const { Pool } = require('pg');
const axios = require('axios');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

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

async function postToThread(teamsConversationId, messageId, text) {
  try {
    const token = await getBotToken();
    const serviceUrl = process.env.TEAMS_SERVICE_URL || 'https://smba.trafficmanager.net/uk/67b4ecd2-df5b-4b66-8d2b-1203e33c7302/';
    const threadConvId = messageId
      ? `${teamsConversationId};messageid=${messageId}`
      : teamsConversationId;
    await axios.post(
      `${serviceUrl}v3/conversations/${encodeURIComponent(threadConvId)}/activities`,
      { type: 'message', text },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    console.log('Posted warning to thread ✅');
  } catch (err) {
    console.error('Thread warning error:', err.message);
  }
}

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

      // Deduplicate — ignore if same activity ID processed recently
      const activityId = context.activity.id;
      if (global.processedActivities?.has(activityId)) {
        console.log('Duplicate activity ignored:', activityId);
        await next();
        return;
      }
      if (!global.processedActivities) global.processedActivities = new Map();
      global.processedActivities.set(activityId, Date.now());
      if (global.processedActivities.size > 100) {
        const cutoff = Date.now() - 60000;
        for (const [key, time] of global.processedActivities) {
          if (time < cutoff) global.processedActivities.delete(key);
        }
      }

      const from = context.activity.from?.name || 'Agent';

      // Clean text - remove @mention tags
      let text = (context.activity.text || '');
      text = text.replace(/<at>[^<]*<\/at>/gi, '').trim();

      // Ignore empty or bot confirmation messages
      if (!text || text.startsWith('✅') || text.startsWith('❌') || text.startsWith('⚠️') || text.startsWith('👋') || text.startsWith('💬') || text.startsWith('🚫') || text.startsWith('⏰') || text.startsWith('⭕') || text.startsWith('🔄')) {
        await next();
        return;
      }

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
        await pool.query(
          `INSERT INTO agent_availability (agent_name, is_online, updated_at)
           VALUES ($1, true, NOW())
           ON CONFLICT (agent_name) DO UPDATE SET is_online = true, updated_at = NOW()`,
          [from]
        );
        console.log(from, 'set ONLINE');
        await postToThread(teamsConversationId, messageId, `✅ ${from} is now ONLINE`);
        await next();
        return;
      }

      if (text === '/gooffline') {
        await pool.query(
          `INSERT INTO agent_availability (agent_name, is_online, updated_at)
           VALUES ($1, false, NOW())
           ON CONFLICT (agent_name) DO UPDATE SET is_online = false, updated_at = NOW()`,
          [from]
        );
        console.log(from, 'set OFFLINE');
        await postToThread(teamsConversationId, messageId, `⭕ ${from} is now OFFLINE`);
        await next();
        return;
      }

      // Try to find session ID from message first
      let sessionId = extractSessionId(text);

      // First check exact match — including closed sessions to show warning
      if (!sessionId && messageId) {
        const exactSession = await pool.query(
          `SELECT id, status FROM sessions WHERE teams_activity_id = $1 LIMIT 1`,
          [messageId]
        ).catch(() => ({ rows: [] }));

        if (exactSession.rows.length > 0) {
          if (exactSession.rows[0].status === 'closed') {
            console.log('Session is closed — notifying agent in thread');
            await postToThread(
              teamsConversationId,
              messageId,
              `❌ This chat session has already been closed. The visitor is no longer available.`
            );
            await next();
            return;
          }
          sessionId = exactSession.rows[0].id;
          console.log('Found session by exact messageId:', sessionId);
        }
      }

      // Try by messageId range — active/waiting sessions only within 24 hours
      if (!sessionId && messageId) {
        const sessionByMessage = await pool.query(
          `SELECT id, claimed_by FROM sessions 
           WHERE teams_activity_id IS NOT NULL 
           AND status != 'closed'
           AND CAST(teams_activity_id AS BIGINT) <= $1
           AND created_at > NOW() - INTERVAL '24 hours'
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
          `SELECT id, claimed_by FROM sessions 
           WHERE teams_thread_id = $1 
           AND status != 'closed' 
           AND created_at > NOW() - INTERVAL '24 hours'
           ORDER BY created_at DESC LIMIT 1`,
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

      // Handle /reassign
      if (text.includes('/reassign')) {
        await pool.query(
          `UPDATE sessions SET status='waiting', claimed_by=NULL, claimed_by_id=NULL, updated_at=NOW() WHERE id=$1`,
          [sessionId]
        );
        broadcastToSession(sessionId, {
          type: 'agent_left',
          agentName: from
        });
        console.log('Session reassigned by:', from);
        await postToThread(
          teamsConversationId,
          messageId,
          `🔄 Chat has been reassigned by ${from}. Any available agent can now claim this conversation.`
        );
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
          await postToThread(
            teamsConversationId,
            messageId,
            `❌ This chat session has already been closed. The visitor is no longer available.`
          );
          await next();
          return;
        }

        const previousStatus = session.rows[0].status;
        let justClaimed = false;

        // Claim if waiting — use atomic update to prevent race conditions
        if (previousStatus === 'waiting') {
          const claimResult = await pool.query(
            `UPDATE sessions SET status='active', claimed_by=$1, claimed_by_id=$2, updated_at=NOW() 
             WHERE id=$3 AND status='waiting' RETURNING *`,
            [from, context.activity.from?.id || '', sessionId]
          );
          if (claimResult.rows.length > 0) {
            broadcastToSession(sessionId, { type: 'agent_joined', agentName: from });
            console.log('Session claimed by:', from, 'id:', context.activity.from?.id);
            justClaimed = true;
          } else {
            const updated = await pool.query('SELECT claimed_by FROM sessions WHERE id = $1', [sessionId]);
            const claimer = updated.rows[0]?.claimed_by || 'another agent';
            await postToThread(teamsConversationId, messageId,
              `🚫 **${from}** — This chat was just claimed by **${claimer}**.`
            );
            await next();
            return;
          }
        }
        // If already claimed by another agent — notify in thread and ignore
        else if (previousStatus === 'active' &&
                 session.rows[0].claimed_by &&
                 session.rows[0].claimed_by !== from) {
          console.log('Session already claimed by:', session.rows[0].claimed_by, '— ignoring:', from);
          await postToThread(
            teamsConversationId,
            messageId,
            `🚫 **${from}** — You cannot reply to this chat.\nThis conversation was claimed by **${session.rows[0].claimed_by}**.\nPlease look for unclaimed chats to assist visitors.`
          );
          await next();
          return;
        }

        // Save conversation reference
        const conversationRef = TurnContext.getConversationReference(context.activity);

        if (justClaimed) {
          // First claim — save everything including activity ID
          await pool.query(
            `UPDATE sessions SET teams_thread_id = $1, teams_conversation_ref = $2, teams_activity_id = $3 WHERE id = $4`,
            [teamsConversationId, JSON.stringify(conversationRef), messageId, sessionId]
          );
          console.log('Saved first reply — teams_activity_id:', messageId);
        } else {
          // Subsequent replies — only update conversation ref, NOT activity ID
          await pool.query(
            `UPDATE sessions SET teams_thread_id = $1, teams_conversation_ref = $2, updated_at = NOW() WHERE id = $3`,
            [teamsConversationId, JSON.stringify(conversationRef), sessionId]
          );
          console.log('Updated conversation ref — keeping original teams_activity_id');
        }

        // ── ISOLATED, FAIL-SAFE: visually update card to show "Claimed by"
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
            console.error('Card update failed (non-critical):', cardErr.message);
          }
        }

        // Check for duplicate within 30 seconds
        const existing = await pool.query(
          `SELECT id FROM messages WHERE session_id=$1 AND sender_name=$2 AND content=$3 AND created_at > NOW() - INTERVAL '30 seconds'`,
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
