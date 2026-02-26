// ── Tab Capture Pro – Recorder Window ───────────────────────────────────────

// ── Estado ────────────────────────────────────────────────────────────────────
let isRecording      = false;
let inCall           = false;
let isTeamsTab       = false;
let selectedTabId    = null;
let selectedTabTitle = '';
let selectedTabUrl   = '';
let timerInterval    = null;
let autoSnapInterval = null;
let elapsedSeconds   = 0;
let snapCount        = 0;
let recCount         = 0;
let animFrame        = null;
let participants     = {};
let activeSpeaker    = null;
let callStartTime    = null;
let audioChunkIndex  = 0;

// Content capture
let contentSharing       = false;
let contentPresenter     = null;
let contentCaptureTimer  = null;
let contentFrameIndex    = 0;
let lastFrameSize        = 0;

// Media
let tabRecorder  = null;
let micRecorder  = null;
let tabStream    = null;
let micStream    = null;
let audioContext = null;

// User speech detection
let micAnalyser       = null;
let userSpeakingTimer = null;
let lastUserSpeakingState = false;
const USER_SPEAKING_THRESHOLD = 30; // RMS threshold for speech detection

// WebSocket
let ws            = null;
let wsConnected   = false;
let wsChunkMs     = 250;
let wsSendQueue   = [];
let wsSending     = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const btnStart        = $('btnStart');
const btnStop         = $('btnStop');
const btnSnap         = $('btnSnap');
const timerDisplay    = $('timerDisplay');
const statusDot       = null; // não usado mais
const callPill        = $('callPill');
const wsDot           = $('wsDot');
const logList         = $('logList');
const snapCountEl     = $('snapCount');
const recCountEl      = $('recCount');
const toggleAudio     = $('toggleAudio');
const toggleSeparate  = $('toggleSeparate');
const toggleAutoSnap  = $('toggleAutoSnap');
const separateRow     = $('separateRow');
const snapIntervalEl  = $('snapInterval');
const toggleWS        = $('toggleWS');
const wsUrlInput      = $('wsUrl');
const toggleMeta      = $('toggleMeta');
const wsChunkMsInput  = $('wsChunkMs');
const toggleSaveLocal = $('toggleSaveLocal');
const toggleAutoStart     = $('toggleAutoStart');
const toggleContentCapture = $('toggleContentCapture');
const contentIntervalEl    = $('contentInterval');
const transcriptList       = $('transcriptList');
const participantsList    = $('participantsList');
const participantCountEl  = $('participantCount');
const currentSpeakerEl    = $('currentSpeaker');
const timelineList        = $('timelineList');
const bars                = document.querySelectorAll('#audioViz .bar');
const tabFavicon          = $('tabFavicon');
const tabName             = $('tabName');
const tabBadge            = $('tabBadge');

// ── Tabs ──────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
const formatTime = s => `${pad(Math.floor(s/3600))}:${pad(Math.floor((s%3600)/60))}:${pad(s%60)}`;
const nowStr = () => { const n=new Date(); return `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`; };

function log(msg, type = '') {
  const li = document.createElement('li');
  if (type) li.classList.add(`log-${type}`);
  li.innerHTML = `<span class="log-time">${nowStr()}</span><span class="log-msg">${msg}</span>`;
  logList.prepend(li);
  while (logList.children.length > 40) logList.removeChild(logList.lastChild);
}

function addTimeline(text, sub = '', dotColor = '') {
  // Remove placeholder
  const placeholder = timelineList.querySelector('.tl-item');
  if (placeholder && placeholder.querySelector('.tl-time').textContent === '--:--:--') {
    placeholder.remove();
  }
  const callSecs = callStartTime ? Math.floor((Date.now() - callStartTime) / 1000) : 0;
  const li = document.createElement('li');
  li.className = 'tl-item';
  li.innerHTML = `
    <span class="tl-time">${formatTime(callSecs)}</span>
    <div class="tl-dot ${dotColor}"></div>
    <div class="tl-event">${text}${sub ? `<div class="tl-sub">${sub}</div>` : ''}</div>`;
  timelineList.prepend(li);
  while (timelineList.children.length > 100) timelineList.removeChild(timelineList.lastChild);
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  if (!toggleWS.checked) return;
  const url = wsUrlInput.value.trim();
  if (!url) return;

  // Fecha conexão anterior se existir (evita duplicatas)
  if (ws) {
    try { ws.onclose = null; ws.close(); } catch (_) {}
    ws = null;
    wsConnected = false;
  }
  wsSendQueue = [];
  wsSending = false;

  try {
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      wsConnected = true;
      wsDot.className = 'ws-dot connected';
      wsDot.title = `Conectado: ${url}`;
      log('WebSocket conectado ✓', 'success');

      // Envia metadados iniciais da chamada
      if (toggleMeta.checked) {
        sendWsMeta({ type: 'SESSION_START', participants, activeSpeaker, timestamp: Date.now() });
      }
    };

    ws.onclose = () => {
      wsConnected = false;
      wsDot.className = 'ws-dot';
      wsDot.title = 'WebSocket desconectado';
      log('WebSocket desconectado', 'warn');
      // Tenta reconectar após 3s se ainda estiver gravando
      if (isRecording) setTimeout(connectWS, 3000);
    };

    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'LIVE_TRANSCRIPT') {
            appendTranscript(msg);
          }
        } catch (_) {}
      }
    };

    ws.onerror = (e) => {
      wsDot.className = 'ws-dot error';
      log('WebSocket erro: ' + (e.message || 'conexão falhou'), 'error');
    };

  } catch (err) {
    log('WS: ' + err.message, 'error');
  }
}

