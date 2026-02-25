document.getElementById('btnOpen').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'openRecorder' }, () => window.close());
});
