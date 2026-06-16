// ============================================
// Chat Application - WebSocket Client
// ============================================

// === Configuration ===
const CONFIG = {
  wsUrl: 'ws://192.168.41.227:8089',
  username: '我',
  reconnectDelay: 3000,
  maxReconnectAttempts: 10,
};

// === State ===
let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let isConnected = false;
let messageCount = 0;
let isAtBottom = true;

// Deduplication: track recently sent messages to avoid showing echoes
const sentMessages = new Map();
const DEDUP_WINDOW_MS = 2000;

// === DOM Elements ===
const elements = {};

function cacheElements() {
  elements.messages = document.getElementById('messages');
  elements.container = document.getElementById('messages-container');
  elements.input = document.getElementById('message-input');
  elements.sendBtn = document.getElementById('send-btn');
  elements.statusDot = document.getElementById('status-dot');
  elements.statusText = document.getElementById('status-text');
  elements.settingsBtn = document.getElementById('settings-btn');
  elements.settingsPanel = document.getElementById('settings-panel');
  elements.settingsCloseBtn = document.getElementById('settings-close-btn');
  elements.wsUrlInput = document.getElementById('ws-url-input');
  elements.usernameInput = document.getElementById('username-input');
  elements.reconnectBtn = document.getElementById('reconnect-btn');
  elements.scrollHint = document.getElementById('scroll-bottom-hint');
  elements.toast = document.getElementById('toast');
  elements.typingIndicator = document.getElementById('typing-indicator');
}

// === WebSocket Connection ===
function connectWebSocket() {
  if (ws) {
    ws.close();
    ws = null;
  }

  setStatus('connecting', '连接中...');

  const url = CONFIG.wsUrl;
  console.log(`[WebSocket] Connecting to ${url}`);

  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error('[WebSocket] Failed to create connection:', err);
    setStatus('disconnected', '连接失败');
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log('[WebSocket] Connected');
    isConnected = true;
    reconnectAttempts = 0;
    setStatus('connected', '已连接');
    addSystemMessage('已连接到服务器');
    updateSendButton();
  };

  ws.onmessage = (event) => {
    console.log('[WebSocket] Message received:', event.data);
    handleIncomingMessage(event.data);
  };

  ws.onclose = (event) => {
    console.log(`[WebSocket] Disconnected (code: ${event.code})`);
    isConnected = false;
    setStatus('disconnected', '已断开');
    if (event.code !== 1000) {
      addSystemMessage('与服务器断开连接');
    }
    updateSendButton();
    scheduleReconnect();
  };

  ws.onerror = (error) => {
    console.error('[WebSocket] Error:', error);
    isConnected = false;
    setStatus('disconnected', '连接错误');
    updateSendButton();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  if (reconnectAttempts >= CONFIG.maxReconnectAttempts) {
    setStatus('disconnected', '重连失败');
    addSystemMessage('重连失败，请检查服务器地址');
    return;
  }

  reconnectAttempts++;
  const delay = CONFIG.reconnectDelay * Math.min(reconnectAttempts, 5);
  setStatus('connecting', `重连中 (${reconnectAttempts}/${CONFIG.maxReconnectAttempts})...`);

  reconnectTimer = setTimeout(() => {
    connectWebSocket();
  }, delay);
}

function disconnectWebSocket() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = CONFIG.maxReconnectAttempts; // Prevent auto-reconnect

  if (ws) {
    ws.close(1000, 'User disconnected');
    ws = null;
  }

  isConnected = false;
  setStatus('disconnected', '已断开');
  updateSendButton();
}

// === State: streaming ===
let streamingBuffer = '';
let streamingMsgEl = null;

// === Message Handling ===
function sendMessage(text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('未连接到服务器');
    return;
  }

  const trimmed = text.trim();
  if (!trimmed) return;

  try {
    // Send as prompt command (ws_server protocol)
    const msgId = 'mobile-' + Date.now();
    const payload = JSON.stringify({
      type: 'prompt',
      text: trimmed,
      id: msgId,
    });
    ws.send(payload);

    // Track sent message for deduplication
    sentMessages.set(trimmed, msgId);
    setTimeout(() => sentMessages.delete(trimmed), DEDUP_WINDOW_MS);

    // Add user message to chat
    addUserMessage(trimmed);
  } catch (err) {
    console.error('[WebSocket] Send error:', err);
    showToast('发送失败');
    return;
  }

  elements.input.value = '';
  autoResizeInput();
  updateSendButton();
  messageCount++;
}

