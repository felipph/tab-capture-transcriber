let selectedTabId = null;
let tabs = [];

// DOM refs
const tabList = document.getElementById('tabList');
const btnOpen = document.getElementById('btnOpen');
const selectedSection = document.getElementById('selectedSection');
const selectedInfo = document.getElementById('selectedInfo');
const teamsInfo = document.getElementById('teamsInfo');

// Carrega lista de abas
function loadTabs() {
  chrome.runtime.sendMessage({ action: 'listTabs' }, (resp) => {
    if (!resp?.success) {
      tabList.innerHTML = `<div class="no-tabs">Erro: ${resp?.error || 'desconhecido'}</div>`;
      return;
    }

    tabs = resp.tabs;

    if (tabs.length === 0) {
      tabList.innerHTML = '<div class="no-tabs">Nenhuma aba disponível para gravação.</div>';
      return;
    }

    // Ordena: Teams primeiro, depois por título
    tabs.sort((a, b) => {
      if (a.isTeams && !b.isTeams) return -1;
      if (!a.isTeams && b.isTeams) return 1;
      return (a.title || '').localeCompare(b.title || '');
    });

    renderTabs();
  });
}

// Renderiza lista de abas
function renderTabs() {
  tabList.innerHTML = '';

  tabs.forEach(tab => {
    const item = document.createElement('div');
    item.className = 'tab-item' + (tab.id === selectedTabId ? ' selected' : '');
    item.dataset.tabId = tab.id;

    // Cria favicon sem inline handler
    const faviconEl = tab.favIconUrl
      ? Object.assign(document.createElement('img'), { src: tab.favIconUrl, className: 'tab-favicon' })
      : document.createElement('div');
    faviconEl.className = 'tab-favicon';
    faviconEl.addEventListener('error', () => faviconEl.style.display = 'none');

    const badge = tab.isTeams ? '<span class="tab-badge">Teams</span>' : '';

    // Limita o tamanho da URL para exibição
    const displayUrl = tab.url ? new URL(tab.url).hostname : '';

    item.innerHTML = `
      <div class="tab-favicon-wrapper"></div>
      <div class="tab-info">
        <div class="tab-title">${escapeHtml(tab.title || 'Sem título')}</div>
        <div class="tab-url">${escapeHtml(displayUrl)}</div>
      </div>
      ${badge}
    `;

    item.querySelector('.tab-favicon-wrapper').appendChild(faviconEl);
    item.addEventListener('click', () => selectTab(tab));
    tabList.appendChild(item);
  });
}

// Seleciona uma aba
function selectTab(tab) {
  selectedTabId = tab.id;

  // Atualiza visual da lista
  document.querySelectorAll('.tab-item').forEach(el => {
    el.classList.toggle('selected', parseInt(el.dataset.tabId) === tab.id);
  });

  // Mostra seção de selecionado
  selectedSection.style.display = 'block';

  // Cria favicon sem inline handler
  const faviconEl = tab.favIconUrl
    ? Object.assign(document.createElement('img'), { src: tab.favIconUrl, className: 'tab-favicon' })
    : document.createElement('div');
  faviconEl.className = 'tab-favicon';
  faviconEl.addEventListener('error', () => faviconEl.style.display = 'none');

  selectedInfo.innerHTML = `
    <div class="tab-favicon-wrapper"></div>
    <div class="tab-info">
      <div class="tab-title">${escapeHtml(tab.title || 'Sem título')}</div>
      <div class="tab-url">${escapeHtml(tab.url || '')}</div>
    </div>
  `;

  selectedInfo.querySelector('.tab-favicon-wrapper').appendChild(faviconEl);

  // Mostra info do Teams se aplicável
  teamsInfo.style.display = tab.isTeams ? 'block' : 'none';

  // Habilita botão
  btnOpen.disabled = false;

  // Salva seleção no background
  chrome.runtime.sendMessage({ action: 'selectTab', tabId: tab.id });
}

// Escapa HTML
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Abre o recorder
btnOpen.addEventListener('click', () => {
  if (selectedTabId) {
    chrome.runtime.sendMessage({ action: 'selectTab', tabId: selectedTabId });
  }
  chrome.runtime.sendMessage({ action: 'openRecorder' }, () => window.close());
});

// Restaura seleção anterior
chrome.runtime.sendMessage({ action: 'getCallState' }, (resp) => {
  if (resp?.selectedTabId) {
    selectedTabId = resp.selectedTabId;
  }
  loadTabs();
});
