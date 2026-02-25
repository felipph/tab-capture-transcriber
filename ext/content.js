// ── Teams Capture – Content Script ───────────────────────────────────────────
// Roda dentro da aba do Teams. Responsável por:
//   1. Detectar início/fim de chamada
//   2. Extrair lista de participantes
//   3. Detectar locutor ativo (quem está falando)
//   4. Detectar compartilhamento de conteúdo (tela/apresentação)
//   5. Enviar todos os eventos para o background

(function () {
  'use strict';

  let inCall           = false;
  let participants     = new Map(); // id → name
  let activeSpeaker    = null;
  let contentSharing   = false;
  let contentShareUser = null;
  let observers        = [];

  // ── Seletores do DOM do Teams (múltiplos fallbacks por versão) ─────────────
  const SELECTORS = {
    // Indicadores de chamada ativa
    callActive: [
      '[data-tid="call-status"]',
      '[data-cid="calling-roster-section"]',
      '.ts-calling-screen',
      '[class*="callingScreen"]',
      '[data-tid="roster-participant"]',
      'div[role="region"][aria-label*="call" i]',
      'div[role="region"][aria-label*="chamada" i]',
      '[data-tid="hangup-button"]',
      '[data-tid="toggle-mute"]',
      'button[aria-label*="Leave" i]',
      'button[aria-label*="Sair" i]',
    ],
    // Participantes no painel lateral
    participantName: [
      '[data-tid="roster-participant"] [class*="displayName"]',
      '[data-tid="roster-participant"] [class*="userName"]',
      '[data-cid="calling-roster-participant"] span[title]',
      '[class*="participant-name"]',
      '[class*="participantDisplayName"]',
      '[class*="persona-name"]',
      '.fui-Persona__primaryText',
      '[data-tid="roster-participant-item"] span[title]',
    ],
    // Container do roster
    rosterContainer: [
      '[data-tid="call-roster"]',
      '[data-cid="calling-roster-section"]',
      '[aria-label*="Participants" i]',
      '[aria-label*="Participantes" i]',
    ],
    // Compartilhamento de conteúdo (tela/apresentação)
    contentSharing: [
      '[data-tid="content-sharing-screen"]',
      '[data-tid="shared-content"]',
      '[class*="sharingIndicator"]',
      '[class*="contentSharing"]',
      '[class*="screenSharing"]',
      '[class*="shared-screen"]',
      '[class*="presentingContent"]',
      '[aria-label*="presenting" i]',
      '[aria-label*="apresentando" i]',
      '[aria-label*="sharing" i]',
      '[aria-label*="compartilhando" i]',
      '[class*="stageLayout"]',
      '[data-tid="content-share-view"]',
      '[class*="ContentShareView"]',
    ],
    // Quem está apresentando
    contentSharePresenter: [
      '[class*="sharingIndicator"] [class*="displayName"]',
      '[class*="sharingIndicator"] span[title]',
      '[aria-label*="presenting" i]',
      '[aria-label*="apresentando" i]',
      '[class*="presenterName"]',
      '[data-tid="sharing-indicator"] span',
    ],
    // Locutor ativo — Teams marca visualmente quem está falando
    activeSpeaker: [
      // Novo Teams
      '[data-tid="roster-participant"][aria-label*="speaking" i]',
      '[data-tid="roster-participant"][aria-label*="falando" i]',
      // Indicador de áudio ativo nos tiles de vídeo
      '[class*="activeSpeaker"] [class*="displayName"]',
      '[class*="active-speaker"] [class*="name"]',
      '[class*="audioOn"] [class*="displayName"]',
      // Ring visual
      '[class*="speakerRing"] ~ * [class*="displayName"]',
      '[class*="speakingIndicator"]',
      // Container do tile com borda ativa
      '[class*="tile"][class*="active"] [class*="displayName"]',
      '[class*="VideoTile"][class*="active"] span[title]',
    ],
  };

  // ── Tenta vários seletores e retorna o primeiro que encontrar elementos ─────
  function queryAll(selectors) {
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) return Array.from(els);
      } catch (_) {}
    }
    return [];
  }

  function queryOne(selectors) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  // ── Envia mensagem para o background ──────────────────────────────────────
  function send(type, payload = {}) {
    try {
      chrome.runtime.sendMessage({ source: 'content', type, ...payload });
    } catch (_) {
      // Extension context pode ter sido invalidado (reload) — silencia
    }
  }

  // ── Detecta se está em chamada ────────────────────────────────────────────
  function detectCallState() {
    const inCallNow = !!queryOne(SELECTORS.callActive);

    if (inCallNow && !inCall) {
      inCall = true;
      send('CALL_STARTED', { url: location.href, timestamp: Date.now() });
      startObservers();
    } else if (!inCallNow && inCall) {
      inCall = false;
      send('CALL_ENDED', { timestamp: Date.now() });
      stopObservers();
      participants.clear();
      activeSpeaker = null;
      contentSharing = false;
      contentShareUser = null;
    }
  }

  // ── Extrai texto limpo de um elemento ─────────────────────────────────────
  function extractName(el) {
    return (el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || '')
      .trim()
      .replace(/\s+/g, ' ')
      // Remove sufixos como "(Guest)", "(Convidado)", "(You)", "(Você)"
      .replace(/\s*\(.*?\)\s*$/, '')
      .trim();
  }

  // ── Coleta participantes do DOM ───────────────────────────────────────────
  function collectParticipants() {
    const els = queryAll(SELECTORS.participantName);
    const seen = new Set();
    const updated = new Map();

    els.forEach(el => {
      const name = extractName(el);
      if (name && name.length > 1 && !seen.has(name)) {
        seen.add(name);
        const id = name.toLowerCase().replace(/\s+/g, '-');
        updated.set(id, name);
      }
    });

    // Só envia se houve mudança
    const prevKeys = JSON.stringify([...participants.keys()].sort());
    const nextKeys = JSON.stringify([...updated.keys()].sort());
    if (prevKeys !== nextKeys) {
      participants = updated;
      send('PARTICIPANTS_UPDATE', {
        participants: Object.fromEntries(updated),
        timestamp: Date.now()
      });
    }
  }

  // ── Detecta locutor ativo ─────────────────────────────────────────────────
  function detectActiveSpeaker() {
    const els = queryAll(SELECTORS.activeSpeaker);
    let speakerName = null;

    for (const el of els) {
      const name = extractName(el);
      if (name && name.length > 1) {
        speakerName = name;
        break;
      }
    }

    // Também tenta via atributo aria-label no container do participante
    if (!speakerName) {
      const rosterItems = document.querySelectorAll('[data-tid="roster-participant"]');
      for (const item of rosterItems) {
        const label = item.getAttribute('aria-label') || '';
        if (/speaking|falando|is muted.*speaking/i.test(label) === false &&
            /unmuted/i.test(label)) {
          // Pega o nome dentro do item
          const nameEl = item.querySelector('[class*="displayName"], [class*="userName"], span[title]');
          if (nameEl) {
            speakerName = extractName(nameEl);
            break;
          }
        }
      }
    }

    if (speakerName !== activeSpeaker) {
      activeSpeaker = speakerName;
      send('SPEAKER_CHANGE', {
        speaker: speakerName,
        timestamp: Date.now()
      });
    }
  }

  // ── Detecta compartilhamento de conteúdo ──────────────────────────────────
  function detectContentSharing() {
    const sharingNow = !!queryOne(SELECTORS.contentSharing);

    // Tenta extrair quem está apresentando
    let presenter = null;
    if (sharingNow) {
      const presenterEls = queryAll(SELECTORS.contentSharePresenter);
      for (const el of presenterEls) {
        const name = extractName(el);
        if (name && name.length > 1) {
          presenter = name;
          break;
        }
      }
    }

    if (sharingNow && !contentSharing) {
      contentSharing = true;
      contentShareUser = presenter;
      send('CONTENT_SHARING_START', {
        presenter: presenter,
        timestamp: Date.now()
      });
    } else if (!sharingNow && contentSharing) {
      contentSharing = false;
      contentShareUser = null;
      send('CONTENT_SHARING_STOP', {
        timestamp: Date.now()
      });
    } else if (sharingNow && presenter !== contentShareUser) {
      contentShareUser = presenter;
      send('CONTENT_SHARING_PRESENTER_CHANGE', {
        presenter: presenter,
        timestamp: Date.now()
      });
    }
  }

  // ── Observers ─────────────────────────────────────────────────────────────
  function startObservers() {
    stopObservers(); // evita duplicatas

    // Observer principal — monitora mutações no body inteiro
    const mainObserver = new MutationObserver(() => {
      collectParticipants();
      detectActiveSpeaker();
      detectContentSharing();
    });

    mainObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-label', 'class', 'data-tid', 'title']
    });

    observers.push(mainObserver);

    // Coleta inicial
    collectParticipants();
    detectActiveSpeaker();
    detectContentSharing();
  }

  function stopObservers() {
    observers.forEach(o => o.disconnect());
    observers = [];
  }

  // ── Monitora mudanças de URL (SPA navigation) ─────────────────────────────
  let lastUrl = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(detectCallState, 1500); // aguarda o DOM atualizar
    }
  });
  urlObserver.observe(document.body, { childList: true, subtree: true });

  // ── Polling de segurança (DOM do Teams é dinâmico demais) ─────────────────
  const callPoller = setInterval(detectCallState, 3000);

  // ── Responde a pedidos do background (ex: forçar refresh de participantes) ─
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'getCallInfo') {
      send('CALL_INFO', {
        inCall,
        participants: Object.fromEntries(participants),
        activeSpeaker,
        contentSharing,
        contentShareUser,
        timestamp: Date.now()
      });
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────────
  detectCallState();

  // Cleanup ao descarregar a página
  window.addEventListener('beforeunload', () => {
    clearInterval(callPoller);
    stopObservers();
    urlObserver.disconnect();
    if (inCall) send('CALL_ENDED', { timestamp: Date.now() });
  });

})();
