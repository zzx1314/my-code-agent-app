// ============================================
// Chat Application - WebSocket Client
// ============================================

// === Configuration ===
const CONFIG = {
  wsUrl: 'ws://39.107.55.13:8095',
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

// Track whether local history has been loaded on startup
// Prevents server 'history' messages from overwriting locally loaded history
let localHistoryLoaded = false;

// Track tasks for Android background notification
let pendingTaskCount = 0;
let wasBackgroundedDuringTask = false;

// === Chat History Persistence ===
const STORAGE_KEY = 'chat_history';
const SESSIONS_KEY = 'chat_sessions';
const MAX_HISTORY = 500;

function generateSessionId() {
  return 'session-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

function getSessions() {
  try {
    return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]');
  } catch (e) {
    return [];
  }
}

function saveSessions(sessions) {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
}

function getActiveSessionId() {
  return localStorage.getItem('active_session_id') || null;
}

function setActiveSessionId(sessionId) {
  localStorage.setItem('active_session_id', sessionId);
}

function createSession(name, syncToBackend = true) {
  const sessions = getSessions();
  const newSession = {
    id: generateSessionId(),
    name: name || '新会话',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  sessions.unshift(newSession);
  saveSessions(sessions);
  setActiveSessionId(newSession.id);
  localStorage.setItem(STORAGE_KEY + '_' + newSession.id, '[]');
  if (syncToBackend) {
    syncSessionToBackend('create', newSession.name, newSession.id);
  }
  return newSession;
}

function deleteSession(sessionId) {
  const sessions = getSessions();
  const session = sessions.find(s => s.id === sessionId);
  const filtered = sessions.filter(s => s.id !== sessionId);
  saveSessions(filtered);
  localStorage.removeItem(STORAGE_KEY + '_' + sessionId);
  if (session) {
    syncSessionToBackend('delete', session.name, session.id);
  }
  if (getActiveSessionId() === sessionId) {
    if (filtered.length > 0) {
      setActiveSessionId(filtered[0].id);
    } else {
      const newSession = createSession();
      setActiveSessionId(newSession.id);
    }
  }
}

function syncSessionToBackend(action, sessionName, sessionId) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }
  const msgId = 'session-' + Date.now();
  let payload;
  switch (action) {
    case 'create':
      payload = JSON.stringify({
        type: 'create_session',
        session_id: sessionId,
        name: sessionName,
        id: msgId
      });
      break;
    case 'delete':
      payload = JSON.stringify({
        type: 'delete_session',
        session_id: sessionId,
        name: sessionName,
        id: msgId
      });
      break;
    case 'switch':
      payload = JSON.stringify({
        type: 'switch_session',
        session_id: sessionId,
        name: sessionName,
        id: msgId
      });
      break;
  }
  if (payload) {
    ws.send(payload);
  }
}

function getCurrentSessionId(syncToBackend = false) {
  let sessionId = getActiveSessionId();
  if (!sessionId) {
    const sessions = getSessions();
    if (sessions.length > 0) {
      sessionId = sessions[0].id;
      setActiveSessionId(sessionId);
    } else {
      const newSession = createSession('新会话', syncToBackend);
      sessionId = newSession.id;
    }
  }
  return sessionId;
}

function saveMessageToHistory(msg) {
  try {
    const sessionId = getCurrentSessionId();
    const key = STORAGE_KEY + '_' + sessionId;
    let history = JSON.parse(localStorage.getItem(key) || '[]');
    history.push(msg);
    if (history.length > MAX_HISTORY) {
      history = history.slice(-MAX_HISTORY);
    }
    localStorage.setItem(key, JSON.stringify(history));
    const sessions = getSessions();
    const session = sessions.find(s => s.id === sessionId);
    if (session) {
      session.updatedAt = Date.now();
      if (session.name === '新会话' && msg.type === 'user') {
        session.name = msg.text.substring(0, 20) + (msg.text.length > 20 ? '...' : '');
      }
      saveSessions(sessions);
    }
  } catch (e) {
    console.warn('[History] Save failed:', e);
  }
}

