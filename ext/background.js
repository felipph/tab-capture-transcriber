// ── Tab Capture Pro – Background Service Worker ────────────────────────────

let recorderWindowId = null;
let callState = {
  inCall:           false,
  tabId:            null,
  participants:     {},
  activeSpeaker:    null,
  contentSharing:   false,
  contentPresenter: null,
  startedAt:        null
};
let selectedTabId = null; // Aba selecionada para gravação

const RECORDER_URL = chrome.runtime.getURL('recorder.html');

// Verifica se a aba é do Teams
function isTeamsTab(url) {
  if (!url) return false;
  return url.includes('teams.microsoft.com')
    || url.includes('teams.live.com')
    || url.includes('teams.microsoft.us')
    || url.includes('teams.cloud.microsoft.mcas.ms');
}

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

// ── Lista todas as abas disponíveis para gravação ─────────────────────────────
async function listTabs(sendResponse) {
  try {
    const tabs = await chrome.tabs.query({});
    const availableTabs = tabs
      .filter(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'))
      .map(t => ({
        id: t.id,
        title: t.title || 'Sem título',
        url: t.url,
        favIconUrl: t.favIconUrl || '',
        isTeams: isTeamsTab(t.url),
        active: t.active
      }));
    sendResponse({ success: true, tabs: availableTabs });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ── Obtém o stream ID de qualquer aba ────────────────────────────────────────
async function getStreamId(sendResponse, targetTabId = null) {
  try {
    let tab = null;

    // Se foi especificado um tabId, usa ele
    if (targetTabId) {
      tab = await chrome.tabs.get(targetTabId).catch(() => null);
    }

    // Se não, tenta usar a aba selecionada anteriormente
    if (!tab && selectedTabId) {
      tab = await chrome.tabs.get(selectedTabId).catch(() => null);
    }

    // Fallback: aba ativa que não seja a extensão
    if (!tab) {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (active && !active.url?.startsWith('chrome-extension://') && !active.url?.startsWith('chrome://')) {
        tab = active;
      }
    }

    if (!tab) {
      throw new Error('Nenhuma aba disponível para gravação. Selecione uma aba válida.');
    }

    // Verifica se é uma URL válida
    if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('chrome-extension://')) {
      throw new Error('Não é possível gravar páginas internas do Chrome.');
    }

    selectedTabId = tab.id;
    callState.tabId = tab.id;

    chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (streamId) => {
      if (chrome.runtime.lastError || !streamId) {
        sendResponse({ success: false, error: chrome.runtime.lastError?.message || 'getMediaStreamId falhou' });
        return;
      }
      sendResponse({
        success: true,
        streamId,
        tabTitle: tab.title,
        tabId: tab.id,
        tabUrl: tab.url,
        isTeams: isTeamsTab(tab.url)
      });
    });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ── Screenshot ────────────────────────────────────────────────────────────────
async function takeScreenshot(sendResponse) {
  try {
    // Usa a aba selecionada ou a do callState
    const tabId = selectedTabId || callState.tabId;
    let tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;

    if (!tab) {
      // Fallback: aba ativa que não seja interna do Chrome
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = tabs.find(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'));
    }

    if (!tab) throw new Error('Nenhuma aba disponível para screenshot');

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png', quality: 95 });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await chrome.downloads.download({
      url: dataUrl, filename: `TabCapture/screenshots/screenshot-${ts}.png`, saveAs: false
    });
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  }
}

// ── Captura frame (sem download local) ───────────────────────────────────────
async function captureFrame(sendResponse) {
  try {
    const tabId = selectedTabId || callState.tabId;
    let tab = tabId ? await chrome.tabs.get(tabId).catch(() => null) : null;

    if (!tab) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = tabs.find(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'));
    }

    if (!tab) throw new Error('Nenhuma aba disponível para captura de frame');

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png', quality: 95 });
    sendResponse({ success: true, dataUrl });
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
      filename: `TabCapture/recordings/${safeName}-${ts}.${ext}`,
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

    case 'CONTENT_SHARING_START':
      callState.contentSharing = true;
      callState.contentPresenter = msg.presenter;
      notifyRecorder({ event: 'CONTENT_SHARING_START', presenter: msg.presenter, timestamp: msg.timestamp });
      break;

    case 'CONTENT_SHARING_STOP':
      callState.contentSharing = false;
      callState.contentPresenter = null;
      notifyRecorder({ event: 'CONTENT_SHARING_STOP', timestamp: msg.timestamp });
      break;

    case 'CONTENT_SHARING_PRESENTER_CHANGE':
      callState.contentPresenter = msg.presenter;
      notifyRecorder({ event: 'CONTENT_SHARING_PRESENTER_CHANGE', presenter: msg.presenter, timestamp: msg.timestamp });
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

    case 'listTabs':
      listTabs(sendResponse);
      return true;

    case 'selectTab':
      selectedTabId = msg.tabId;
      sendResponse({ success: true, tabId: msg.tabId });
      return false;

    case 'getStreamId':
      getStreamId(sendResponse, msg.tabId);
      return true;

    case 'takeScreenshot':
      takeScreenshot(sendResponse);
      return true;

    case 'captureFrame':
      captureFrame(sendResponse);
      return true;

    case 'saveRecording':
      saveRecording(msg.data, msg.mimeType, msg.label, sendResponse);
      return true;

    case 'getCallState':
      sendResponse({ success: true, callState, selectedTabId });
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