function disconnectWS() {
  if (ws) {
    ws.close();
    ws = null;
    wsConnected = false;
    wsDot.className = 'ws-dot';
  }
}

// ── Transcrição em tempo real ────────────────────────────────────────────────
function appendTranscript(msg) {
  if (!transcriptList) return;

  // Remove placeholder se existir
  const placeholder = transcriptList.querySelector('.transcript-empty');
  if (placeholder) placeholder.remove();

  const speaker = msg.speaker || '?';
  const startSec = msg.start || 0;
  const text = msg.text || '';

  const li = document.createElement('li');
  li.className = 'transcript-item';
  li.innerHTML = `
    <span class="transcript-time">${formatTime(Math.floor(startSec))}</span>
    <span class="transcript-speaker">${speaker}</span>
    <span class="transcript-text">${text}</span>`;
  transcriptList.appendChild(li);

  // Auto-scroll para o final
  transcriptList.scrollTop = transcriptList.scrollHeight;

  // Limita a 200 itens
  while (transcriptList.children.length > 200) transcriptList.removeChild(transcriptList.firstChild);
}

function flushWsQueue() {
  if (wsSending) return;
  wsSending = true;
  while (wsSendQueue.length > 0) {
    const item = wsSendQueue.shift();
    try {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(item);
    } catch (_) {}
  }
  wsSending = false;
}

function sendWsMeta(data) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !toggleMeta.checked) return;
  wsSendQueue.push(JSON.stringify(data));
  flushWsQueue();
}

function sendWsAudio(arrayBuffer) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  wsSendQueue.push(arrayBuffer);
  flushWsQueue();
}

// Envia meta + binário de forma atômica (sem interleaving de audio chunks)
function sendWsMetaAndBinary(metaObj, binaryBuffer) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  wsSendQueue.push(JSON.stringify(metaObj));
  wsSendQueue.push(binaryBuffer);
  flushWsQueue();
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function setUI(recording) {
  isRecording = recording;
  // Habilita start se tiver uma aba selecionada (não precisa estar em chamada do Teams)
  const canStart = selectedTabId && !recording;
  btnStart.disabled = !canStart;
  btnStop.disabled  = !recording;
  btnSnap.disabled  = !recording;
  timerDisplay.classList.toggle('recording', recording);
  bars.forEach(b => b.classList.toggle('active', recording));

  if (recording) {
    callPill.textContent = '● Gravando';
    callPill.className   = 'status-pill recording';
  } else if (inCall && isTeamsTab) {
    callPill.textContent = 'Em chamada';
    callPill.className   = 'status-pill in-call';
  } else if (selectedTabId) {
    callPill.textContent = 'Pronto';
    callPill.className   = 'status-pill ready';
  } else {
    callPill.textContent = 'Aguardando';
    callPill.className   = 'status-pill';
  }
}

// Atualiza informações da aba selecionada
function updateTabInfo(tab) {
  if (!tab) {
    tabName.textContent = 'Nenhuma aba selecionada';
    tabFavicon.style.display = 'none';
    tabBadge.style.display = 'none';
    return;
  }

  selectedTabId = tab.id;
  selectedTabTitle = tab.title || 'Sem título';
  selectedTabUrl = tab.url || '';
  isTeamsTab = tab.isTeams || false;

  tabName.textContent = selectedTabTitle;

  if (tab.favIconUrl) {
    tabFavicon.src = tab.favIconUrl;
    tabFavicon.style.display = 'block';
    tabFavicon.onerror = () => { tabFavicon.style.display = 'none'; };
  } else {
    tabFavicon.style.display = 'none';
  }

  tabBadge.style.display = isTeamsTab ? 'inline' : 'none';
}