function loadChatHistory() {
  let sessionId = null;
  try {
    sessionId = getCurrentSessionId();
    const key = STORAGE_KEY + '_' + sessionId;
    const history = JSON.parse(localStorage.getItem(key) || '[]');
    clearMessages();
    history.forEach(msg => {
      if (msg.type === 'user') {
        addUserMessage(msg.text, null, false);
      } else if (msg.type === 'other') {
        addOtherMessage(msg.text, msg.sender, false);
      } else if (msg.type === 'system') {
        addSystemMessage(msg.text, false);
      }
    });
    if (history.length > 0) {
      addSystemMessage(`已加载 ${history.length} 条历史消息`, false);
      localHistoryLoaded = true;
    } else {
      // 历史为空时显示欢迎消息，允许服务端历史覆盖
      showWelcomeMessage();
    }
    updateSessionName();
    scrollToBottom(true);
  } catch (e) {
    console.error('[History] Load failed:', e);
    console.error('[History] Session ID at failure:', sessionId);
    // 确保页面上不完全是空白
    if (elements.messages && elements.messages.children.length === 0) {
      showWelcomeMessage();
    }
  }
}

function clearChatHistory() {
  const sessionId = getCurrentSessionId();
  localStorage.removeItem(STORAGE_KEY + '_' + sessionId);
}

function showWelcomeMessage() {
  elements.messages.innerHTML = `
    <div class="message system-message">
      <div class="message-bubble system">
        <span class="system-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
          </svg>
        </span>
        <span>欢迎使用聊天！连接 WebSocket 服务器后即可开始对话。</span>
      </div>
    </div>
  `;
}

function clearMessages() {
  elements.messages.innerHTML = '';
}

function updateSessionName() {
  const sessions = getSessions();
  const sessionId = getCurrentSessionId();
  const session = sessions.find(s => s.id === sessionId);
  if (session && elements.sessionName) {
    elements.sessionName.textContent = session.name;
  }
}

function switchSession(sessionId, syncToBackend = true) {
  const sessions = getSessions();
  const session = sessions.find(s => s.id === sessionId);
  setActiveSessionId(sessionId);
  // 切换会话时重置标记，允许服务端历史（含模型回复）覆盖本地历史
  // 本地历史可能因流式回复未被持久化而丢失模型回复
  localHistoryLoaded = false;
  loadChatHistory();
  closeSessionPanel();
  if (session && syncToBackend) {
    syncSessionToBackend('switch', session.name, session.id);
  }
  showToast('已切换会话');
}

function renderSessionList() {
  const sessions = getSessions();
  const activeId = getCurrentSessionId();
  elements.sessionList.innerHTML = '';
  if (sessions.length === 0) {
    elements.sessionList.innerHTML = '<div class="session-empty">暂无会话，点击新建</div>';
    return;
  }
  sessions.forEach(session => {
    const div = document.createElement('div');
    div.className = 'session-item' + (session.id === activeId ? ' active' : '');
    const time = new Date(session.updatedAt);
    const timeStr = time.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) + ' ' + time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `
      <div class="session-item-info">
        <div class="session-item-name">${escapeHtml(session.name)}</div>
        <div class="session-item-time">${timeStr}</div>
      </div>
      <button class="session-item-delete" data-session-id="${session.id}" title="删除会话">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
      </button>
    `;
    div.addEventListener('click', (e) => {
      if (!e.target.closest('.session-item-delete')) {
        switchSession(session.id);
      }
    });
    div.querySelector('.session-item-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      if (sessions.length <= 1) {
        showToast('至少保留一个会话');
        return;
      }
      if (confirm('确定删除此会话？')) {
        deleteSession(session.id);
        renderSessionList();
        loadChatHistory();
        showToast('会话已删除');
      }
    });
    elements.sessionList.appendChild(div);
  });
}

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
  elements.sessionBtn = document.getElementById('session-btn');
  elements.sessionPanel = document.getElementById('session-panel');
  elements.sessionOverlay = document.getElementById('session-overlay');
  elements.sessionList = document.getElementById('session-list');
  elements.newSessionBtn = document.getElementById('new-session-btn');
  elements.sessionCloseBtn = document.getElementById('session-close-btn');
  elements.sessionName = document.getElementById('session-name');
  elements.testNotificationBtn = document.getElementById('test-notification-btn');
}

// === File Transfer ===
// Track files received during current session
const fileTransferState = {
  pendingChunks: new Map(), // fileId -> { chunks: [], total: 0, meta: {} }
  savedFiles: [],           // { name, path, size, mime }
};

