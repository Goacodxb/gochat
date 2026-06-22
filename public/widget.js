(function () {
  'use strict';

  // ── Configuration — set your Railway backend URL here ──
var BACKEND_URL = 'https://gochat-production-bd48.up.railway.app';
  var POLL_INTERVAL = 30000; // check availability every 30s
  var MESSAGE_POLL = 3000;   // poll for new messages every 3s

  // ── State ──────────────────────────────────────────────
  var sessionId = null;
  var visitorName = null;
  var lastMessageTime = new Date().toISOString();
  var messagePoller = null;
  var availabilityPoller = null;
  var ws = null;
  var isOnline = false;

  // ── Inject styles ──────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = `
    #gc-launcher {
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      width: 56px; height: 56px; border-radius: 50%;
      background: #111e45; color: white; border: none; cursor: pointer;
      box-shadow: 0 4px 16px rgba(0,82,204,0.4);
      display: flex; align-items: center; justify-content: center;
      font-size: 24px; transition: transform 0.2s;
    }
    #gc-launcher:hover { transform: scale(1.08); }
    #gc-widget {
      position: fixed; bottom: 90px; right: 24px; z-index: 9998;
      width: 360px; background: white; border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.15);
      display: none; flex-direction: column; overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      max-height: 520px;
    }
    #gc-widget.open { display: flex; }
    #gc-header {
      background: #0052cc; color: white; padding: 14px 16px;
      display: flex; justify-content: space-between; align-items: center;
    }
    #gc-header h3 { font-size: 15px; font-weight: 600; margin: 0; }
    #gc-header p { font-size: 12px; opacity: 0.8; margin: 2px 0 0; }
    #gc-close { background: none; border: none; color: white; font-size: 20px; cursor: pointer; opacity: 0.8; }
    #gc-close:hover { opacity: 1; }
    #gc-body { padding: 16px; flex: 1; overflow-y: auto; }
    #gc-messages { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; min-height: 40px; }
    .gc-msg { max-width: 80%; padding: 8px 12px; border-radius: 8px; font-size: 14px; line-height: 1.4; }
    .gc-msg.visitor { background: #111e45; color: white; align-self: flex-end; border-bottom-right-radius: 2px; }
    .gc-msg.agent { background: #f4f5f7; color: #111e45; align-self: flex-start; border-bottom-left-radius: 2px; }
    .gc-msg .gc-sender { font-size: 11px; opacity: 0.7; margin-bottom: 2px; }
    #gc-form { display: flex; flex-direction: column; gap: 8px; }
    #gc-form input, #gc-form textarea {
      width: 100%; padding: 9px 12px; border: 1px solid #dfe1e6;
      border-radius: 6px; font-size: 14px; font-family: inherit; resize: none;
    }
    #gc-form input:focus, #gc-form textarea:focus { outline: none; border-color: #0052cc; }
    #gc-send {
      padding: 10px; background: #111e45; color: white; border: none;
      border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer;
    }
    #gc-send:hover { background: #111e45; }
    #gc-send:disabled { opacity: 0.5; cursor: not-allowed; }
    #gc-chat-input { display: flex; gap: 8px; padding: 0 16px 16px; }
    #gc-chat-input input {
      flex: 1; padding: 9px 12px; border: 1px solid #dfe1e6;
      border-radius: 6px; font-size: 14px;
    }
    #gc-chat-input input:focus { outline: none; border-color: #111e45; }
    #gc-chat-send {
      padding: 9px 14px; background: #111e45; color: white; border: none;
      border-radius: 6px; cursor: pointer; font-size: 14px;
    }
    #gc-chat-send:hover { background: #111e45; }
    #gc-status { font-size: 13px; color: #6b778c; text-align: center; padding: 8px 0; }
    .gc-typing { font-size: 12px; color: #6b778c; padding: 0 16px 8px; }
  `;
  document.head.appendChild(style);

  // ── Build widget HTML ──────────────────────────────────
  var launcher = document.createElement('button');
  launcher.id = 'gc-launcher';
  launcher.innerHTML = '💬';
  launcher.setAttribute('aria-label', 'Open chat');

  var widget = document.createElement('div');
  widget.id = 'gc-widget';
  widget.setAttribute('role', 'dialog');
  widget.setAttribute('aria-label', 'Live chat');

  widget.innerHTML = `
    <div id="gc-header">
      <div>
        <h3>Chat with us</h3>
        <p id="gc-header-status">Checking availability...</p>
      </div>
      <button id="gc-close" aria-label="Close chat">×</button>
    </div>
    <div id="gc-body">
      <!-- Pre-chat form (online) -->
      <div id="gc-prechat">
        <p style="font-size:14px;color:#6b778c;margin-bottom:12px">
          We're online! Fill in your details and we'll be right with you.
        </p>
        <div id="gc-form">
          <input id="gc-name" type="text" placeholder="Your name" required>
          <input id="gc-email" type="email" placeholder="Your email address" required>
          <textarea id="gc-first-msg" rows="3" placeholder="How can we help?"></textarea>
          <button id="gc-send">Start chat</button>
        </div>
        <p id="gc-form-error" style="color:red;font-size:13px;margin-top:6px;display:none"></p>
      </div>

      <!-- Live chat view -->
      <div id="gc-chat" style="display:none">
        <div id="gc-messages"></div>
        <p id="gc-status"></p>
      </div>

      <!-- Offline lead form -->
      <div id="gc-offline" style="display:none">
        <p style="font-size:14px;color:#6b778c;margin-bottom:12px">
          Our team is currently offline. Leave your details and we'll get back to you.
        </p>
        <div id="gc-offline-form">
          <div id="gc-offline-fields" style="display:flex;flex-direction:column;gap:8px">
            <input id="gc-off-name" type="text" placeholder="Your name" required>
            <input id="gc-off-email" type="email" placeholder="Your email address" required>
            <textarea id="gc-off-msg" rows="3" placeholder="Your enquiry" style="width:100%;padding:9px 12px;border:1px solid #dfe1e6;border-radius:6px;font-size:14px;font-family:inherit;resize:none"></textarea>
            <button id="gc-off-send" style="padding:10px;background:#0052cc;color:white;border:none;border-radius:6px;font-size:14px;font-weight:600;cursor:pointer">Send enquiry</button>
          </div>
          <p id="gc-off-success" style="display:none;font-size:14px;color:#006644;background:#e3fcef;padding:12px;border-radius:6px;margin-top:8px">
            ✅ Thanks! We'll be in touch soon.
          </p>
          <p id="gc-off-error" style="color:red;font-size:13px;margin-top:6px;display:none"></p>
        </div>
      </div>
    </div>
    <div id="gc-chat-input" style="display:none">
      <input id="gc-msg-input" type="text" placeholder="Type a message..." autocomplete="off">
      <button id="gc-chat-send">➤</button>
    </div>
  `;

  document.body.appendChild(launcher);
  document.body.appendChild(widget);

  // ── Event: open/close widget ───────────────────────────
  launcher.addEventListener('click', function () {
    var isOpen = widget.classList.contains('open');
    if (isOpen) {
      widget.classList.remove('open');
      launcher.innerHTML = '💬';
    } else {
      widget.classList.add('open');
      launcher.innerHTML = '×';
      checkAvailability();
    }
  });

  document.getElementById('gc-close').addEventListener('click', function () {
    widget.classList.remove('open');
    launcher.innerHTML = '💬';
  });

  // ── Availability check ─────────────────────────────────
  function checkAvailability() {
    fetch(BACKEND_URL + '/api/availability')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        isOnline = d.online;
        document.getElementById('gc-header-status').textContent = d.online ? '🟢 We\'re online' : '🔴 Currently offline';
        if (!sessionId) {
          // Only switch views if not already in a chat
          document.getElementById('gc-prechat').style.display = d.online ? '' : 'none';
          document.getElementById('gc-offline').style.display = d.online ? 'none' : '';
        }
      })
      .catch(function () {
        document.getElementById('gc-header-status').textContent = 'Checking...';
      });
  }

  // Poll availability every 30s
  availabilityPoller = setInterval(checkAvailability, POLL_INTERVAL);
  checkAvailability();

  // ── Start chat ─────────────────────────────────────────
  document.getElementById('gc-send').addEventListener('click', function () {
    var name = document.getElementById('gc-name').value.trim();
    var email = document.getElementById('gc-email').value.trim();
    var msg = document.getElementById('gc-first-msg').value.trim();
    var errEl = document.getElementById('gc-form-error');

    if (!name || !email || !msg) {
      errEl.textContent = 'Please fill in all fields.';
      errEl.style.display = 'block';
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errEl.textContent = 'Please enter a valid email address.';
      errEl.style.display = 'block';
      return;
    }
    errEl.style.display = 'none';
    visitorName = name;

    var btn = document.getElementById('gc-send');
    btn.disabled = true;
    btn.textContent = 'Connecting...';

    fetch(BACKEND_URL + '/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, email: email, firstMessage: msg }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.sessionId) throw new Error('No session ID returned');
        sessionId = d.sessionId;
        showChatView(name, msg);
        connectWebSocket();
        startMessagePolling();
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = 'Start chat';
        errEl.textContent = 'Something went wrong. Please try again.';
        errEl.style.display = 'block';
      });
  });

  function showChatView(name, firstMsg) {
    document.getElementById('gc-prechat').style.display = 'none';
    document.getElementById('gc-chat').style.display = '';
    document.getElementById('gc-chat-input').style.display = '';
    addMessage('visitor', name, firstMsg);
    document.getElementById('gc-status').textContent = 'Connecting you to an agent...';
    document.getElementById('gc-msg-input').focus();
  }

  // ── Send message ───────────────────────────────────────
  function sendMessage() {
    var input = document.getElementById('gc-msg-input');
    var content = input.value.trim();
    if (!content || !sessionId) return;
    input.value = '';

    addMessage('visitor', visitorName, content);

    fetch(BACKEND_URL + '/api/sessions/' + sessionId + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content, senderName: visitorName }),
    }).catch(console.error);
  }

  document.getElementById('gc-chat-send').addEventListener('click', sendMessage);
  document.getElementById('gc-msg-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // ── WebSocket ──────────────────────────────────────────
  function connectWebSocket() {
    if (!sessionId) return;
    var wsUrl = BACKEND_URL.replace(/^http/, 'ws') + '?sessionId=' + sessionId;
    ws = new WebSocket(wsUrl);

    ws.onmessage = function (e) {
      try {
        var data = JSON.parse(e.data);
        if (data.type === 'agent_message') {
          addMessage('agent', data.senderName || 'Agent', data.content);
          document.getElementById('gc-status').textContent = '';
        } else if (data.type === 'agent_joined') {
          document.getElementById('gc-status').textContent = data.agentName + ' has joined the chat';
        } else if (data.type === 'session_closed') {
          document.getElementById('gc-status').textContent = 'Chat ended. Thanks for contacting us!';
          document.getElementById('gc-chat-input').style.display = 'none';
          stopMessagePolling();
        }
      } catch (err) { console.error(err); }
    };

    ws.onerror = function () { startMessagePolling(); }; // fallback to polling
    ws.onclose = function () { startMessagePolling(); };
  }

  // ── Long-poll fallback ────────────────────────────────
  function startMessagePolling() {
    if (messagePoller) return;
    messagePoller = setInterval(function () {
      if (!sessionId) return;
      fetch(BACKEND_URL + '/api/sessions/' + sessionId + '/messages?since=' + encodeURIComponent(lastMessageTime))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          (d.messages || []).forEach(function (m) {
            if (m.sender_type === 'agent') {
              addMessage('agent', m.sender_name, m.content);
              document.getElementById('gc-status').textContent = '';
            }
            lastMessageTime = m.created_at;
          });
        })
        .catch(console.error);
    }, MESSAGE_POLL);
  }

  function stopMessagePolling() {
    clearInterval(messagePoller);
    messagePoller = null;
  }

  // ── Add message bubble ─────────────────────────────────
  function addMessage(type, name, content) {
    var container = document.getElementById('gc-messages');
    var div = document.createElement('div');
    div.className = 'gc-msg ' + type;
    div.innerHTML = '<div class="gc-sender">' + escHtml(name) + '</div>' + escHtml(content);
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  // ── Offline lead form ──────────────────────────────────
  document.getElementById('gc-off-send').addEventListener('click', function () {
    var name = document.getElementById('gc-off-name').value.trim();
    var email = document.getElementById('gc-off-email').value.trim();
    var msg = document.getElementById('gc-off-msg').value.trim();
    var errEl = document.getElementById('gc-off-error');

    if (!name || !email || !msg) {
      errEl.textContent = 'Please fill in all fields.';
      errEl.style.display = 'block';
      return;
    }
    errEl.style.display = 'none';

    var btn = document.getElementById('gc-off-send');
    btn.disabled = true;
    btn.textContent = 'Sending...';

    fetch(BACKEND_URL + '/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, email: email, message: msg }),
    })
      .then(function () {
        document.getElementById('gc-offline-fields').style.display = 'none';
        document.getElementById('gc-off-success').style.display = 'block';
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = 'Send enquiry';
        errEl.textContent = 'Something went wrong. Please try again.';
        errEl.style.display = 'block';
      });
  });

  function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

})();
