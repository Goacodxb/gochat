(function () {
  'use strict';
  var BACKEND_URL = 'https://gochat-production-0f6f.up.railway.app';
  var POLL_INTERVAL = 30000;
  var MESSAGE_POLL = 3000;
  var sessionId = null;
  var visitorName = null;
  var lastMessageTime = new Date().toISOString();
  var messagePoller = null;
  var availabilityPoller = null;
  var ws = null;
  var isOnline = false;
  var agentJoined = false;
  var sessionClosed = false;
  var currentAgent = null;

  // ── Icons
  var ONLINE_ICON  = '<img src="' + BACKEND_URL + '/img/Online.png"  style="width:58px;height:58px;object-fit:contain;" alt="Chat">';
  var OFFLINE_ICON = '<img src="' + BACKEND_URL + '/img/Offline.png" style="width:58px;height:58px;object-fit:contain;" alt="Chat">';
  var CHAT_ICON    = '<img src="' + BACKEND_URL + '/img/Chating.png" style="width:58px;height:58px;object-fit:contain;" alt="Chat">';

  var style = document.createElement('style');
  style.textContent = `
    #gc-launcher {
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      width: 58px; height: 58px; border-radius: 50%;
      background: transparent; border: none;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s;
    }
    #gc-launcher:hover { transform: scale(1.08); }
    #gc-online-dot {
      position: fixed; bottom: 62px; right: 24px; z-index: 10000;
      width: 14px; height: 14px; border-radius: 50%;
      background: #22c55e; border: 2px solid white; display: none;
    }
    #gc-widget {
      position: fixed; bottom: 90px; right: 24px; z-index: 9998;
      width: 360px; background: white; border-radius: 14px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.18);
      display: none; flex-direction: column; overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      max-height: 560px; border: 1px solid #1e3a5f;
    }
    #gc-widget.open { display: flex; }
    #gc-header {
      background: #0f1d3a; color: white; padding: 14px 16px;
      display: flex; justify-content: space-between; align-items: center;
    }
    #gc-header-left { display: flex; align-items: center; gap: 10px; }
    #gc-avatar {
      width: 38px; height: 38px; border-radius: 50%;
      background: #1e3a5f; border: 1px solid #2a4a7a;
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; flex-shrink: 0; overflow: hidden;
    }
    #gc-avatar img { width: 100%; height: 100%; object-fit: cover; }
    #gc-header h3 { font-size: 14px; font-weight: 600; margin: 0; }
    #gc-header-status { font-size: 11px; margin: 3px 0 0; display: flex; align-items: center; gap: 4px; }
    #gc-status-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
    #gc-header-actions { display: flex; align-items: center; gap: 8px; }
    #gc-close {
      background: none; border: none; color: #94a3b8;
      font-size: 20px; cursor: pointer; padding: 0; line-height: 1;
    }
    #gc-close:hover { color: white; }
    #gc-body { padding: 16px; flex: 1; overflow-y: auto; }
    #gc-welcome-msg { border-radius: 8px; padding: 10px 0; margin-bottom: 14px; }
    #gc-welcome-msg p { font-size: 13px; color: #0f1d3a; margin: 0; }
    .gc-field-label {
      font-size: 11px; color: #6b7280; font-weight: 600;
      display: block; margin-bottom: 3px; text-transform: uppercase; letter-spacing: 0.3px;
    }
    .gc-field-error { color: #dc2626; font-size: 12px; margin: 4px 0 0 2px; display: none; }
    .gc-offline-error { color: #dc2626; font-size: 12px; margin: 4px 0 0 2px; display: none; }
    #gc-form { display: flex; flex-direction: column; gap: 10px; }
    #gc-form input, #gc-form textarea {
      width: 100%; padding: 9px 12px; border: 1px solid #e5e7eb;
      border-radius: 6px; font-size: 13px; font-family: inherit;
      resize: none; box-sizing: border-box; color: #111827;
    }
    #gc-form input:focus, #gc-form textarea:focus {
      outline: none; border-color: #0f1d3a;
      box-shadow: 0 0 0 2px rgba(15,29,58,0.1);
    }
    #gc-form input.gc-input-error, #gc-form textarea.gc-input-error { border-color: #dc2626; }
    #gc-send {
      padding: 11px; background: #0f1d3a; color: white; border: none;
      border-radius: 8px; font-size: 14px; font-weight: 600;
      cursor: pointer; display: flex; align-items: center;
      justify-content: center; gap: 6px; margin-top: 2px;
    }
    #gc-send:hover { background: #1a2f5a; }
    #gc-send:disabled { opacity: 0.5; cursor: not-allowed; }
    #gc-privacy {
      font-size: 11px; color: #9ca3af; text-align: center;
      margin-top: 8px; display: flex; align-items: center;
      justify-content: center; gap: 4px;
    }
    #gc-messages {
      display: flex; flex-direction: column; gap: 8px;
      margin-bottom: 12px; min-height: 40px;
    }
    .gc-msg { max-width: 80%; padding: 9px 12px; border-radius: 10px; font-size: 14px; line-height: 1.4; }
    .gc-msg.visitor { background: #0f1d3a; color: white; align-self: flex-end; border-bottom-right-radius: 2px; }
    .gc-msg.agent { background: #f3f4f6; color: #111827; align-self: flex-start; border-bottom-left-radius: 2px; }
    .gc-msg.system { background: #eff6ff; color: #1e40af; align-self: center; font-size: 12px; border-radius: 20px; padding: 6px 14px; max-width: 90%; text-align: center; }
    .gc-msg .gc-sender { font-size: 10px; opacity: 0.7; margin-bottom: 3px; }
    #gc-chat-status { font-size: 12px; color: #6b7280; text-align: center; padding: 6px 0; font-style: italic; }
    #gc-abuse-error {
      display: none; background: #fef2f2; border: 1px solid #fecaca;
      border-radius: 6px; padding: 8px 12px; margin-top: 4px;
      font-size: 12px; color: #dc2626; text-align: center;
    }
    #gc-waiting-box {
      display: none; background: #f8fafc; border: 1px dashed #cbd5e1;
      border-radius: 8px; padding: 16px; text-align: center; margin-top: 8px;
    }
    #gc-waiting-box p { font-size: 13px; color: #64748b; margin: 0 0 6px; }
    .gc-spinner {
      width: 24px; height: 24px; border: 3px solid #e2e8f0;
      border-top-color: #0f1d3a; border-radius: 50%;
      animation: gc-spin 0.8s linear infinite; margin: 0 auto 10px;
    }
    @keyframes gc-spin { to { transform: rotate(360deg); } }
    #gc-ended-box {
      display: none; background: #0f1d3a; border: 1px solid #69727d;
      border-radius: 8px; padding: 16px; text-align: center; margin-top: 8px;
    }
    #gc-ended-box p { font-size: 13px; color: #ffffff; margin: 0; }
    #gc-chat-input {
      display: none; gap: 8px; padding: 10px 16px 14px;
      border-top: 1px solid #f3f4f6; flex-direction: column;
    }
    #gc-chat-input.active { display: flex; }
    #gc-chat-input-row { display: flex; gap: 8px; }
    #gc-msg-input {
      flex: 1; padding: 9px 12px; border: 1px solid #e5e7eb;
      border-radius: 8px; font-size: 14px; font-family: inherit;
    }
    #gc-msg-input:focus { outline: none; border-color: #0f1d3a; }
    #gc-chat-send {
      padding: 9px 14px; background: #0f1d3a; color: white;
      border: none; border-radius: 8px; cursor: pointer; font-size: 16px;
    }
    #gc-chat-send:hover { background: #1a2f5a; }
    #gc-visitor-end-btn {
      width: 100%; padding: 8px; background: none; border: 1px solid #0f1d3a;
      border-radius: 8px; font-size: 12px; color: #0f1d3a;
      cursor: pointer; margin-top: 2px;
    }
    #gc-visitor-end-btn:hover { background: #0f1d3a; color: #ffffff; }
    #gc-offline-fields { display: flex; flex-direction: column; gap: 10px; }
    .gc-offline-input {
      width: 100%; padding: 9px 12px; border: 1px solid #e5e7eb;
      border-radius: 6px; font-size: 13px; font-family: inherit;
      box-sizing: border-box; color: #111827;
    }
    .gc-offline-input:focus { outline: none; border-color: #0f1d3a; }
    .gc-offline-input.gc-input-error { border-color: #dc2626; }
    #gc-off-send {
      padding: 11px; background: #0f1d3a; color: white;
      border: none; border-radius: 8px; font-size: 14px;
      font-weight: 600; cursor: pointer; width: 100%;
    }
    #gc-off-send:hover { background: #1a2f5a; }
    #gc-off-success {
      display: none; font-size: 14px; color: #ffffff;
      background: #0f1d3a; padding: 12px; border-radius: 8px; margin-top: 8px;
    }
  `;
  document.head.appendChild(style);

  var onlineDot = document.createElement('div');
  onlineDot.id = 'gc-online-dot';
  document.body.appendChild(onlineDot);

  var launcher = document.createElement('button');
  launcher.id = 'gc-launcher';
  launcher.innerHTML = OFFLINE_ICON;
  launcher.setAttribute('aria-label', 'Open chat');

  var widget = document.createElement('div');
  widget.id = 'gc-widget';
  widget.setAttribute('role', 'dialog');
  widget.setAttribute('aria-label', 'Live chat');

  widget.innerHTML = `
    <div id="gc-header">
      <div id="gc-header-left">
        <div id="gc-avatar">
          <img src="${BACKEND_URL}/img/Chating.png" alt="GoIdentity" onerror="this.parentElement.innerHTML='🏢'">
        </div>
        <div>
          <h3>GoIdentity Support</h3>
          <div id="gc-header-status">
            <span id="gc-status-dot" style="background:#94a3b8"></span>
            <span id="gc-status-text">Checking availability...</span>
          </div>
        </div>
      </div>
      <div id="gc-header-actions">
        <button id="gc-close" aria-label="Close chat">×</button>
      </div>
    </div>
    <div id="gc-body">
      <!-- Pre-chat form (Online) -->
      <div id="gc-prechat">
        <div id="gc-welcome-msg">
          <p>👋 Hi! How can the GoIdentity team help you today?</p>
        </div>
        <div id="gc-form">
          <div>
            <input id="gc-name" type="text" placeholder="Full name" required>
            <p id="gc-name-error" class="gc-field-error">Please enter your name.</p>
          </div>
          <div>
            <input id="gc-email" type="email" placeholder="Email address" required>
            <p id="gc-email-error" class="gc-field-error">Please enter a valid email address.</p>
          </div>
          <div>
            <textarea id="gc-first-msg" rows="3" placeholder="Tell us about your enquiry..."></textarea>
            <p id="gc-msg-error" class="gc-field-error">Please describe your enquiry.</p>
          </div>
          <button id="gc-send">➤ Start conversation</button>
          <div id="gc-privacy">🔒 Your information is secure and private</div>
        </div>
      </div>
      <!-- Live chat view -->
      <div id="gc-chat" style="display:none">
        <div id="gc-messages"></div>
        <div id="gc-waiting-box">
          <div class="gc-spinner"></div>
          <p>Please wait while we connect you to an agent...</p>
          <p style="font-size:11px;color:#94a3b8;margin-top:4px">You will be able to type once an agent joins</p>
        </div>
        <div id="gc-ended-box">
          <p>✅ Chat ended. Thank you for contacting GoIdentity!</p>
          <p style="font-size:12px;color:#94a3b8;margin-top:4px">Our team will follow up via email if needed.</p>
        </div>
        <p id="gc-chat-status"></p>
      </div>
      <!-- Offline form -->
      <div id="gc-offline" style="display:none">
        <div id="gc-welcome-msg" style="border-left-color:#f59e0b;background:#fffbeb;padding-left:10px">
          <p style="color:#92400e">⏰ We're currently offline. Leave your details and we'll get back to you soon.</p>
        </div>
        <div id="gc-offline-fields">
          <div>
            <input id="gc-off-name" class="gc-offline-input" type="text" placeholder="Full name" required>
            <p id="gc-off-name-error" class="gc-offline-error">Please enter your name.</p>
          </div>
          <div>
            <input id="gc-off-email" class="gc-offline-input" type="email" placeholder="Email address" required>
            <p id="gc-off-email-error" class="gc-offline-error">Please enter a valid email address.</p>
          </div>
          <div>
            <textarea id="gc-off-msg" class="gc-offline-input" rows="3" placeholder="Tell us how we can help..."></textarea>
            <p id="gc-off-msg-error" class="gc-offline-error">Please describe your enquiry.</p>
          </div>
          <button id="gc-off-send">📩 Send enquiry</button>
          <div style="font-size:11px;color:#9ca3af;text-align:center;margin-top:4px">🔒 Your information is secure and private</div>
        </div>
        <p id="gc-off-success">✅ Thanks! A member of our team will be in touch soon.</p>
      </div>
    </div>
    <!-- Chat input — hidden until agent joins -->
    <div id="gc-chat-input">
      <div id="gc-chat-input-row">
        <input id="gc-msg-input" type="text" placeholder="Type a message..." autocomplete="off">
        <button id="gc-chat-send">➤</button>
      </div>
      <div id="gc-abuse-error">⚠️ Your message contains inappropriate content. Please keep the conversation respectful.</div>
      <button id="gc-visitor-end-btn">End conversation</button>
    </div>
  `;

  document.body.appendChild(launcher);
  document.body.appendChild(widget);

  // ── Open/close ─────────────────────────────────────────
  launcher.addEventListener('click', function () {
    var isOpen = widget.classList.contains('open');
    if (isOpen) {
      widget.classList.remove('open');
      launcher.innerHTML = isOnline ? ONLINE_ICON : OFFLINE_ICON;
    } else {
      widget.classList.add('open');
      launcher.innerHTML = CHAT_ICON;
      checkAvailability();
    }
  });

  document.getElementById('gc-close').addEventListener('click', function () {
    widget.classList.remove('open');
    launcher.innerHTML = isOnline ? ONLINE_ICON : OFFLINE_ICON;
  });

  // ── End chat ───────────────────────────────────────────
  document.getElementById('gc-visitor-end-btn').addEventListener('click', function () {
    if (!sessionId) return;
    if (!confirm('Are you sure you want to end this chat?')) return;
    endChat();
  });

  function endChat() {
    fetch(BACKEND_URL + '/api/sessions/' + sessionId + '/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }).then(function () { onSessionClosed(); }).catch(console.error);
  }

  // ── Availability ───────────────────────────────────────
  function checkAvailability() {
    fetch(BACKEND_URL + '/api/availability')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        isOnline = d.online;
        var dot = document.getElementById('gc-status-dot');
        var text = document.getElementById('gc-status-text');
        if (d.online) {
          dot.style.background = '#22c55e';
          text.textContent = 'Online — typically replies instantly';
          onlineDot.style.display = 'block';
          if (!widget.classList.contains('open')) launcher.innerHTML = ONLINE_ICON;
        } else {
          dot.style.background = '#f59e0b';
          text.textContent = 'Currently offline';
          onlineDot.style.display = 'none';
          if (!widget.classList.contains('open')) launcher.innerHTML = OFFLINE_ICON;
        }
        if (!sessionId) {
          document.getElementById('gc-prechat').style.display = d.online ? '' : 'none';
          document.getElementById('gc-offline').style.display = d.online ? 'none' : '';
        }
      })
      .catch(function () {
        document.getElementById('gc-status-text').textContent = 'Checking...';
      });
  }

  availabilityPoller = setInterval(checkAvailability, POLL_INTERVAL);
  checkAvailability();

  // ── Restore session after page refresh ─────────────────
  (function restoreSession() {
    var savedSessionId = localStorage.getItem('gc_sessionId');
    var savedName = localStorage.getItem('gc_visitorName');
    if (!savedSessionId || !savedName) return;
    fetch(BACKEND_URL + '/api/sessions/' + savedSessionId + '/status')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.status === 'active' || d.status === 'waiting') {
          sessionId = savedSessionId;
          visitorName = savedName;
          document.getElementById('gc-prechat').style.display = 'none';
          document.getElementById('gc-offline').style.display = 'none';
          document.getElementById('gc-chat').style.display = '';
          document.getElementById('gc-waiting-box').style.display = d.status === 'waiting' ? 'block' : 'none';
          fetch(BACKEND_URL + '/api/sessions/' + savedSessionId + '/messages?since=1970-01-01')
            .then(function(r) { return r.json(); })
            .then(function(data) {
              (data.messages || []).forEach(function(m) {
                if (m.sender_type === 'agent') {
                  if (!agentJoined) onAgentJoined(m.sender_name || 'Agent');
                  addMessage('agent', m.sender_name, m.content);
                } else {
                  addMessage('visitor', m.sender_name, m.content);
                }
                lastMessageTime = m.created_at;
              });
            });
          connectWebSocket();
          widget.classList.add('open');
          launcher.innerHTML = CHAT_ICON;
        } else {
          localStorage.removeItem('gc_sessionId');
          localStorage.removeItem('gc_visitorName');
        }
      })
      .catch(function() {
        localStorage.removeItem('gc_sessionId');
        localStorage.removeItem('gc_visitorName');
      });
  })();

  // ── Start chat (Online) ────────────────────────────────
  document.getElementById('gc-send').addEventListener('click', function () {
    var name  = document.getElementById('gc-name').value.trim();
    var email = document.getElementById('gc-email').value.trim();
    var msg   = document.getElementById('gc-first-msg').value.trim();
    document.querySelectorAll('.gc-field-error').forEach(function (el) { el.style.display = 'none'; });
    ['gc-name', 'gc-email', 'gc-first-msg'].forEach(function(id) {
      document.getElementById(id).classList.remove('gc-input-error');
    });
    var hasError = false;
    if (!name) {
      document.getElementById('gc-name-error').style.display = 'block';
      document.getElementById('gc-name').classList.add('gc-input-error');
      hasError = true;
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      document.getElementById('gc-email-error').textContent = !email ? 'Please enter your email address.' : 'Please enter a valid email address.';
      document.getElementById('gc-email-error').style.display = 'block';
      document.getElementById('gc-email').classList.add('gc-input-error');
      hasError = true;
    }
    if (!msg) {
      document.getElementById('gc-msg-error').style.display = 'block';
      document.getElementById('gc-first-msg').classList.add('gc-input-error');
      hasError = true;
    }
    if (hasError) return;
    visitorName = name;
    var btn = document.getElementById('gc-send');
    btn.disabled = true;
    btn.textContent = '⏳ Connecting...';
    fetch(BACKEND_URL + '/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, email: email, firstMessage: msg }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.sessionId) throw new Error('No session ID returned');
        sessionId = d.sessionId;
        visitorName = name;
        localStorage.setItem('gc_sessionId', sessionId);
        localStorage.setItem('gc_visitorName', name);
        showChatView(name, msg);
        connectWebSocket();
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = '➤ Start conversation';
        document.getElementById('gc-name-error').textContent = 'Something went wrong. Please try again.';
        document.getElementById('gc-name-error').style.display = 'block';
      });
  });

  // ── Show chat view ─────────────────────────────────────
  function showChatView(name, firstMsg) {
    document.getElementById('gc-prechat').style.display = 'none';
    document.getElementById('gc-chat').style.display = '';
    if (firstMsg) addMessage('visitor', name, firstMsg);
    document.getElementById('gc-waiting-box').style.display = 'block';
  }

  // ── Agent joined ───────────────────────────────────────
  function onAgentJoined(agentName) {
    if (agentJoined && currentAgent === agentName) return;
    agentJoined = true;
    currentAgent = agentName;
    document.getElementById('gc-waiting-box').style.display = 'none';
    addSystemMessage('🎉 ' + agentName + ' has joined the chat');
    document.getElementById('gc-status-dot').style.background = '#22c55e';
    document.getElementById('gc-status-text').textContent = 'Connected with ' + agentName;
    document.getElementById('gc-chat-input').classList.add('active');
    document.getElementById('gc-msg-input').focus();
  }

  // ── Agent left (auto-release) ──────────────────────────
  function onAgentLeft() {
    if (!agentJoined) return;
    agentJoined = false;
    currentAgent = null;
    document.getElementById('gc-chat-input').classList.remove('active');
    document.getElementById('gc-waiting-box').style.display = 'block';
    document.getElementById('gc-status-dot').style.background = '#f59e0b';
    document.getElementById('gc-status-text').textContent = 'Waiting for an agent...';
    addSystemMessage('⏳ Agent disconnected. Please wait while we connect you to another agent...');
  }

  // ── Session closed ─────────────────────────────────────
  function onSessionClosed() {
    if (sessionClosed) return;
    sessionClosed = true;
    localStorage.removeItem('gc_sessionId');
    localStorage.removeItem('gc_visitorName');
    document.getElementById('gc-chat-input').classList.remove('active');
    document.getElementById('gc-waiting-box').style.display = 'none';
    document.getElementById('gc-ended-box').style.display = 'block';
    document.getElementById('gc-status-dot').style.background = '#94a3b8';
    document.getElementById('gc-status-text').textContent = 'Chat ended';
    stopMessagePolling();
  }

  // ── Send message ───────────────────────────────────────
  function sendMessage() {
    var input = document.getElementById('gc-msg-input');
    var content = input.value.trim();
    var abuseEl = document.getElementById('gc-abuse-error');
    if (!content || !sessionId || sessionClosed) return;
    abuseEl.style.display = 'none';
    input.value = '';
    fetch(BACKEND_URL + '/api/sessions/' + sessionId + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content, senderName: visitorName }),
    })
    .then(function(r) {
      if (!r.ok) {
        return r.json().then(function(d) {
          if (r.status === 400 && d.error && d.error.includes('inappropriate')) {
            abuseEl.style.display = 'block';
            input.value = content;
          }
        });
      }
      addMessage('visitor', visitorName, content);
    })
    .catch(console.error);
  }

  document.getElementById('gc-chat-send').addEventListener('click', sendMessage);
  document.getElementById('gc-msg-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // ── WebSocket ──────────────────────────────────────────
  var wsConnected = false;

  function connectWebSocket() {
    if (!sessionId) return;
    var wsUrl = BACKEND_URL.replace(/^http/, 'ws') + '?sessionId=' + sessionId;
    ws = new WebSocket(wsUrl);
    ws.onopen = function () { wsConnected = true; stopMessagePolling(); };
    ws.onmessage = function (e) {
      try {
        var data = JSON.parse(e.data);
        if (data.type === 'agent_message') {
          if (sessionClosed) return;
          if (!agentJoined) onAgentJoined(data.senderName || 'Agent');
          addMessage('agent', data.senderName || 'Agent', data.content);
          lastMessageTime = new Date().toISOString();
          document.getElementById('gc-chat-status').textContent = '';
        } else if (data.type === 'agent_joined') {
          onAgentJoined(data.agentName || 'Agent');
        } else if (data.type === 'agent_left') {
          onAgentLeft();
        } else if (data.type === 'session_closed') {
          onSessionClosed();
        }
      } catch (err) { console.error(err); }
    };
    ws.onerror = function () { wsConnected = false; startMessagePolling(); };
    ws.onclose = function () { wsConnected = false; startMessagePolling(); };
  }

  // ── Long-poll fallback + session status check ──────────
  function startMessagePolling() {
    if (messagePoller || wsConnected) return;
    messagePoller = setInterval(function () {
      if (!sessionId || wsConnected) return;
      fetch(BACKEND_URL + '/api/sessions/' + sessionId + '/status')
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.status === 'closed' && !sessionClosed) onSessionClosed();
          if (d.status === 'waiting' && agentJoined) onAgentLeft();
        }).catch(console.error);
      fetch(BACKEND_URL + '/api/sessions/' + sessionId + '/messages?since=' + encodeURIComponent(lastMessageTime))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          (d.messages || []).forEach(function (m) {
            if (m.sender_type === 'agent') {
              if (sessionClosed) return;
              if (!agentJoined) onAgentJoined(m.sender_name || 'Agent');
              addMessage('agent', m.sender_name, m.content);
              document.getElementById('gc-chat-status').textContent = '';
            }
            lastMessageTime = m.created_at;
          });
        })
        .catch(console.error);
    }, MESSAGE_POLL);
  }

  function stopMessagePolling() { clearInterval(messagePoller); messagePoller = null; }

  // ── Message bubbles ────────────────────────────────────
  function addMessage(type, name, content) {
    var container = document.getElementById('gc-messages');
    var div = document.createElement('div');
    div.className = 'gc-msg ' + type;
    div.innerHTML = '<div class="gc-sender">' + escHtml(name) + '</div>' + escHtml(content);
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function addSystemMessage(text) {
    var container = document.getElementById('gc-messages');
    var div = document.createElement('div');
    div.className = 'gc-msg system';
    div.textContent = text;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  // ── Offline lead form ──────────────────────────────────
  (function restoreOfflineForm() {
    var savedName  = localStorage.getItem('gc_off_name');
    var savedEmail = localStorage.getItem('gc_off_email');
    var savedMsg   = localStorage.getItem('gc_off_msg');
    if (savedName)  document.getElementById('gc-off-name').value  = savedName;
    if (savedEmail) document.getElementById('gc-off-email').value = savedEmail;
    if (savedMsg)   document.getElementById('gc-off-msg').value   = savedMsg;
  })();

  document.getElementById('gc-off-name').addEventListener('input', function() {
    localStorage.setItem('gc_off_name', this.value);
  });
  document.getElementById('gc-off-email').addEventListener('input', function() {
    localStorage.setItem('gc_off_email', this.value);
  });
  document.getElementById('gc-off-msg').addEventListener('input', function() {
    localStorage.setItem('gc_off_msg', this.value);
  });

  document.getElementById('gc-off-send').addEventListener('click', function () {
    var name  = document.getElementById('gc-off-name').value.trim();
    var email = document.getElementById('gc-off-email').value.trim();
    var msg   = document.getElementById('gc-off-msg').value.trim();
    document.querySelectorAll('.gc-offline-error').forEach(function(el) { el.style.display = 'none'; });
    ['gc-off-name','gc-off-email','gc-off-msg'].forEach(function(id) {
      document.getElementById(id).classList.remove('gc-input-error');
    });
    var hasError = false;
    if (!name) {
      document.getElementById('gc-off-name-error').style.display = 'block';
      document.getElementById('gc-off-name').classList.add('gc-input-error');
      hasError = true;
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      document.getElementById('gc-off-email-error').textContent = !email ? 'Please enter your email address.' : 'Please enter a valid email address.';
      document.getElementById('gc-off-email-error').style.display = 'block';
      document.getElementById('gc-off-email').classList.add('gc-input-error');
      hasError = true;
    }
    if (!msg) {
      document.getElementById('gc-off-msg-error').style.display = 'block';
      document.getElementById('gc-off-msg').classList.add('gc-input-error');
      hasError = true;
    }
    if (hasError) return;
    var btn = document.getElementById('gc-off-send');
    btn.disabled = true;
    btn.textContent = 'Sending...';
    fetch(BACKEND_URL + '/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, email: email, message: msg }),
    })
      .then(function () {
        localStorage.removeItem('gc_off_name');
        localStorage.removeItem('gc_off_email');
        localStorage.removeItem('gc_off_msg');
        document.getElementById('gc-offline-fields').style.display = 'none';
        document.getElementById('gc-off-success').style.display = 'block';
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = '📩 Send enquiry';
        document.getElementById('gc-off-name-error').textContent = 'Something went wrong. Please try again.';
        document.getElementById('gc-off-name-error').style.display = 'block';
      });
  });

  function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

})();
