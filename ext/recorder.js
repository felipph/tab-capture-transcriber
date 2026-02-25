// ── Teams Capture Pro – Recorder Window ───────────────────────────────────────

// ── Estado ────────────────────────────────────────────────────────────────────
let isRecording      = false;
let inCall           = false;
let timerInterval    = null;
let autoSnapInterval = null;
let elapsedSeconds   = 0;
let snapCount        = 0;
let recCount         = 0;
let animFrame        = null;
let participants     = {};
let activeSpeaker    = null;
let callStartTime    = null;

// Media
let tabRecorder  = null;
let micRecorder  = null;
let tabChunks    = [];
let micChunks    = [];
let tabStream    = null;
let micStream    = null;
let audioContext = null;

// WebSocket
let ws            = null;
let wsConnected   = false;
let wsChunkMs     = 250;

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
const toggleAutoStart = $('toggleAutoStart');
const participantsList    = $('participantsList');
const participantCountEl  = $('participantCount');
const currentSpeakerEl    = $('currentSpeaker');
const timelineList        = $('timelineList');
const bars                = document.querySelectorAll('#audioViz .bar');

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

function sendWsMeta(data) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !toggleMeta.checked) return;
  try { ws.send(JSON.stringify(data)); } catch (_) {}
}

function sendWsAudio(arrayBuffer) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(arrayBuffer); } catch (_) {}
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function setUI(recording) {
  isRecording = recording;
  btnStart.disabled = recording || !inCall;
  btnStop.disabled  = !recording;
  btnSnap.disabled  = !recording;
  timerDisplay.classList.toggle('recording', recording);
  bars.forEach(b => b.classList.toggle('active', recording));
  callPill.textContent  = recording ? '● Gravando' : (inCall ? 'Em chamada' : 'Fora de chamada');
  callPill.className    = 'status-pill' + (recording ? ' recording' : (inCall ? ' in-call' : ''));
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

// ── Screenshot ────────────────────────────────────────────────────────────────
function takeScreenshot(label = 'manual') {
  chrome.runtime.sendMessage({ action: 'takeScreenshot' }, (resp) => {
    if (resp?.success) {
      snapCount++;
      snapCountEl.textContent = snapCount;
      log(`Screenshot salvo (${label})`, 'success');
    } else {
      log('Screenshot falhou: ' + (resp?.error || 'unknown'), 'error');
    }
  });
}

function startAutoSnap() {
  const secs = parseInt(snapIntervalEl.value, 10) || 30;
  autoSnapInterval = setInterval(() => takeScreenshot(`auto @${formatTime(elapsedSeconds)}`), secs * 1000);
}
function stopAutoSnap() { clearInterval(autoSnapInterval); autoSnapInterval = null; }

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

  chrome.runtime.sendMessage({ action: 'getStreamId' }, async (resp) => {
    if (!resp?.success) {
      log('Falhou: ' + (resp?.error || 'unknown'), 'error');
      btnStart.disabled = false;
      return;
    }

    try {
      wsChunkMs = parseInt(wsChunkMsInput.value, 10) || 250;

      // Callback chamado a cada chunk — envia via WS em tempo real
      const onTabChunk = (data) => {
        if (!wsConnected) return;
        data.arrayBuffer().then(buf => sendWsAudio(buf));
      };

      // Tab stream
      tabStream = await navigator.mediaDevices.getUserMedia({
        video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: resp.streamId } },
        audio: captureAudio
          ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: resp.streamId } }
          : false
      });

      // Mic stream
      if (captureAudio) {
        try {
          micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          log('Microfone concedido ✓', 'success');
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

      } else {
        // ── MODO MIXADO (padrão) ──────────────────────────────────────────
        let streamToRecord = tabStream;

        if (captureAudio && micStream) {
          audioContext = new AudioContext();
          const dest    = audioContext.createMediaStreamDestination();
          const tabSrc  = audioContext.createMediaStreamSource(tabStream);
          const micSrc  = audioContext.createMediaStreamSource(micStream);
          const micGain = audioContext.createGain();
          micGain.gain.value = 1.2;
          tabSrc.connect(dest);
          micSrc.connect(micGain);
          micGain.connect(dest);
          const videoTrack = tabStream.getVideoTracks()[0];
          const mixedAudio = dest.stream.getAudioTracks()[0];
          streamToRecord = new MediaStream(videoTrack ? [videoTrack, mixedAudio] : [mixedAudio]);
          log('Misturando aba + mic ✓', 'success');
        }

        const mix = makeRecorder(streamToRecord, onTabChunk, wsChunkMs);
        tabRecorder = mix.recorder;
        tabRecorder.onstop = () => saveFile(mix.chunks, mix.mimeType, 'recording');
        tabRecorder.start(wsChunkMs);
      }

      addTimeline('Gravação iniciada', Object.values(participants).join(', ') || 'nenhum participante', 'red');

      if (toggleMeta.checked) {
        sendWsMeta({
          type: 'RECORDING_START',
          participants,
          activeSpeaker,
          separate,
          timestamp: Date.now()
        });
      }

      setUI(true);
      startTimer();
      animateBars();
      if (toggleAutoSnap.checked) startAutoSnap();

    } catch (err) {
      log('Erro de stream: ' + err.message, 'error');
      btnStart.disabled = false;
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

  tabStream?.getTracks().forEach(t => t.stop());
  micStream?.getTracks().forEach(t => t.stop());
  audioContext?.close();
  tabStream = micStream = audioContext = null;

  if (toggleMeta.checked) {
    sendWsMeta({ type: 'RECORDING_STOP', duration: elapsedSeconds, timestamp: Date.now() });
  }

  if (!toggleWS.checked) disconnectWS();

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
      callPill.textContent = 'Em chamada';
      callPill.className   = 'status-pill in-call';
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
      callPill.textContent = 'Fora de chamada';
      callPill.className   = 'status-pill';
      btnStart.disabled    = true;
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
      if (toggleMeta.checked && isRecording) {
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
          if (toggleMeta.checked && isRecording) {
            sendWsMeta({
              type: 'SPEAKER_CHANGE',
              speaker: msg.speaker,
              timestamp: msg.timestamp,
              elapsedSeconds
            });
          }
        }
      }
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
  captureAudio:  toggleAudio.checked,
  separate:      toggleSeparate.checked,
  autoSnap:      toggleAutoSnap.checked,
  snapInterval:  snapIntervalEl.value,
  wsEnabled:     toggleWS.checked,
  wsUrl:         wsUrlInput.value,
  wsMeta:        toggleMeta.checked,
  wsChunkMs:     wsChunkMsInput.value,
  saveLocal:     toggleSaveLocal.checked,
  autoStart:     toggleAutoStart.checked,
});

