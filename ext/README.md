# Teams Capture – Chrome Extension

Record audio and take screenshots from MS Teams (browser version) with a single click.

---

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load Unpacked**
4. Select this folder (`teams-capture-extension/`)

---

## How to Use

1. Navigate to **Microsoft Teams** in your browser (`teams.microsoft.com`)
2. Click the extension icon in the toolbar
3. Hit **▶ Start** to begin capturing
4. Click **📷 Snap** anytime for an instant screenshot
5. Click **■ Stop** to end — the recording is saved automatically

All files are saved to your **Downloads/TeamsCapture/** folder:
- `recordings/` → `.webm` video+audio files
- `screenshots/` → `.png` screenshots

---

## Common Issues & Fixes

### "tabCapture returned null" or permission denied
- Make sure you're on the actual Teams tab (not a chrome:// page)
- Check that the extension has the `tabCapture` permission in `chrome://extensions/`
- Try clicking directly on the Teams tab first, then open the popup

### No audio in recording
- Enable the **Record Audio** toggle before starting
- Note: Chrome's `tabCapture` captures tab audio — make sure Teams audio is unmuted

### Screenshots are blank or black
- This happens on some hardware-accelerated pages. Try disabling GPU acceleration:
  `chrome://flags/#disable-accelerated-2d-canvas` → set to Disabled

### Extension works on web Teams only
- The MS Teams **desktop app** is not a browser tab — it can't be captured with `tabCapture`
- Use **MS Teams in Chrome** (`teams.microsoft.com`) for this extension to work

---

## File Structure

```
teams-capture-extension/
├── manifest.json      ← Extension config (Manifest V3)
├── background.js      ← Service worker: handles tabCapture + MediaRecorder
├── popup.html         ← Extension UI
├── popup.js           ← UI logic + messaging
├── content.js         ← Content script (lightweight)
└── icons/             ← Extension icons
```

---

## Technical Notes

- Uses **`chrome.tabCapture`** API to capture both video and audio from the active tab
- Uses **`MediaRecorder`** with `video/webm` codec for recordings
- Uses **`chrome.tabs.captureVisibleTab`** for screenshots (higher quality than canvas)
- All files are saved via **`chrome.downloads`** API — no server needed
- Settings (audio toggle, auto-snap interval) persist via `chrome.storage.local`