function handleIncomingMessage(data) {
  let parsed;
  try {
    parsed = JSON.parse(data);
  } catch (e) {
    addOtherMessage(data);
    messageCount++;
    return;
  }

  const type = parsed.type;

  if (type === 'text_delta') {
    streamingBuffer += parsed.delta || '';
    if (!streamingMsgEl) {
      streamingMsgEl = createStreamingMessage();
    }
    const bubble = streamingMsgEl.querySelector('.message-bubble');
    if (bubble) {
      bubble.textContent = streamingBuffer;
    }
    scrollToBottom();
    return;
  }

  if (type === 'result') {
    const text = parsed.full_response || parsed.summary || '';
    if (streamingMsgEl) {
      const bubble = streamingMsgEl.querySelector('.message-bubble');
      if (bubble) {
        bubble.textContent = text;
      }
      streamingMsgEl = null;
    } else if (text) {
      addOtherMessage(text);
    }
    streamingBuffer = '';
    hideTyping();
    messageCount++;
    return;
  }

  if (type === 'error') {
    addSystemMessage('❌ ' + (parsed.message || '未知错误'));
    streamingBuffer = '';
    streamingMsgEl = null;
    hideTyping();
    messageCount++;
    return;
  }

  if (type === 'status') {
    if (parsed.streaming) {
      showTyping();
    } else {
      hideTyping();
    }
    return;
  }

  if (type === 'reasoning_delta') {
    return;
  }

  if (type === 'pong') {
    addSystemMessage('🏓 pong');
    return;
  }

  if (type === 'tool_call' || type === 'tool_result') {
    return;
  }

  const fallback = parsed.text || parsed.content || parsed.message || data;
  if (typeof fallback === 'string' && fallback.length > 0) {
    addOtherMessage(fallback);
    messageCount++;
  }
}

// === UI: Adding Messages ===
function createStreamingMessage() {
  const div = document.createElement('div');
  div.className = 'message other streaming';
  const time = formatTime(new Date());
  div.innerHTML = `
    <div class="message-bubble"></div>
    <div class="message-meta">
      <span class="message-time">${time}</span>
    </div>
  `;
  elements.messages.appendChild(div);
  scrollToBottom();
  return div;
}

function showTyping() {
  elements.typingIndicator.classList.remove('hidden');
}

function hideTyping() {
  elements.typingIndicator.classList.add('hidden');
}

function addUserMessage(text, msgId = null) {
  const div = document.createElement('div');
  div.className = 'message user';

  const time = formatTime(new Date());

  div.innerHTML = `
    <div class="message-bubble">${escapeHtml(text)}</div>
    <div class="message-meta">
      <span class="message-time">${time}</span>
      <span class="message-status sent">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </span>
    </div>
  `;

  elements.messages.appendChild(div);
  scrollToBottom();
}

function addOtherMessage(text, sender = null) {
  const div = document.createElement('div');
  div.className = 'message other';

  const time = formatTime(new Date());
  const senderHtml = sender
    ? `<div class="sender-name">@${escapeHtml(sender)}</div>`
    : '';

  div.innerHTML = `
    ${senderHtml}
    <div class="message-bubble">${escapeHtml(text)}</div>
    <div class="message-meta">
      <span class="message-time">${time}</span>
    </div>
  `;

  elements.messages.appendChild(div);
  scrollToBottom();
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'message system-message';

  div.innerHTML = `
    <div class="message-bubble system">
      <span class="system-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
      </span>
      <span>${escapeHtml(text)}</span>
    </div>
  `;

  elements.messages.appendChild(div);
  scrollToBottom();
}

// === UI: Status ===
function setStatus(state, text) {
  const dot = elements.statusDot;
  const label = elements.statusText;

  dot.className = 'status-dot';
  if (state === 'connected') {
    dot.classList.add('connected');
  } else if (state === 'disconnected') {
    dot.classList.add('disconnected');
  } else {
    dot.classList.add('connecting');
  }

  label.textContent = text;
}

