(function () {
  'use strict';

  var BACKEND_URL = 'https://gochat-production-bd48.up.railway.app';
  var POLL_INTERVAL = 30000;
  var MESSAGE_POLL = 3000;

  var sessionId = null;
  var visitorName = null;
  var lastMessageTime = new Date().toISOString();
  var messagePoller = null;
  var availabilityPoller = null;
  var ws = null;
  var isOnline = false;

  var style = document.createElement('style');
  style.textContent = `
    #gc-launcher {
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      width: 58px; height: 58px; border-radius: 50%;
      background: #0f1d3a; color: white; border: 2px solid #1e3a5f;
      cursor: pointer; box-shadow: 0 4px 20px rgba(15,29,58,0.4);
      display: flex; align-items: center; justify-content: center;
      font-size: 22px; transition: transform 0.2s, box-shadow 0.2s;
      position: fixed;
    }
    #gc-launcher:hover { transform: scale(1.08); box-shadow: 0 6px 24px rgba(15,29,58,0.5); }
    #gc-online-dot {
      position: fixed; bottom: 62px; right: 24px; z-index: 10000;
      width: 14px; height: 14px; border-radius: 50%;
      background: #22c55e; border: 2px solid white;
      display: none;
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
      font-size: 18px; flex-shrink: 0;
    }
    #gc-header h3 { font-size: 14px; font-weight: 600; margin: 0; }
    #gc-header-status { font-size: 11px; margin: 3px 0 0; display: flex; align-items: center; gap: 4px; }
    #gc-status-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
    #gc-close {
      background: none; border: none; color: #94a3b8;
      font-size: 20px; cursor: pointer; padding: 0; line-height: 1;
    }
    #gc-close:hover { color: white; }
    #gc-body { padding: 16px; flex: 1; overflow-y: auto; }
    #gc-welcome-msg {
      background: #eff6ff; border-left: 3px solid #3b82f6;
      border-radius: 0 8px 8px 0; padding: 10px 12px;
      margin-bottom: 14px;
    }
    #gc-welcome-msg p { font-size: 13px; color: #1e40af; margin: 0; }
    .gc-field-label {
      font-size: 11px; color: #6b7280; font-weight: 600;
      display: block; margin-bottom: 3px; text-transform: uppercase; letter-spacing: 0.3px;
    }
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
    .gc-msg.visitor {
      background: #0f1d3a; color: white;
      align-self: flex-end; border-bottom-right-radius: 2px;
    }
    .gc-msg.agent {
      background: #f3f4f6; color: #111827;
      align-self: flex-start; border-bottom-left-radius: 2px;
    }
    .gc-msg .gc-sender { font-size: 10px; opacity: 0.7; margin-bottom: 3px; }
    #gc-status {
      font-size: 12px; color: #6b7280; text-align: center;
      padding: 6px 0; font-style: italic;
    }
    #gc-chat-input {
      display: flex; gap: 8px; padding: 10px 16px 14px;
      border-top: 1px solid #f3f4f6;
    }
    #gc-chat-input input {
      flex: 1; padding: 9px 12px; border: 1px solid #e5e7eb;
      border-radius: 8px; font-size: 14px; font-family: inherit;
    }
    #gc-chat-input input:focus { outline: none; border-color: #0f1d3a; }
    #gc-chat-send {
      padding: 9px 14px; background: #0f1d3a; color: white;
      border: none; border-radius: 8px; cursor: pointer; font-size: 16px;
    }
    #gc-chat-send:hover { background: #1a2f5a; }
    #gc-offline-fields { display: flex; flex-direction: column; gap: 10px; }
    .gc-offline-input {
      width: 100%; padding: 9px 12px; border: 1px solid #e5e7eb;
      border-radius: 6px; font-size: 13px; font-family: inherit;
      box-sizing: border-box; color: #111827;
    }
    .gc-offline-input:focus { outline: none; border-color: #0f1d3a; }
    #gc-off-send {
      padding: 11px; background: #0f1d3a; color: white;
      border: none; border-radius: 8px; font-size: 14px;
      font-weight: 600; cursor: pointer; width: 100%;
    }
    #gc-off-send:hover { background: #1a2f5a; }
    #gc-off-success {
      display: none; font-size: 14px; color: #065f46;
      background: #d1fae5; padding: 12px; border-radius: 8px; margin-top: 8px;
    }
  `;
  document.head.appendChild(style);

  var onlineDot = document.createElement('div');
  onlineDot.id = 'gc-online-dot';
  document.body.appendChild(onlineDot);

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
      <div id="gc-header-left">
      <div id="gc-avatar">
      <img src="https://raw.githubusercontent.com/gochat/public/main/goidentity.png" alt="GoIdentity">
      </div>
        <div>
          <h3>GoIdentity Support</h3>
          <div id="gc-header-status">
            <span id="gc-status-dot" style="background:#94a3b8"></span>
            <span id="gc-status-text">Checking availability...</span>
          </div>
        </div>
      </div>
      <button id="gc-close" aria-label="Close chat">×</button>
    </div>
    <div id="gc-body">

      <div id="gc-prechat">
        <div id="gc-welcome-msg">
          <p>👋 Hi! How can the GoIdentity team help you today?</p>
        </div>
        <div id="gc-form">
          <div>
         
            <input id="gc-name" type="text" placeholder="Full name" required>
          </div>
          <div>
            
            <input id="gc-email" type="email" placeholder="Email address" required>
          </div>
          <div>
           
            <textarea id="gc-first-msg" rows="3" placeholder="Tell us about your enquiry..."></textarea>
          </div>
          <button id="gc-send">➤ Start conversation</button>
          <div id="gc-privacy">🔒 Your information is secure and private</div>
        </div>
        <p id="gc-form-error" style="color:#dc2626;font-size:13px;margin-top:6px;display:none"></p>
      </div>

      <div id="gc-chat" style="display:none">
        <div id="gc-messages"></div>
        <p id="gc-status"></p>
      </div>

      <div id="gc-offline" style="display:none">
        <div id="gc-welcome-msg" style="border-left-color:#f59e0b;background:#fffbeb">
          <p style="color:#92400e">⏰ We're currently offline. Leave your details and we'll get back to you soon.</p>
        </div>
        <div id="gc-offline-fields">
          <div>
            <label class="gc-field-label">Full name</label>
            <input id="gc-off-name" class="gc-offline-input" type="text" placeholder="John Smith" required>
          </div>
          <div>
            <label class="gc-field-label">Email address</label>
            <input id="gc-off-email" class="gc-offline-input" type="email" placeholder="john@company.com" required>
          </div>
          <div>
            <label class="gc-field-label">Your enquiry</label>
            <textarea id="gc-off-msg" class="gc-offline-input" rows="3" placeholder="Tell us how we can help..."></textarea>
          </div>
          <button id="gc-off-send">📩 Send enquiry</button>
          <div id="gc-privacy" style="font-size:11px;color:#9ca3af;text-align:center;margin-top:4px">🔒 Your information is secure and private</div>
        </div>
        <p id="gc-off-success">✅ Thanks! A member of our team will be in touch soon.</p>
        <p id="gc-off-error" style="color:#dc2626;font-size:13px;margin-top:6px;display:none"></p>
      </div>

    </div>
    <div id="gc-chat-input" style="display:none">
      <input id="gc-msg-input" type="text" placeholder="Type a message..." autocomplete="off">
      <button id="gc-chat-send">➤</button>
    </div>
  `;

  document.body.appendChild(launcher);
  document.body.appendChild(widget);

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
        } else {
          dot.style.background = '#f59e0b';
          text.textContent = 'Currently offline';
          onlineDot.style.display = 'none';
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
        showChatView(name, msg);
        connectWebSocket();
        startMessagePolling();
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = '➤ Start conversation';
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
    ws.onerror = function () { startMessagePolling(); };
    ws.onclose = function () { startMessagePolling(); };
  }

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

  function addMessage(type, name, content) {
    var container = document.getElementById('gc-messages');
    var div = document.createElement('div');
    div.className = 'gc-msg ' + type;
    div.innerHTML = '<div class="gc-sender">' + escHtml(name) + '</div>' + escHtml(content);
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

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
        btn.textContent = '📩 Send enquiry';
        errEl.textContent = 'Something went wrong. Please try again.';
        errEl.style.display = 'block';
      });
  });

  function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

})();