function updateSeparateVisibility() {
  separateRow.style.opacity = toggleAudio.checked ? '1' : '0.3';
  separateRow.style.pointerEvents = toggleAudio.checked ? 'auto' : 'none';
}

function animateBars() {
  if (!isRecording) return;
  bars.forEach(b => { b.style.height = (Math.floor(Math.random()*16)+4)+'px'; });
  animFrame = setTimeout(animateBars, 120);
}

function startTimer() {
  elapsedSeconds = 0;
  timerDisplay.textContent = formatTime(0);
  timerInterval = setInterval(() => {
    elapsedSeconds++;
    timerDisplay.textContent = formatTime(elapsedSeconds);
  }, 1000);
}
function stopTimer() { clearInterval(timerInterval); timerInterval = null; }

// ── Participantes ─────────────────────────────────────────────────────────────
function renderParticipants() {
  const names = Object.values(participants);
  participantCountEl.textContent = names.length;

  if (names.length === 0) {
    participantsList.innerHTML = '<li class="no-participants">Nenhum participante detectado.</li>';
    return;
  }

  participantsList.innerHTML = '';
  names.forEach(name => {
    const isSpeaking = activeSpeaker && name.toLowerCase() === activeSpeaker.toLowerCase();
    const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const li = document.createElement('li');
    li.className = 'participant-item';
    li.innerHTML = `
      <div class="participant-avatar" style="${isSpeaking ? 'border:2px solid var(--green);' : ''}">${initials}</div>
      <span class="participant-name">${name}</span>
      ${isSpeaking ? '<span class="participant-badge badge-speaking">● falando</span>' : ''}
    `;
    participantsList.appendChild(li);
  });
}

function updateActiveSpeaker(speaker) {
  activeSpeaker = speaker;
  currentSpeakerEl.textContent = speaker || '—';
  renderParticipants();
}

// ── Screenshot (envia ao backend via WS, sem download local) ─────────────────
function takeScreenshot(label = 'manual') {
  if (!wsConnected || !isRecording) {
    log('Screenshot requer gravação ativa + WS conectado', 'warn');
    return;
  }

  chrome.runtime.sendMessage({ action: 'captureFrame' }, (resp) => {
    if (!resp?.success || !resp.dataUrl) {
      log('Screenshot falhou: ' + (resp?.error || 'sem dados'), 'error');
      return;
    }

    const base64 = resp.dataUrl.split(',')[1];
    if (!base64) return;

    const binaryStr = atob(base64);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);

    sendWsMetaAndBinary({
      type: 'CONTENT_FRAME',
      speaker: activeSpeaker,
      elapsedSeconds,
      frameIndex: contentFrameIndex,
      sizeBytes: len,
      label,
      width: 0,
      height: 0,
      timestamp: Date.now()
    }, bytes.buffer);

    contentFrameIndex++;
    snapCount++;
    snapCountEl.textContent = snapCount;
    log(`Screenshot enviado ao backend (${label}, ${(len/1024).toFixed(0)}KB)`, 'success');
  });
}

function startAutoSnap() {
  const secs = parseInt(snapIntervalEl.value, 10) || 30;
  autoSnapInterval = setInterval(() => takeScreenshot(`auto @${formatTime(elapsedSeconds)}`), secs * 1000);
}
function stopAutoSnap() { clearInterval(autoSnapInterval); autoSnapInterval = null; }

// ── Captura automática de conteúdo (frames para o backend) ───────────────────
function captureAndSendFrame() {
  if (!wsConnected || !isRecording) return;

  chrome.runtime.sendMessage({ action: 'captureFrame' }, (resp) => {
    if (!resp?.success || !resp.dataUrl) {
      log('Frame capture falhou: ' + (resp?.error || 'sem dados'), 'error');
      return;
    }

    // Converte dataURL para binário
    const base64 = resp.dataUrl.split(',')[1];
    if (!base64) return;

    const binaryStr = atob(base64);
    const len = binaryStr.length;

    // Detecção de mudança: compara tamanho do frame
    // Frames idênticos terão tamanhos muito próximos (±1%)
    const sizeDiff = lastFrameSize > 0 ? Math.abs(len - lastFrameSize) / lastFrameSize : 1;
    if (sizeDiff < 0.01 && lastFrameSize > 0) {
      // Frame não mudou — não envia
      return;
    }
    lastFrameSize = len;

    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binaryStr.charCodeAt(i);

    // Envia metadado + binário PNG de forma atômica
    sendWsMetaAndBinary({
      type: 'CONTENT_FRAME',
      speaker: contentPresenter || activeSpeaker,
      elapsedSeconds,
      frameIndex: contentFrameIndex,
      sizeBytes: len,
      width: 0,
      height: 0,
      timestamp: Date.now()
    }, bytes.buffer);

    contentFrameIndex++;
    snapCount++;
    snapCountEl.textContent = snapCount;
    log(`Frame #${contentFrameIndex} enviado (${(len/1024).toFixed(0)}KB)`, 'success');
  });
}