// === UI: Send Button ===
function updateSendButton() {
  const hasText = elements.input.value.trim().length > 0;
  const canSend = hasText && isConnected;

  elements.sendBtn.classList.toggle('active', canSend);
  elements.sendBtn.disabled = !canSend;
}

function autoResizeInput() {
  elements.input.style.height = 'auto';
  elements.input.style.height = Math.min(elements.input.scrollHeight, 120) + 'px';
}

// === UI: Scroll ===
function scrollToBottom() {
  if (!isAtBottom) return;
  requestAnimationFrame(() => {
    elements.container.scrollTop = elements.container.scrollHeight;
  });
}

function checkScrollPosition() {
  const { scrollTop, scrollHeight, clientHeight } = elements.container;
  const threshold = 60;
  isAtBottom = scrollHeight - scrollTop - clientHeight < threshold;
  elements.scrollHint.classList.toggle('hidden', isAtBottom);
}

// === UI: Toast ===
let toastTimer = null;

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove('hidden');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.classList.add('hidden');
  }, 2500);
}

// === UI: Settings Panel ===
function toggleSettings() {
  const isHidden = elements.settingsPanel.classList.contains('hidden');
  elements.settingsPanel.classList.toggle('hidden');

  if (isHidden) {
    elements.wsUrlInput.value = CONFIG.wsUrl;
    elements.usernameInput.value = CONFIG.username;
    elements.wsUrlInput.focus();
  }
}

function closeSettings() {
  elements.settingsPanel.classList.add('hidden');
}

function applySettings() {
  const newUrl = elements.wsUrlInput.value.trim();
  const newUsername = elements.usernameInput.value.trim() || '我';

  if (newUrl && newUrl !== CONFIG.wsUrl) {
    CONFIG.wsUrl = newUrl;
    // Reset reconnect counter for new URL
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    disconnectWebSocket();
    connectWebSocket();
    showToast('已更新服务器地址');
  }

  if (newUsername !== CONFIG.username) {
    CONFIG.username = newUsername;
    showToast('显示名称已更新');
  }

  closeSettings();
}

// === Utils ===
function formatTime(date) {
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// === Event Listeners ===
function setupEventListeners() {
  // Send message
  elements.sendBtn.addEventListener('click', () => {
    sendMessage(elements.input.value);
  });

  // Input events
  elements.input.addEventListener('input', () => {
    autoResizeInput();
    updateSendButton();
  });

  elements.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(elements.input.value);
    }
  });

  // Scroll detection
  elements.container.addEventListener('scroll', checkScrollPosition);

  // Scroll to bottom hint
  elements.scrollHint.addEventListener('click', () => {
    isAtBottom = true;
    scrollToBottom();
  });

  // Settings toggle
  elements.settingsBtn.addEventListener('click', toggleSettings);

  // Close settings
  elements.settingsCloseBtn.addEventListener('click', applySettings);

  // Reconnect button in settings
  elements.reconnectBtn.addEventListener('click', () => {
    const newUrl = elements.wsUrlInput.value.trim();
    if (newUrl) {
      CONFIG.wsUrl = newUrl;
      reconnectAttempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      disconnectWebSocket();
      connectWebSocket();
      showToast('正在重新连接...');
    }
    closeSettings();
  });

  // Close settings on escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !elements.settingsPanel.classList.contains('hidden')) {
      closeSettings();
    }
  });

  // Close settings when clicking outside
  document.addEventListener('click', (e) => {
    if (
      !elements.settingsPanel.classList.contains('hidden') &&
      !elements.settingsPanel.contains(e.target) &&
      !elements.settingsBtn.contains(e.target)
    ) {
      closeSettings();
    }
  });

  // Visibility change - reconnect if needed
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !isConnected && reconnectAttempts < CONFIG.maxReconnectAttempts) {
      reconnectAttempts = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      connectWebSocket();
    }
  });
}

// === Init ===
function init() {
  cacheElements();
  setupEventListeners();
  connectWebSocket();
  updateSendButton();
  checkScrollPosition();
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