function handleFileList(data) {
  if (!data.files || !data.files.length) {
    addSystemMessage('📂 未找到匹配的文件');
    return;
  }
  addFileListMessage(data.files, data.query || '');
}

function handleFileData(data) {
  // data: { path, name, mime, data (base64), size, encoding, id }
  const isText = data.mime && data.mime.startsWith('text/');
  let fileContent;

  if (data.encoding === 'base64') {
    // Decode base64 to binary
    const binaryStr = atob(data.data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    fileContent = bytes;
  } else {
    // Text content - encode as UTF-8 bytes
    const encoder = new TextEncoder();
    fileContent = encoder.encode(data.data);
  }

  addFileCardMessage({
    name: data.name,
    path: data.path,
    size: data.size,
    mime: data.mime || 'application/octet-stream',
    content: fileContent,
    isText: isText,
    textContent: isText ? (data.encoding === 'base64' ? atob(data.data) : data.data) : null,
  });
}

async function saveFileToDevice(fileInfo) {
  const { name, content, mime } = fileInfo;

  try {
    // Log the resolved save path if available
    if (window.__TAURI__) {
      let downloadDir = 'Download';
      if (window.__TAURI__.path && window.__TAURI__.path.downloadDir) {
        downloadDir = await window.__TAURI__.path.downloadDir();
      }
      console.log('[File] Saving to directory:', downloadDir);
      console.log('[File] Full save path:', downloadDir + '/' + name);
    }

    // Try using Tauri FS plugin
    if (window.__TAURI__) {
      // Use the high-level fs plugin API (available with withGlobalTauri: true)
      if (window.__TAURI__.fs && window.__TAURI__.fs.writeFile) {
        await window.__TAURI__.fs.writeFile(name, new Uint8Array(content), {
          baseDir: window.__TAURI__.fs.BaseDirectory.Download,
        });

        showToast('✅ 文件已保存: ' + name);
        return { success: true, path: name };
      }

      // Tauri v2 plugin-fs write_file expects path in headers and data as raw body
      if (window.__TAURI__.core) {
        await window.__TAURI__.core.invoke('plugin:fs|write_file', new Uint8Array(content), {
          headers: {
            path: encodeURIComponent(name),
            options: JSON.stringify({ baseDir: 'Download' }),
          },
        });

        showToast('✅ 文件已保存: ' + name);
        return { success: true, path: name };
      }
    }

    // Fallback: download via blob URL
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    showToast('✅ 文件已下载: ' + name);
    return { success: true, path: null };
  } catch (err) {
    console.error('[File] Save error:', err);
    showToast('❌ 保存文件失败: ' + (err.message || err));
    return { success: false, path: null };
  }
}

async function saveFileButtonClick(fileInfo) {
  const { name, content, mime } = fileInfo;

  // On mobile (especially Android), use Web Share API first
  // System share sheet includes "Save to Files" / "Save to Downloads" options
  if (navigator.share) {
    try {
      const blob = new Blob([content], { type: mime });
      const file = new File([blob], name, { type: mime });
      await navigator.share({
        files: [file],
        title: name,
      });
      return;
    } catch (shareErr) {
      if (shareErr.name === 'AbortError') return;
      console.warn('[File] Save via Share API error:', shareErr);
    }
  }

  // Fallback: try Tauri FS (writes to app-private directory on Android)
  const result = await saveFileToDevice(fileInfo);
  if (result.success) {
    showToast('✅ 文件已保存');
  }
}

async function shareFile(fileInfo) {
  const { name, content, mime } = fileInfo;

  try {
    console.log('[File] navigator.share available:', !!navigator.share);

    // Try Web Share API (not available in Android WebView, only in Chrome)
    if (navigator.share) {
      try {
        const blob = new Blob([content], { type: mime });
        const file = new File([blob], name, { type: mime });
        await navigator.share({
          files: [file],
          title: name,
        });
        return; // Shared successfully
      } catch (shareErr) {
        if (shareErr.name === 'AbortError') return;
        console.warn('[File] Share API error:', shareErr);
      }
    }

    // Try Tauri Android share via plugin command
    if (window.__TAURI__ && window.__TAURI__.core) {
      const result = await window.__TAURI__.core.invoke('plugin:share|share_file', {
        name,
        contents: Array.from(content),
        mime,
      });
      if (result) return;
    }

    // Fallback: save file
    const result = await saveFileToDevice(fileInfo);
    if (result.success) {
      showToast('文件已保存: ' + name);
    }
  } catch (err) {
    console.error('[File] Share error:', err);
    showToast('分享失败');
  }
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function getFileIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const icons = {
    rs: '🦀', js: '📜', ts: '📘', py: '🐍', go: '🔵',
    java: '☕', html: '🌐', css: '🎨', json: '📋',
    md: '📝', txt: '📄', pdf: '📕', png: '🖼️',
    jpg: '🖼️', jpeg: '🖼️', gif: '🎭', svg: '✨',
    zip: '📦', tar: '📦', gz: '📦',
  };
  return icons[ext] || '📎';
}

// Handle file_read tool result from the AI — extract file path & content, show card
function handleFileToolResult(data) {
  const content = data.content || '';
  
  // Try to parse the file_read output (contains path + content with line numbers)
  let path = '', fileContent = '', fileName = '';
  
  // file_read returns JSON: {"path":"...","content":"...","lines":N,"start":0,"end":N,"truncated":false}
  try {
    const parsed = JSON.parse(content);
    path = parsed.path || '';
    fileContent = parsed.content || '';
    fileName = path.split('/').pop() || path.split('\\').pop() || 'file';
  } catch (e) {
    // Not JSON — try to extract first line as path
    const lines = content.split('\n');
    if (lines.length > 0) {
      fileContent = content;
      // Try to find file path in the content
      const pathMatch = content.match(/^(?:File|Path):\s*(.+)/m);
      path = pathMatch ? pathMatch[1].trim() : '';
      fileName = path.split('/').pop() || 'file';
    }
  }

  if (!fileContent) return;

  // Determine MIME type from file extension
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const textExts = ['rs','js','ts','py','go','java','c','cpp','h','html','css','json','md','txt','toml','yaml','yml','xml','sh','bash','zsh','fish','sql','rb','php','swift','kt','scala','dart','lua','r','m','mm','vue','svelte','jsx','tsx'];
  const isText = textExts.includes(ext);

  // Encode the text content as bytes for the save function
  const encoder = new TextEncoder();
  const contentBytes = encoder.encode(fileContent);

  addFileCardMessage({
    name: fileName,
    path: path,
    size: contentBytes.length,
    mime: isText ? 'text/plain' : 'application/octet-stream',
    content: contentBytes,
    isText: true,
    textContent: fileContent,
  });
}

function addFileListMessage(files, query) {
  const div = document.createElement('div');
  div.className = 'message file-list-msg';

  const fileCards = files.map(f => `
    <div class="file-card" data-path="${escapeHtml(f.path)}" data-name="${escapeHtml(f.name)}" data-size="${f.size}">
      <span class="file-icon-card">${getFileIcon(f.name)}</span>
      <div class="file-info-card">
        <span class="file-name-card">${escapeHtml(f.name)}</span>
        <span class="file-size-card">${formatFileSize(f.size)}</span>
      </div>
      <span class="file-type-badge">${f.kind === 'dir' ? '📁' : '📄'}</span>
    </div>
  `).join('');

  div.innerHTML = `
    <div class="message-bubble file-bubble">
      <div class="file-list-header">
        <span class="file-query-label">🔍 搜索结果</span>
        ${query ? `<span class="file-query-text">${escapeHtml(query)}</span>` : ''}
      </div>
      <div class="file-list-cards">
        ${fileCards}
      </div>
      <div class="file-list-footer">
        共 ${files.length} 个结果
      </div>
    </div>
    <div class="message-meta">
      <span class="message-time">${formatTime(new Date())}</span>
    </div>
  `;

  elements.messages.appendChild(div);
  scrollToBottom();
}

function addFileCardMessage(fileInfo) {
  const div = document.createElement('div');
  div.className = 'message file-transfer-msg';

  const previewHtml = fileInfo.isText && fileInfo.textContent
    ? `<pre class="file-preview">${escapeHtml(fileInfo.textContent.substring(0, 2000))}${fileInfo.textContent.length > 2000 ? '...' : ''}</pre>`
    : '';

  div.innerHTML = `
    <div class="message-bubble file-bubble">
      <div class="file-card transfer-card">
        <div class="file-card-main">
          <span class="file-icon-card">${getFileIcon(fileInfo.name)}</span>
          <div class="file-info-card">
            <span class="file-name-card">${escapeHtml(fileInfo.name)}</span>
            <span class="file-size-card">${formatFileSize(fileInfo.size)}</span>
          </div>
        </div>
        <div class="file-card-actions">
          <button class="file-action-btn save-btn" data-name="${escapeHtml(fileInfo.name)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            保存
          </button>
          <button class="file-action-btn share-btn" data-name="${escapeHtml(fileInfo.name)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
            分享
          </button>
        </div>
      </div>
      ${previewHtml}
      <div class="file-transfer-note">📁 来自服务器</div>
    </div>
    <div class="message-meta">
      <span class="message-time">${formatTime(new Date())}</span>
    </div>
  `;

  // Store file data on the element for action buttons
  div._fileInfo = fileInfo;

  // Bind save button
  div.querySelector('.save-btn')?.addEventListener('click', async () => {
    await saveFileButtonClick(fileInfo);
  });

  // Bind share button
  div.querySelector('.share-btn')?.addEventListener('click', async () => {
    await shareFile(fileInfo);
  });

  elements.messages.appendChild(div);
  scrollToBottom();
  messageCount++;
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
    const sessionId = getCurrentSessionId();
    const payload = JSON.stringify({
      type: 'prompt',
      text: trimmed,
      id: msgId,
      session_id: sessionId,
    });
    ws.send(payload);

    // Track sent message for deduplication
    sentMessages.set(trimmed, msgId);
    setTimeout(() => sentMessages.delete(trimmed), DEDUP_WINDOW_MS);

    // Add user message to chat
    addUserMessage(trimmed);
    pendingTaskCount++;
    // If app is already in background, mark for notification
    if (document.hidden) {
      wasBackgroundedDuringTask = true;
    }
  } catch (err) {
    console.error('[WebSocket] Send error:', err);
    showToast('发送失败');
    return;
  }

  elements.input.value = '';
  autoResizeInput();
  updateSendButton();
  messageCount++;

  // Scroll after input resize stabilizes layout, so container height is final
  scrollToBottom(true);
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
      bubble.innerHTML = renderMarkdown(streamingBuffer);
    }
    scrollToBottom();
    return;
  }

  if (type === 'result') {
    if (streamingMsgEl) {
      // Use streamingBuffer (accumulated across ALL turns), not parsed.full_response
      // because full_response only contains the LAST turn's text, losing earlier turns.
      const bubble = streamingMsgEl.querySelector('.message-bubble');
      if (bubble && streamingBuffer) {
        bubble.innerHTML = renderMarkdown(streamingBuffer);
      }
      streamingMsgEl = null;
      if (streamingBuffer) {
        saveMessageToHistory({ type: 'other', text: streamingBuffer, sender: null, time: formatTime(new Date()) });
      }
      scrollToBottom(true);
    } else if (parsed.full_response || parsed.summary) {
      // Non-streaming result (e.g. /status command)
      // addOtherMessage already saves to history internally
      addOtherMessage(parsed.full_response || parsed.summary);
    }
    // Notify if task completed while app was backgrounded
    pendingTaskCount = Math.max(0, pendingTaskCount - 1);
    if (pendingTaskCount === 0 && wasBackgroundedDuringTask && document.hidden) {
      sendBackgroundTaskNotification();
      wasBackgroundedDuringTask = false;
    }
    streamingBuffer = '';
    hideTyping();
    messageCount++;
    return;
  }

  if (type === 'error') {
    addSystemMessage('❌ ' + (parsed.message || '未知错误'));
    pendingTaskCount = Math.max(0, pendingTaskCount - 1);
    if (pendingTaskCount === 0 && wasBackgroundedDuringTask && document.hidden) {
      sendBackgroundTaskNotification();
      wasBackgroundedDuringTask = false;
    }
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

  if (type === 'history') {
    const messages = parsed.messages || [];
    // 如果本地历史已加载，不再用服务端历史覆盖
    if (localHistoryLoaded) {
      console.log('[History] Local history already loaded, skipping server history');
      return;
    }
    // Don't overwrite with empty backend data
    if (messages.length === 0) {
      return;
    }
    clearMessages();
    messages.forEach(msg => {
      if (msg.role === 'user') {
        addUserMessage(msg.content, null, false);
      } else if (msg.role === 'assistant') {
        addOtherMessage(msg.content, null, false);
      }
    });
    addSystemMessage(`已从服务器加载 ${messages.length} 条历史消息`, false);
    scrollToBottom();
    return;
  }

  if (type === 'file_list') {
    handleFileList(parsed);
    return;
  }

  if (type === 'file_data') {
    handleFileData(parsed);
    return;
  }

  if (type === 'tool_call') {
    return;
  }

  // Handle file_read tool results — show file card with save/share
  if (type === 'tool_result' && parsed.name === 'file_read') {
    handleFileToolResult(parsed);
    return;
  }

  if (type === 'tool_result') {
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
    <div class="message-bubble markdown-body"></div>
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

function addUserMessage(text, msgId = null, save = true) {
  const div = document.createElement('div');
  div.className = 'message user';

  const time = formatTime(new Date());

  div.innerHTML = `
    <div class="message-bubble markdown-body">${renderMarkdown(text)}</div>
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
  if (save) {
    saveMessageToHistory({ type: 'user', text, time });
  }
}

function addOtherMessage(text, sender = null, save = true) {
  const div = document.createElement('div');
  div.className = 'message other';

  const time = formatTime(new Date());
  const senderHtml = sender
    ? `<div class="sender-name">@${escapeHtml(sender)}</div>`
    : '';

  div.innerHTML = `
    ${senderHtml}
    <div class="message-bubble markdown-body">${renderMarkdown(text)}</div>
    <div class="message-meta">
      <span class="message-time">${time}</span>
    </div>
  `;

  elements.messages.appendChild(div);
  scrollToBottom();
  if (save) {
    saveMessageToHistory({ type: 'other', text, sender, time });
  }
}

function addSystemMessage(text, save = true) {
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
  if (save) {
    saveMessageToHistory({ type: 'system', text });
  }
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
function scrollToBottom(force = false) {
  if (!force && !isAtBottom) return;
  if (force) isAtBottom = true;
  const container = elements.container;
  container.scrollTop = container.scrollHeight;
  requestAnimationFrame(() => {
    if (!isAtBottom) return;
    container.scrollTop = container.scrollHeight;
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

function toggleSessionPanel() {
  const isHidden = elements.sessionPanel.classList.contains('hidden');
  if (isHidden) {
    renderSessionList();
    elements.sessionPanel.classList.remove('hidden');
    elements.sessionOverlay.classList.remove('hidden');
  } else {
    closeSessionPanel();
  }
}

function closeSessionPanel() {
  elements.sessionPanel.classList.add('hidden');
  elements.sessionOverlay.classList.add('hidden');
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

function renderMarkdown(text) {
  if (!text) return '';
  const rawHtml = marked.parse(text, {
    breaks: true,
    gfm: true,
  });
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
      'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'a', 'img', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span'],
    ALLOWED_ATTR: ['href', 'target', 'src', 'alt', 'title', 'class'],
  });
}

// === Android Notification (Background Task Completion) ===
// Cache for notification permission state
let notificationPermissionGranted = false;

// Initialize notification permission (Android 13+ requires runtime permission)
async function initNotificationPermission() {
  if (!window.__TAURI__ || !window.__TAURI__.core) {
    showToast('通知不可用（非 Tauri 环境）');
    return;
  }
  try {
    const granted = await window.__TAURI__.core.invoke('plugin:notification|is_permission_granted');
    notificationPermissionGranted = granted;
    console.log('[Notification] Permission granted:', granted);
    if (!granted) {
      showToast('请求通知权限...');
      const result = await window.__TAURI__.core.invoke('plugin:notification|request_permission');
      notificationPermissionGranted = (result === 'granted');
      console.log('[Notification] Permission request result:', result);
      if (notificationPermissionGranted) {
        showToast('通知权限已获取');
      } else {
        showToast('通知权限被拒绝，可前往系统设置开启');
      }
    }
  } catch (e) {
    console.error('[Notification] Permission init failed:', e);
    showToast('通知权限检查失败: ' + e);
  }
}

// Send a notification when a background task completes
async function sendBackgroundTaskNotification() {
  if (!window.__TAURI__ || !window.__TAURI__.core) {
    showToast('通知发送失败：非 Tauri 环境');
    return;
  }
  if (!notificationPermissionGranted) {
    console.warn('[Notification] Cannot send: permission not granted');
    return;
  }
  try {
    await window.__TAURI__.core.invoke('plugin:notification|notify', {
      options: {
        title: '任务已完成',
        body: 'AI 回复已完成，请查看应用。',
      },
    });
    console.log('[Notification] Sent successfully');
  } catch (e) {
    console.error('[Notification] Send failed:', e);
    showToast('通知发送失败: ' + e);
  }
}

// Test notification button (called from settings)
async function sendTestNotification() {
  if (!window.__TAURI__ || !window.__TAURI__.core) {
    showToast('通知不可用');
    return;
  }
  // Re-check and request permission
  try {
    const granted = await window.__TAURI__.core.invoke('plugin:notification|is_permission_granted');
    notificationPermissionGranted = granted;
    if (!granted) {
      const result = await window.__TAURI__.core.invoke('plugin:notification|request_permission');
      notificationPermissionGranted = (result === 'granted');
      if (!notificationPermissionGranted) {
        showToast('通知权限被拒绝');
        return;
      }
    }
    await window.__TAURI__.core.invoke('plugin:notification|notify', {
      options: {
        title: '测试通知',
        body: '如果你看到这条通知，通知功能正常工作！',
      },
    });
    showToast('✅ 测试通知已发送，请查看通知栏');
  } catch (e) {
    console.error('[Notification] Test failed:', e);
    showToast('❌ 测试通知失败: ' + e);
  }
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

  // Test notification button in settings
  elements.testNotificationBtn.addEventListener('click', sendTestNotification);

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

  // Session panel toggle
  elements.sessionBtn.addEventListener('click', toggleSessionPanel);

  // New session button
  elements.newSessionBtn.addEventListener('click', () => {
    const newSession = createSession();
    renderSessionList();
    loadChatHistory();
    showToast('新会话已创建');
  });

  // Close session panel
  elements.sessionCloseBtn.addEventListener('click', closeSessionPanel);

  // Close session drawer when clicking overlay
  elements.sessionOverlay.addEventListener('click', closeSessionPanel);

  // Close settings/session on escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!elements.settingsPanel.classList.contains('hidden')) {
        closeSettings();
      }
      if (!elements.sessionPanel.classList.contains('hidden')) {
        closeSessionPanel();
      }
    }
  });

  // Close settings/session when clicking outside
  document.addEventListener('click', (e) => {
    if (
      !elements.settingsPanel.classList.contains('hidden') &&
      !elements.settingsPanel.contains(e.target) &&
      !elements.settingsBtn.contains(e.target)
    ) {
      closeSettings();
    }
    if (
      !elements.sessionPanel.classList.contains('hidden') &&
      !elements.sessionPanel.contains(e.target) &&
      !elements.sessionBtn.contains(e.target)
    ) {
      closeSessionPanel();
    }
  });

  // Visibility change - background notification & reconnect
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // App minimized: if tasks are running, mark for notification on completion
      if (pendingTaskCount > 0) {
        wasBackgroundedDuringTask = true;
      }
    } else {
      // App restored: clear notification flag (user is back)
      wasBackgroundedDuringTask = false;
      // Reconnect if needed
      if (!isConnected && reconnectAttempts < CONFIG.maxReconnectAttempts) {
        reconnectAttempts = 0;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        connectWebSocket();
      }
    }
  });

  // Mobile: re-scroll when the virtual keyboard opens/closes (viewport resizes).
  // The keyboard changes the viewport height, which can misalign the scroll position.
  let viewportTimer = null;
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (!isAtBottom) return;
      clearTimeout(viewportTimer);
      viewportTimer = setTimeout(() => {
        if (!isAtBottom) return;
        elements.container.scrollTop = elements.container.scrollHeight;
      }, 100);
    });
  }
}



// === Init ===
async function init() {
  cacheElements();
  initNotificationPermission();
  loadChatHistory();
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