function startContentCapture() {
  if (contentCaptureTimer) return;
  if (!toggleContentCapture?.checked) return;
  if (!isRecording || !wsConnected) return;

  const secs = parseInt(contentIntervalEl?.value, 10) || 5;
  lastFrameSize = 0;
  log(`Captura de conteúdo iniciada (a cada ${secs}s)`, 'success');
  addTimeline('Captura de conteúdo iniciada', contentPresenter || '', 'yellow');

  // Captura imediata + periódica
  captureAndSendFrame();
  contentCaptureTimer = setInterval(captureAndSendFrame, secs * 1000);
}

function stopContentCapture() {
  if (!contentCaptureTimer) return;
  clearInterval(contentCaptureTimer);
  contentCaptureTimer = null;
  lastFrameSize = 0;
  log('Captura de conteúdo parada', 'warn');
  addTimeline('Captura de conteúdo parada', '', 'yellow');
}

// ── User Speech Detection ─────────────────────────────────────────────────────
function setupMicAnalyser() {
  if (!micStream) return;

  try {
    const micAudioContext = new AudioContext({ sampleRate: 48000 });
    const micSrc = micAudioContext.createMediaStreamSource(micStream);
    micAnalyser = micAudioContext.createAnalyser();
    micAnalyser.fftSize = 256;
    micAnalyser.smoothingTimeConstant = 0.3;
    micSrc.connect(micAnalyser);
    log('Analisador de microfone configurado ✓', 'success');
  } catch (err) {
    log(`Erro ao configurar analisador: ${err.message}`, 'error');
    micAnalyser = null;
  }
}

function isUserSpeaking() {
  if (!micAnalyser) return false;

  const dataArray = new Uint8Array(micAnalyser.frequencyBinCount);
  micAnalyser.getByteFrequencyData(dataArray);

  // Calculate RMS-like average
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    sum += dataArray[i];
  }
  const average = sum / dataArray.length;

  return average > USER_SPEAKING_THRESHOLD;
}

function startUserSpeakingDetection() {
  if (!micAnalyser) return;

  lastUserSpeakingState = false;
  userSpeakingTimer = setInterval(() => {
    const isSpeaking = isUserSpeaking();

    if (isSpeaking !== lastUserSpeakingState) {
      lastUserSpeakingState = isSpeaking;

      if (isSpeaking) {
        // User started speaking - update active speaker to "Você" (You)
        updateActiveSpeaker('Você');
        sendWsMeta({
          type: 'SPEAKER_CHANGE',
          speaker: 'Você',
          elapsedSeconds: elapsedSeconds,
          timestamp: Date.now()
        });
        log('Você está falando', 'info');
      } else {
        // User stopped speaking - reset to allow Teams detection to take over
        activeSpeaker = null;
      }
    }
  }, 300); // Check every 300ms
}

function stopUserSpeakingDetection() {
  if (userSpeakingTimer) {
    clearInterval(userSpeakingTimer);
    userSpeakingTimer = null;
  }
  micAnalyser = null;
  lastUserSpeakingState = false;
}

// ── MediaRecorder factory ─────────────────────────────────────────────────────
function makeRecorder(stream, onChunk, intervalMs) {
  const isAudioOnly = stream.getVideoTracks().length === 0;
  const preferred   = isAudioOnly
    ? ['audio/webm;codecs=opus', 'audio/webm', 'video/webm']
    : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mimeType = preferred.find(m => MediaRecorder.isTypeSupported(m)) || '';

  let recorder;
  try   { recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {}); }
  catch { recorder = new MediaRecorder(stream); }

  const resolvedMime = recorder.mimeType || mimeType || 'video/webm';
  const chunks = [];

  recorder.ondataavailable = (e) => {
    if (!e.data?.size) return;
    chunks.push(e.data);
    if (onChunk) onChunk(e.data); // para streaming WS em tempo real
  };
  recorder.onerror = (e) => log('Recorder error: ' + e.error, 'error');

  return { recorder, mimeType: resolvedMime, chunks };
}

// ── Encode blob → base64 ──────────────────────────────────────────────────────
async function blobToBase64(blob) {
  const uint8 = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < uint8.length; i += 8192)
    binary += String.fromCharCode(...uint8.subarray(i, i + 8192));
  return btoa(binary);
}

