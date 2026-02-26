// ── Teams Capture – Content Script ───────────────────────────────────────────
// Roda dentro da aba do Teams. Responsável por:
//   1. Detectar início/fim de chamada
//   2. Extrair lista de participantes
//   3. Detectar locutor ativo (quem está falando)
//   4. Detectar compartilhamento de conteúdo (tela/apresentação)
//   5. Enviar todos os eventos para o background

(function () {
  'use strict';

  console.log('[TeamsCap] Content script loaded on', location.href);

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
      '[data-cid="calling-participant-stream"]',
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
      '[data-cid="calling-participant-stream"][data-stream-type="ScreenSharing"]',
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
      '[data-cid="calling-participant-stream"][data-stream-type="ScreenSharing"]',
      '[class*="sharingIndicator"] [class*="displayName"]',
      '[class*="sharingIndicator"] span[title]',
      '[aria-label*="presenting" i]',
      '[aria-label*="apresentando" i]',
      '[class*="presenterName"]',
      '[data-tid="sharing-indicator"] span',
    ],
    // Locutor ativo — Teams marca visualmente quem está falando
    activeSpeaker: [
      // Atributo estável data-is-speaking nos tiles de vídeo
      '[data-cid="calling-participant-stream"][data-is-speaking="true"]',
      // Fallbacks: seletores do roster
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

  // ── Extrai nome de pessoa do aria-label de um tile de vídeo ────────────────
  // Exemplos:
  //   "Yargo Gagliardi, O vídeo está passando, ..." → "Yargo Gagliardi"
  //   "Conteúdo compartilhado por Yargo Gagliardi" → "Yargo Gagliardi"
  //   "Vídeo de mim mesmo, Luiz Felipph, ..." → null (ignora self)
  function parseNameFromTileLabel(label) {
    if (!label) return null;
    // Ignora tile de "mim mesmo" / "myself"
    if (/mim mesmo|myself/i.test(label)) return null;
    // "Conteúdo compartilhado por <Name>" / "Content shared by <Name>"
    const shareMatch = label.match(/(?:compartilhado por|shared by)\s+(.+)/i);
    if (shareMatch) return shareMatch[1].split(',')[0].trim();
    // Nome é a primeira parte antes da primeira vírgula
    const name = label.split(',')[0].trim();
    return name.length > 1 ? name : null;
  }

  // ── Coleta participantes do DOM ───────────────────────────────────────
  function collectParticipants() {
    const seen = new Set();
    const updated = new Map();

    // 1) Método primário: tiles de vídeo (não depende do roster aberto)
    const tiles = document.querySelectorAll('[data-cid="calling-participant-stream"]');
    tiles.forEach(tile => {
      const streamType = tile.getAttribute('data-stream-type') || '';
      if (streamType === 'ScreenSharing') return;
      const label = tile.getAttribute('aria-label') || '';
      const name = parseNameFromTileLabel(label);
      if (name && !seen.has(name)) {
        seen.add(name);
        // Usa e-mail como id quando disponível, senão slug do nome
        const tid = tile.getAttribute('data-tid') || '';
        const id = tid.includes('@') ? tid : name.toLowerCase().replace(/\s+/g, '-');
        updated.set(id, name);
      }
    });

    // 2) Fallback: roster panel
    const els = queryAll(SELECTORS.participantName);
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

  // ── Detecta locutor ativo ─────────────────────────────────────────────
  function detectActiveSpeaker() {
    let speakerName = null;
    let speakerEmail = null;

    // 1) Método primário: atributo data-is-speaking em qualquer descendente do tile
    // O Teams põe data-is-speaking="true" no elemento voice-level-stream-outline, não no tile principal
    const speakingTile = document.querySelector(
      '[data-cid="calling-participant-stream"]:has([data-is-speaking="true"])'
    );
    if (speakingTile) {
      const label = speakingTile.getAttribute('aria-label') || '';
      speakerName = parseNameFromTileLabel(label);
      // data-tid contém o e-mail do participante
      const tid = speakingTile.getAttribute('data-tid') || '';
      if (tid.includes('@')) speakerEmail = tid;
    }

    // 1b) Fallback: verifica diretamente o elemento voice-level-stream-outline
    if (!speakerName) {
      const speakingIndicator = document.querySelector('[data-is-speaking="true"]');
      if (speakingIndicator) {
        const tile = speakingIndicator.closest('[data-cid="calling-participant-stream"]');
        if (tile) {
          const label = tile.getAttribute('aria-label') || '';
          speakerName = parseNameFromTileLabel(label);
          const tid = tile.getAttribute('data-tid') || '';
          if (tid.includes('@')) speakerEmail = tid;
        }
      }
    }

    // 2) Método visual: tiles com borda/ring de speaker ativo (CSS-based)
    if (!speakerName) {
      // Procura por tiles que têm classes indicando speaker ativo
      const allTiles = document.querySelectorAll('[data-cid="calling-participant-stream"]');
      for (const tile of allTiles) {
        // Verifica se o tile tem indicadores visuais de "falando"
        const style = window.getComputedStyle(tile);
        const hasSpeakingBorder = style.borderColor && style.borderColor !== 'rgba(0, 0, 0, 0)' && style.borderWidth !== '0px';
        const hasSpeakingRing = tile.querySelector('[class*="ring"], [class*="border"], [class*="active"]');
        const aria = tile.getAttribute('aria-label') || '';
        const isSpeaking = /falando|speaking|audio.*on|unmuted/i.test(aria);
        
        if (hasSpeakingBorder || hasSpeakingRing || isSpeaking) {
          const label = tile.getAttribute('aria-label') || '';
          const name = parseNameFromTileLabel(label);
          if (name) {
            speakerName = name;
            const tid = tile.getAttribute('data-tid') || '';
            if (tid.includes('@')) speakerEmail = tid;
            break;
          }
        }
      }
    }

    // 3) Método: procura por ícones/animações de "falando" dentro dos tiles
    if (!speakerName) {
      const speakingIcons = document.querySelectorAll(
        '[class*="speaking"], [class*="audio-on"], [class*="unmuted"], [data-tid*="speaking"]'
      );
      for (const icon of speakingIcons) {
        // Sobe na árvore até encontrar o tile pai
        let tile = icon.closest('[data-cid="calling-participant-stream"]');
        if (!tile) tile = icon.closest('[class*="tile"], [class*="video"]');
        if (tile) {
          const label = tile.getAttribute('aria-label') || '';
          const name = parseNameFromTileLabel(label);
          if (name) {
            speakerName = name;
            break;
          }
        }
      }
    }

    // 4) Fallback: seletores do roster / CSS classes (legado)
    if (!speakerName) {
      const els = queryAll(SELECTORS.activeSpeaker);
      for (const el of els) {
        // Se for o mesmo tile que já tentamos, pula
        if (el === speakingTile) continue;
        const name = extractName(el);
        if (name && name.length > 1) {
          speakerName = name;
          break;
        }
      }
    }

    // 5) Fallback: roster com aria-label "unmuted" ou "speaking"
    if (!speakerName) {
      const rosterItems = document.querySelectorAll('[data-tid="roster-participant"]');
      for (const item of rosterItems) {
        const label = item.getAttribute('aria-label') || '';
        if (/speaking|falando|unmuted|mic.*on/i.test(label)) {
          const nameEl = item.querySelector('[class*="displayName"], [class*="userName"], span[title]');
          if (nameEl) {
            speakerName = extractName(nameEl);
            break;
          }
        }
      }
    }

    if (speakerName !== activeSpeaker) {
      console.debug('[TeamsCap] Speaker:', speakerName, speakerEmail ? `(${speakerEmail})` : '');
      activeSpeaker = speakerName;
      send('SPEAKER_CHANGE', {
        speaker: speakerName,
        speakerEmail: speakerEmail,
        timestamp: Date.now()
      });
    }
  }

  // ── Detecta compartilhamento de conteúdo ──────────────────────────────────
  function detectContentSharing() {
    // 1) Método primário: tile com data-stream-type="ScreenSharing"
    const screenTile = document.querySelector(
      '[data-cid="calling-participant-stream"][data-stream-type="ScreenSharing"]'
    );
    const sharingNow = !!screenTile || !!queryOne(SELECTORS.contentSharing);

    // Tenta extrair quem está apresentando
    let presenter = null;
    if (sharingNow) {
      // Tenta do tile de screen sharing (aria-label: "Conteúdo compartilhado por X")
      if (screenTile) {
        const label = screenTile.getAttribute('aria-label') || '';
        presenter = parseNameFromTileLabel(label);
      }
      // Fallback: seletores legados
      if (!presenter) {
        const presenterEls = queryAll(SELECTORS.contentSharePresenter);
        for (const el of presenterEls) {
          if (el === screenTile) continue;
          const name = extractName(el);
          if (name && name.length > 1) {
            presenter = name;
            break;
          }
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
  let speakerPoller = null;   // polling rápido (500ms) para speaker
  let slowPoller = null;      // polling lento (2s) para participantes e conteúdo

  function startObservers() {
    stopObservers(); // evita duplicatas

    // Observer principal — monitora mutações no body inteiro
    const mainObserver = new MutationObserver(() => {
      detectActiveSpeaker();
    });

    mainObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-is-speaking', 'aria-label']
    });

    observers.push(mainObserver);

    // Observer secundário — detecta mudanças estruturais (participantes entrando/saindo)
    const rosterObserver = new MutationObserver(() => {
      collectParticipants();
      detectContentSharing();
    });

    rosterObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'data-tid', 'title', 'data-stream-type']
    });

    observers.push(rosterObserver);

    // Polling rápido — detecção de speaker é time-critical
    speakerPoller = setInterval(detectActiveSpeaker, 500);

    // Polling lento — participantes e conteúdo mudam com menos frequência
    slowPoller = setInterval(() => {
      collectParticipants();
      detectContentSharing();
    }, 2000);

    // Coleta inicial (com delay para tiles renderizarem)
    collectParticipants();
    detectActiveSpeaker();
    detectContentSharing();
    setTimeout(() => {
      collectParticipants();
      detectActiveSpeaker();
      detectContentSharing();
    }, 2000);
  }

  function stopObservers() {
    observers.forEach(o => o.disconnect());
    observers = [];
    if (speakerPoller) { clearInterval(speakerPoller); speakerPoller = null; }
    if (slowPoller) { clearInterval(slowPoller); slowPoller = null; }
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