[toggleSeparate, toggleAutoSnap, toggleWS, toggleMeta,
 toggleSaveLocal, toggleAutoStart].forEach(el => el.addEventListener('change', saveSettings));
[snapIntervalEl, wsUrlInput, wsChunkMsInput].forEach(el => el.addEventListener('change', saveSettings));

// ── Restaurar configurações ───────────────────────────────────────────────────
chrome.storage.local.get([
  'captureAudio','separate','autoSnap','snapInterval',
  'wsEnabled','wsUrl','wsMeta','wsChunkMs','saveLocal','autoStart'
], (d) => {
  if (d.captureAudio  !== undefined) toggleAudio.checked      = d.captureAudio;
  if (d.separate      !== undefined) toggleSeparate.checked   = d.separate;
  if (d.autoSnap      !== undefined) toggleAutoSnap.checked   = d.autoSnap;
  if (d.snapInterval  !== undefined) snapIntervalEl.value     = d.snapInterval;
  if (d.wsEnabled     !== undefined) toggleWS.checked         = d.wsEnabled;
  if (d.wsUrl         !== undefined) wsUrlInput.value         = d.wsUrl;
  if (d.wsMeta        !== undefined) toggleMeta.checked       = d.wsMeta;
  if (d.wsChunkMs     !== undefined) wsChunkMsInput.value     = d.wsChunkMs;
  if (d.saveLocal     !== undefined) toggleSaveLocal.checked  = d.saveLocal;
  if (d.autoStart     !== undefined) toggleAutoStart.checked  = d.autoStart;
  updateSeparateVisibility();
});

// Busca estado atual da chamada ao abrir a janela
chrome.runtime.sendMessage({ action: 'getCallState' }, (resp) => {
  if (resp?.callState?.inCall) {
    inCall = true;
    callStartTime = resp.callState.startedAt;
    participants  = resp.callState.participants || {};
    activeSpeaker = resp.callState.activeSpeaker;
    callPill.textContent = 'Em chamada';
    callPill.className   = 'status-pill in-call';
    btnStart.disabled    = false;
    renderParticipants();
    log('Retomando chamada em andamento', 'success');
  }
});

// Init
updateSeparateVisibility();