// ── Salva arquivo localmente ──────────────────────────────────────────────────
async function saveFile(chunks, mimeType, label) {
  if (!chunks.length) { log(`Sem dados para ${label}`, 'error'); return; }
  if (!toggleSaveLocal.checked) return;

  const blob = new Blob(chunks, { type: mimeType });
  log(`Salvando ${label} (${(blob.size/1024/1024).toFixed(1)} MB)…`);
  try {
    const base64 = await blobToBase64(blob);
    chrome.runtime.sendMessage({ action: 'saveRecording', data: base64, mimeType, label }, (resp) => {
      if (resp?.success) {
        recCount++;
        recCountEl.textContent = recCount;
        log(`${label} salvo ✓`, 'success');
      } else {
        log(`${label} falhou: ` + (resp?.error || 'unknown'), 'error');
      }
    });
  } catch (err) {
    log(`${label} erro: ` + err.message, 'error');
  }
}

// ── Iniciar gravação ──────────────────────────────────────────────────────────
async function startCapture() {
  const captureAudio = toggleAudio.checked;
  const separate     = captureAudio && toggleSeparate.checked;

  btnStart.disabled = true;
  log('Solicitando stream da aba…');

  // Conecta WS antes de iniciar
  if (toggleWS.checked) connectWS();

  // Usa a aba selecionada ou pede para o background encontrar uma
  chrome.runtime.sendMessage({ action: 'getStreamId', tabId: selectedTabId }, async (resp) => {
    if (!resp?.success) {
      log('Falhou: ' + (resp?.error || 'unknown'), 'error');
      setUI(false);
      return;
    }

    // Atualiza informações da aba
    if (resp.tabId) selectedTabId = resp.tabId;
    if (resp.tabTitle) selectedTabTitle = resp.tabTitle;
    if (resp.tabUrl) selectedTabUrl = resp.tabUrl;
    isTeamsTab = resp.isTeams || false;
    tabName.textContent = selectedTabTitle;
    tabBadge.style.display = isTeamsTab ? 'inline' : 'none';

    try {
      wsChunkMs = parseInt(wsChunkMsInput.value, 10) || 250;

      // Callback chamado a cada chunk — envia meta + binário atomicamente
      const onTabChunk = (data) => {
        if (!wsConnected) return;
        data.arrayBuffer().then(buf => {
          sendWsMetaAndBinary({
            type: 'AUDIO_CHUNK_META',
            chunkIndex: audioChunkIndex,
            speaker: activeSpeaker,
            elapsedSeconds,
            timestamp: Date.now()
          }, buf);
          audioChunkIndex++;
        });
      };

      // Tab stream - captura áudio e vídeo
      tabStream = await navigator.mediaDevices.getUserMedia({
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: resp.streamId } },
        audio: captureAudio
          ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: resp.streamId } }
          : false
      });

      // Mic stream - captura ANTES de criar o AudioContext
      if (captureAudio) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          log('Microfone concedido ✓', 'success');

          // Setup analyser for user speech detection
          setupMicAnalyser();
        } catch (err) {
          log(`Mic indisponível (${err.message})`, 'error');
          micStream = null;
        }
      }

      if (separate) {
        // ── MODO SEPARADO ─────────────────────────────────────────────────
        const tab = makeRecorder(tabStream, onTabChunk, wsChunkMs);
        tabRecorder = tab.recorder;
        tabRecorder.onstop = () => saveFile(tab.chunks, tab.mimeType, 'tab-audio');

        if (micStream) {
          const mic = makeRecorder(new MediaStream(micStream.getAudioTracks()), null, wsChunkMs);
          micRecorder = mic.recorder;
          micRecorder.onstop = () => saveFile(mic.chunks, mic.mimeType, 'microphone');
          micRecorder.start(wsChunkMs);
          log('Gravando: aba + mic separados', 'success');
        }
        tabRecorder.start(wsChunkMs);

        // Reproduz localmente no modo separado
        if (captureAudio && tabStream.getAudioTracks().length > 0) {
          const audioEl = document.createElement('audio');
          audioEl.srcObject = new MediaStream(tabStream.getAudioTracks());
          audioEl.autoplay = true;
          audioEl.style.display = 'none';
          document.body.appendChild(audioEl);
          window._playbackAudio = audioEl;
          log('Áudio da aba sendo reproduzido localmente ✓', 'success');
        }

      } else {
        // ── MODO MIXADO (padrão) ──────────────────────────────────────────
        let streamToRecord = tabStream;

        if (captureAudio) {
          // Cria AudioContext para mixar áudio da aba + microfone
          audioContext = new AudioContext({ sampleRate: 48000 });

          // Se o AudioContext estiver suspenso, precisamos resumí-lo
          if (audioContext.state === 'suspended') {
            await audioContext.resume();
            log('AudioContext resumido', 'success');
          }

          // Cria destino para o stream mixado
          const dest = audioContext.createMediaStreamDestination();

          // ── Fonte do áudio da aba ──
          const tabAudioTracks = tabStream.getAudioTracks();
          if (tabAudioTracks.length > 0) {
            const tabAudioStream = new MediaStream(tabAudioTracks);
            const tabSrc = audioContext.createMediaStreamSource(tabAudioStream);

            // Ganho para o áudio da aba
            const tabGain = audioContext.createGain();
            tabGain.gain.value = 1.0;

            tabSrc.connect(tabGain);
            tabGain.connect(dest);
            log('Áudio da aba conectado ao mixer ✓', 'success');
          }

          // ── Fonte do microfone ──
          if (micStream) {
            const micAudioStream = new MediaStream(micStream.getAudioTracks());
            const micSrc = audioContext.createMediaStreamSource(micAudioStream);

            // Ganho para o microfone (um pouco mais alto)
            const micGain = audioContext.createGain();
            micGain.gain.value = 1.5;

            micSrc.connect(micGain);
            micGain.connect(dest);
            log('Microfone conectado ao mixer (ganho 1.5x) ✓', 'success');
          }

          // ── Reprodução local: APENAS o áudio da aba (sem microfone) ──
          // Você não quer ouvir sua própria voz
          if (tabAudioTracks.length > 0) {
            const audioEl = document.createElement('audio');
            audioEl.srcObject = new MediaStream(tabAudioTracks);
            audioEl.autoplay = true;
            audioEl.style.display = 'none';
            document.body.appendChild(audioEl);
            window._playbackAudio = audioEl;
            log('Áudio da aba sendo reproduzido localmente ✓', 'success');
          }

          // Combina vídeo original com áudio mixado (para gravação/envio)
          const videoTrack = tabStream.getVideoTracks()[0];
          const mixedAudioTrack = dest.stream.getAudioTracks()[0];

          if (videoTrack && mixedAudioTrack) {
            streamToRecord = new MediaStream([videoTrack, mixedAudioTrack]);
          } else if (mixedAudioTrack) {
            streamToRecord = new MediaStream([mixedAudioTrack]);
          }

          log('AudioContext: ' + audioContext.state + ', sampleRate: ' + audioContext.sampleRate + ', tracks: ' + streamToRecord.getTracks().length, 'success');
        } else {
          // Sem áudio - apenas vídeo
          if (tabStream.getAudioTracks().length > 0) {
            const audioEl = document.createElement('audio');
            audioEl.srcObject = new MediaStream(tabStream.getAudioTracks());
            audioEl.autoplay = true;
            audioEl.style.display = 'none';
            document.body.appendChild(audioEl);
            window._playbackAudio = audioEl;
          }
        }

        const mix = makeRecorder(streamToRecord, onTabChunk, wsChunkMs);
        tabRecorder = mix.recorder;
        tabRecorder.onstop = () => saveFile(mix.chunks, mix.mimeType, 'recording');
        tabRecorder.start(wsChunkMs);

        log('Gravação iniciada: ' + mix.mimeType + ', áudio tracks: ' + streamToRecord.getAudioTracks().length, 'success');
      }

      const participantsList = isTeamsTab ? Object.values(participants).join(', ') || 'nenhum participante' : selectedTabTitle;
      addTimeline('Gravação iniciada', participantsList, 'red');

      if (toggleMeta.checked) {
        sendWsMeta({
          type: 'RECORDING_START',
          tabTitle: selectedTabTitle,
          tabUrl: selectedTabUrl,
          isTeams: isTeamsTab,
          participants,
          activeSpeaker,
          separate,
          timestamp: Date.now()
        });
      }

      // Reset contadores para nova sessão
      contentFrameIndex = 0;
      lastFrameSize = 0;
      audioChunkIndex = 0;

      setUI(true);
      startTimer();
      animateBars();
      if (toggleAutoSnap.checked) startAutoSnap();
      if (toggleContentCapture?.checked) startContentCapture();
      if (captureAudio) startUserSpeakingDetection();

    } catch (err) {
      log('Erro de stream: ' + err.message, 'error');
      setUI(false);
    }
  });
}

