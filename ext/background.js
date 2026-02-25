// ── Teams Capture Pro – Background Service Worker ────────────────────────────

let recorderWindowId = null;
let callState = {
  inCall:       false,
  tabId:        null,
  participants: {},
  activeSpeaker: null,
  startedAt:    null
};

const RECORDER_URL = chrome.runtime.getURL('recorder.html');

// ── Abre/foca a janela do recorder ────────────────────────────────────────────
async function openRecorder() {
  if (recorderWindowId !== null) {
    try { await chrome.windows.update(recorderWindowId, { focused: true }); return; }
    catch { recorderWindowId = null; }
  }
  const win = await chrome.windows.create({
    url: RECORDER_URL, type: 'popup',
    width: 420, height: 680, left: 80, top: 80, focused: true
  });
  recorderWindowId = win.id;
}

chrome.windows.onRemoved.addListener((id) => {
  if (id === recorderWindowId) recorderWindowId = null;
});

// ── Relata evento para a janela do recorder ───────────────────────────────────
async function notifyRecorder(msg) {
  if (recorderWindowId === null) return;
  try {
    const views = await chrome.runtime.getContexts({
      contextTypes: ['TAB'],
      documentUrls: [RECORDER_URL]
    }).catch(() => null);
    if (views?.length > 0) {
      chrome.runtime.sendMessage({ ...msg, toRecorder: true });
    }
  } catch (_) {}
}

// ── Obtém o stream ID da aba do Teams ────────────────────────────────────────
async function getStreamId(sendResponse) {
  try {
    let tab = null;
    // Tenta pegar a aba do Teams especificamente
    if (callState.tabId) {
      tab = await chrome.tabs.get(callState.tabId).catch(() => null);
    }
    if (!tab) {
      const tabs = await chrome.tabs.query({});
      tab = tabs.find(t =>
        t.url &&
        (t.url.includes('teams.microsoft.com') 
        || t.url.includes('teams.live.com') || t.url.includes('teams.cloud.microsoft.mcas.ms')) &&
        !t.url.startsWith('chrome-extension://')
      );
    }
    if (!tab) {
      // Fallback: aba ativa que não seja a extensão
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active && !active.url?.startsWith('chrome-extension://')) tab = active;
    }
    if (!tab) throw new Error('Aba do Teams não encontrada. Abra o Teams no browser primeiro.');

    callState.tabId = tab.id;

    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        sendResponse({ success: false, error: chrome.runtime.lastError?.message || 'getMediaStreamId falhou' });
        return;
      }
      sendResponse({ success: true, streamId, tabTitle: tab.title, tabId: tab.id });
    });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ── Screenshot ────────────────────────────────────────────────────────────────
async function takeScreenshot(sendResponse) {
  try {
    const tabId = callState.tabId;
    let tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;
    if (!tab) {
      const tabs = await chrome.tabs.query({});
      tab = tabs.find(t => (t.url?.includes('teams.microsoft.com') 
        || t.url?.includes('teams.live.com') || t.url?.includes('teams.cloud.microsoft.mcas.ms')));
    }
    if (!tab) throw new Error('Aba do Teams não encontrada');

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png', quality: 95 });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await chrome.downloads.download({
      url: dataUrl, filename: `TeamsCapture/screenshots/screenshot-${ts}.png`, saveAs: false
    });
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ── Salva arquivo de áudio ────────────────────────────────────────────────────
async function saveRecording(base64Data, mimeType, label, sendResponse) {
  try {
    const baseMime = mimeType.split(';')[0] || 'video/webm';
    const ext = baseMime.includes('mp4') ? 'mp4' : 'webm';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = (label || 'recording').replace(/[^a-z0-9-]/gi, '-');
    await chrome.downloads.download({
      url: `data:${baseMime};base64,${base64Data}`,
      filename: `TeamsCapture/recordings/${safeName}-${ts}.${ext}`,
      saveAs: false
    });
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ── Eventos do content script ─────────────────────────────────────────────────
function handleContentEvent(msg, sender) {
  if (msg.source !== 'content') return false;

  switch (msg.type) {
    case 'CALL_STARTED':
      callState.inCall     = true;
      callState.tabId      = sender.tab?.id ?? callState.tabId;
      callState.startedAt  = msg.timestamp;
      callState.participants = {};
      callState.activeSpeaker = null;
      notifyRecorder({ event: 'CALL_STARTED', timestamp: msg.timestamp });

      // Abre o recorder automaticamente quando a chamada começa
      openRecorder();
      break;

    case 'CALL_ENDED':
      callState.inCall = false;
      notifyRecorder({ event: 'CALL_ENDED', timestamp: msg.timestamp });
      break;

    case 'PARTICIPANTS_UPDATE':
      callState.participants = msg.participants;
      notifyRecorder({ event: 'PARTICIPANTS_UPDATE', participants: msg.participants, timestamp: msg.timestamp });
      break;

    case 'SPEAKER_CHANGE':
      callState.activeSpeaker = msg.speaker;
      notifyRecorder({ event: 'SPEAKER_CHANGE', speaker: msg.speaker, timestamp: msg.timestamp });
      break;

    case 'CALL_INFO':
      notifyRecorder({ event: 'CALL_INFO', ...msg });
      break;
  }
  return false;
}

// ── Roteador de mensagens ─────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Eventos do content script (sem sendResponse)
  if (msg.source === 'content') {
    handleContentEvent(msg, sender);
    return false;
  }

  switch (msg.action) {
    case 'openRecorder':
      openRecorder().then(() => sendResponse({ success: true }));
      return true;

    case 'getStreamId':
      getStreamId(sendResponse);
      return true;

    case 'takeScreenshot':
      takeScreenshot(sendResponse);
      return true;

    case 'saveRecording':
      saveRecording(msg.data, msg.mimeType, msg.label, sendResponse);
      return true;

    case 'getCallState':
      sendResponse({ success: true, callState });
      return false;

    case 'getContentInfo':
      // Pede ao content script para reportar o estado atual
      if (callState.tabId) {
        chrome.tabs.sendMessage(callState.tabId, { action: 'getCallInfo' });
      }
      sendResponse({ success: true });
      return false;

    default:
      return false;
  }
});

// Ícone reflete estado da chamada
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' && callState.tabId === tabId) {
    // Re-injeta content script se necessário (ex: navegação dentro do Teams)
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    }).catch(() => {});
  }
});