// ── Parar gravação ────────────────────────────────────────────────────────────
function stopCapture() {
  if (!isRecording) return;

  if (tabRecorder !== null && tabRecorder.state !== 'inactive') {
    try { tabRecorder.stop(); } catch (e) { console.warn(e); }
  }
  if (micRecorder !== null && micRecorder.state !== 'inactive') {
    try { micRecorder.stop(); } catch (e) { console.warn(e); }
  }

  tabRecorder = null;
  micRecorder = null;

  // Para o elemento de áudio de reprodução local
  if (window._playbackAudio) {
    window._playbackAudio.pause();
    window._playbackAudio.srcObject = null;
    window._playbackAudio.remove();
    window._playbackAudio = null;
  }

  tabStream?.getTracks().forEach(t => t.stop());
  micStream?.getTracks().forEach(t => t.stop());
  audioContext?.close();
  tabStream = micStream = audioContext = null;

  stopContentCapture();
  stopUserSpeakingDetection();

  if (toggleMeta.checked) {
    sendWsMeta({ type: 'RECORDING_STOP', duration: elapsedSeconds, timestamp: Date.now() });
  }

  // Sempre desconecta — cada gravação abre uma nova sessão no backend
  // Pequeno delay para garantir que RECORDING_STOP seja enviado antes de fechar
  setTimeout(disconnectWS, 500);

  addTimeline('Gravação encerrada', `Duração: ${formatTime(elapsedSeconds)}`, 'blue');

  setUI(false);
  stopTimer();
  stopAutoSnap();
  clearTimeout(animFrame);
  bars.forEach(b => { b.style.height = '4px'; b.classList.remove('active'); });
  log('Parando — salvando arquivos…');
}

// ── Eventos do background (Teams DOM events) ──────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg.toRecorder) return;

  switch (msg.event) {
    case 'CALL_STARTED':
      inCall = true;
      callStartTime = msg.timestamp;
      if (isTeamsTab) {
        callPill.textContent = 'Em chamada';
        callPill.className   = 'status-pill in-call';
      }
      btnStart.disabled    = isRecording;
      addTimeline('Chamada iniciada', '', 'green');
      log('Chamada detectada no Teams', 'success');

      // Auto-start se configurado
      if (toggleAutoStart.checked && !isRecording) {
        setTimeout(startCapture, 1000);
      }
      break;

    case 'CALL_ENDED':
      inCall = false;
      callPill.textContent = selectedTabId ? 'Pronto' : 'Aguardando';
      callPill.className   = selectedTabId ? 'status-pill ready' : 'status-pill';
      btnStart.disabled    = !selectedTabId || isRecording;
      addTimeline('Chamada encerrada', '', 'red');
      log('Chamada encerrada', 'warn');
      if (isRecording) stopCapture();
      participants = {};
      activeSpeaker = null;
      renderParticipants();
      break;

    case 'PARTICIPANTS_UPDATE':
      participants = msg.participants || {};
      renderParticipants();
      // Sempre envia ao backend (crítico para identificação de falantes na transcrição)
      if (isRecording && wsConnected) {
        sendWsMeta({ type: 'PARTICIPANTS_UPDATE', participants, timestamp: msg.timestamp });
      }
      addTimeline(
        `Participantes: ${Object.values(participants).length}`,
        Object.values(participants).join(', '),
        'yellow'
      );
      break;

    case 'SPEAKER_CHANGE':
      if (msg.speaker !== activeSpeaker) {
        updateActiveSpeaker(msg.speaker);
        if (msg.speaker) {
          addTimeline(`${msg.speaker} está falando`, '', 'green');
        }
        // Sempre envia ao backend (crítico para identificação de falantes na transcrição)
        if (isRecording && wsConnected) {
          sendWsMeta({
            type: 'SPEAKER_CHANGE',
            speaker: msg.speaker,
            speakerEmail: msg.speakerEmail || null,
            timestamp: msg.timestamp,
            elapsedSeconds
          });
        }
      }
      break;

    case 'CONTENT_SHARING_START':
      contentSharing = true;
      contentPresenter = msg.presenter;
      addTimeline('Compartilhamento iniciado', msg.presenter || '', 'yellow');
      log(`Conteúdo sendo compartilhado${msg.presenter ? ' por ' + msg.presenter : ''}`, 'success');
      if (isRecording && wsConnected) startContentCapture();
      break;

    case 'CONTENT_SHARING_STOP':
      contentSharing = false;
      contentPresenter = null;
      addTimeline('Compartilhamento encerrado', '', 'yellow');
      log('Compartilhamento de conteúdo encerrado', 'warn');
      stopContentCapture();
      break;

    case 'CONTENT_SHARING_PRESENTER_CHANGE':
      contentPresenter = msg.presenter;
      addTimeline('Apresentador mudou', msg.presenter || '', 'yellow');
      log(`Novo apresentador: ${msg.presenter || '?'}`);
      break;
  }
});

// ── Event listeners ───────────────────────────────────────────────────────────
btnStart.addEventListener('click', startCapture);
btnStop.addEventListener('click', stopCapture);
btnSnap.addEventListener('click', () => takeScreenshot('manual'));

toggleAudio.addEventListener('change', () => {
  updateSeparateVisibility();
  chrome.storage.local.set({ captureAudio: toggleAudio.checked });
});

const saveSettings = () => chrome.storage.local.set({
  captureAudio:    toggleAudio.checked,
  separate:        toggleSeparate.checked,
  autoSnap:        toggleAutoSnap.checked,
  snapInterval:    snapIntervalEl.value,
  wsEnabled:       toggleWS.checked,
  wsUrl:           wsUrlInput.value,
  wsMeta:          toggleMeta.checked,
  wsChunkMs:       wsChunkMsInput.value,
  saveLocal:       toggleSaveLocal.checked,
  autoStart:       toggleAutoStart.checked,
  contentCapture:  toggleContentCapture?.checked || false,
  contentInterval: contentIntervalEl?.value || '5',
});

[toggleSeparate, toggleAutoSnap, toggleWS, toggleMeta,
 toggleSaveLocal, toggleAutoStart, toggleContentCapture].filter(Boolean).forEach(el => el.addEventListener('change', saveSettings));
[snapIntervalEl, wsUrlInput, wsChunkMsInput, contentIntervalEl].filter(Boolean).forEach(el => el.addEventListener('change', saveSettings));

// Auto-snap: iniciar/parar imediatamente ao alternar durante gravação
toggleAutoSnap.addEventListener('change', () => {
  if (!isRecording) return;
  if (toggleAutoSnap.checked) { startAutoSnap(); }
  else { stopAutoSnap(); }
});
snapIntervalEl.addEventListener('change', () => {
  if (!isRecording || !toggleAutoSnap.checked) return;
  stopAutoSnap();
  startAutoSnap();
});

// Captura de conteúdo: iniciar/parar imediatamente ao alternar durante gravação
if (toggleContentCapture) {
  toggleContentCapture.addEventListener('change', () => {
    if (!isRecording) return;
    if (toggleContentCapture.checked) { startContentCapture(); }
    else { stopContentCapture(); }
  });
}
if (contentIntervalEl) {
  contentIntervalEl.addEventListener('change', () => {
    if (!isRecording || !toggleContentCapture?.checked) return;
    stopContentCapture();
    startContentCapture();
  });
}

// ── Restaurar configurações ───────────────────────────────────────────────────
chrome.storage.local.get([
  'captureAudio','separate','autoSnap','snapInterval',
  'wsEnabled','wsUrl','wsMeta','wsChunkMs','saveLocal','autoStart',
  'contentCapture','contentInterval'
], (d) => {
  if (d.captureAudio    !== undefined) toggleAudio.checked      = d.captureAudio;
  if (d.separate        !== undefined) toggleSeparate.checked   = d.separate;
  if (d.autoSnap        !== undefined) toggleAutoSnap.checked   = d.autoSnap;
  if (d.snapInterval    !== undefined) snapIntervalEl.value     = d.snapInterval;
  if (d.wsEnabled       !== undefined) toggleWS.checked         = d.wsEnabled;
  if (d.wsUrl           !== undefined) wsUrlInput.value         = d.wsUrl;
  if (d.wsMeta          !== undefined) toggleMeta.checked       = d.wsMeta;
  if (d.wsChunkMs       !== undefined) wsChunkMsInput.value     = d.wsChunkMs;
  if (d.saveLocal       !== undefined) toggleSaveLocal.checked  = d.saveLocal;
  if (d.autoStart       !== undefined) toggleAutoStart.checked  = d.autoStart;
  if (d.contentCapture  !== undefined && toggleContentCapture) toggleContentCapture.checked = d.contentCapture;
  if (d.contentInterval !== undefined && contentIntervalEl) contentIntervalEl.value = d.contentInterval;
  updateSeparateVisibility();
});

// Busca estado atual da chamada ao abrir a janela
chrome.runtime.sendMessage({ action: 'getCallState' }, (resp) => {
  // Carrega aba selecionada
  if (resp?.selectedTabId) {
    selectedTabId = resp.selectedTabId;
    // Busca informações da aba
    chrome.runtime.sendMessage({ action: 'listTabs' }, (tabsResp) => {
      if (tabsResp?.success) {
        const tab = tabsResp.tabs.find(t => t.id === selectedTabId);
        if (tab) {
          updateTabInfo(tab);
          log(`Aba selecionada: ${tab.title}`, 'success');
        }
      }
    });
  }

  // Carrega estado da chamada do Teams
  if (resp?.callState?.inCall) {
    inCall = true;
    callStartTime = resp.callState.startedAt;
    participants  = resp.callState.participants || {};
    activeSpeaker = resp.callState.activeSpeaker;
    isTeamsTab = true;
    callPill.textContent = 'Em chamada';
    callPill.className   = 'status-pill in-call';
    renderParticipants();
    log('Retomando chamada em andamento', 'success');
  }

  setUI(false);
});

// Init
updateSeparateVisibility();
