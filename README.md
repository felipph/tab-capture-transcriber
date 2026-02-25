# Captura de ligações do TEAMs


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



# Teams Capture Pro — Backend

Servidor WebSocket que recebe dados da extensão Chrome e gera:
- `audio.webm` — gravação completa da chamada
- `frames/` — capturas de conteúdo compartilhado (somente quando muda)
- `transcript.json` — transcrição estruturada com locutor por segmento
- `transcript.txt` — versão legível
- `transcript.srt` — legenda no formato SRT
- `timeline.json` — todos os eventos da sessão
- `speaker_map.json` — mapa chunkIndex → locutor

## Instalação

### 1. Pré-requisitos

```bash
# Python 3.10+
python --version

# ffmpeg (obrigatório para conversão de áudio)
# macOS
brew install ffmpeg
# Ubuntu/Debian
sudo apt install ffmpeg
# Windows: https://ffmpeg.org/download.html
```

### 2. Instalar dependências Python

```bash
pip install -r requirements.txt
```

> **GPU (opcional):** Se tiver NVIDIA GPU, instale PyTorch com CUDA para transcrição muito mais rápida:
> ```bash
> pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
> ```

## Uso

### Iniciar o servidor

```bash
python server.py
```

Por padrão roda em `ws://localhost:8765` com modelo `medium` em português.

### Opções

```
python server.py [opções]

  --host HOST        Endereço de escuta (padrão: localhost)
  --port PORT        Porta (padrão: 8765)
  --model MODEL      Modelo Whisper: tiny, base, small, medium, large,
                     large-v2, large-v3 (padrão: medium)
  --language LANG    Código ISO do idioma: pt, en, es, fr...
                     (padrão: pt | use '' para auto-detect)
  --no-transcribe    Não transcreve automaticamente ao fim da sessão
```

### Exemplos

```bash
# Servidor padrão (português, modelo medium)
python server.py

# Modelo maior para mais precisão
python server.py --model large-v3

# Chamada em inglês, acessível na rede local
python server.py --host 0.0.0.0 --language en

# Só grava sem transcrever (transcreve depois manualmente)
python server.py --no-transcribe
```

### Re-transcrever uma sessão

```bash
# Lista todas as sessões gravadas
python retranscribe.py --list

# Re-transcreve com modelo maior
python retranscribe.py output/session_20240225_143022 --model large-v3

# Muda idioma
python retranscribe.py output/session_20240225_143022 --language en
```

## Estrutura de saída

Cada sessão gera um diretório em `output/`:

```
output/
└── session_20240225_143022/
    ├── audio.webm              ← gravação bruta da chamada
    ├── audio.wav               ← convertido para Whisper
    ├── frames/
    │   ├── frame_0001_45s_Joao_Silva.png
    │   ├── frame_0002_87s_Maria.png
    │   └── ...
    ├── timeline.json           ← todos os eventos WS (cronológico)
    ├── speaker_map.json        ← chunkIndex → speaker + speaker_events
    ├── transcript.json         ← transcrição estruturada (veja abaixo)
    ├── transcript.txt          ← versão legível
    └── transcript.srt          ← legenda SRT
```

### Formato transcript.json

```json
{
  "session_id": "session_20240225_143022",
  "language": "pt",
  "model": "medium",
  "participants": ["João Silva", "Maria Oliveira", "Pedro Costa"],
  "total_duration": 1842.5,
  "speaker_stats": {
    "João Silva": {
      "segments": 24,
      "words": 412,
      "duration_seconds": 187.3,
      "speaking_pct": 35.2
    },
    "Maria Oliveira": { ... }
  },
  "segments": [
    {
      "speaker": "João Silva",
      "start": 12.4,
      "end": 18.7,
      "duration": 6.3,
      "text": "Bom dia a todos, vamos começar a reunião.",
      "words": [
        { "word": "Bom",    "start": 12.4, "end": 12.7, "prob": 0.99 },
        { "word": "dia",    "start": 12.7, "end": 12.9, "prob": 0.98 },
        ...
      ]
    },
    ...
  ]
}
```

### Formato transcript.txt

```
═══ Transcrição — Sessão session_20240225_143022 ═══
Idioma: pt | Modelo: medium
Participantes: João Silva, Maria Oliveira, Pedro Costa
Duração total: 30:42.50

─── Participação ─────────────────────────────────────
  João Silva:     412 palavras · 03:07 (35.2%)
  Maria Oliveira: 338 palavras · 02:31 (28.9%)
  Pedro Costa:    289 palavras · 02:08 (24.6%)

─── Transcrição ──────────────────────────────────────

[00:12.40]  JOÃO SILVA
  Bom dia a todos, vamos começar a reunião.
  O primeiro ponto da pauta é o relatório trimestral.

[01:45.20]  MARIA OLIVEIRA
  Obrigada João. Então, sobre os números do Q3...
```

## Protocolo WebSocket

Ver `BACKEND_EXAMPLE.md` na extensão para o protocolo completo de mensagens.

### Resumo do protocolo de chunk:

```
Texto  → { "type": "AUDIO_CHUNK_META", "chunkIndex": 42,
           "speaker": "Maria", "elapsedSeconds": 87, ... }
Binário → <WebM/Opus chunk>

Texto  → { "type": "CONTENT_FRAME", "speaker": "João",
           "elapsedSeconds": 120, "width": 1280, ... }
Binário → <PNG do slide/tela compartilhada>
```

## Modelos Whisper — guia de escolha

| Modelo     | Tamanho | VRAM  | Velocidade | Precisão |
|-----------|---------|-------|-----------|---------|
| `tiny`    | 39MB    | ~1GB  | ~32x      | Básica  |
| `base`    | 74MB    | ~1GB  | ~16x      | Razoável |
| `small`   | 244MB   | ~2GB  | ~6x       | Boa     |
| `medium`  | 769MB   | ~5GB  | ~2x       | **Recomendado** |
| `large-v3`| 1.5GB   | ~10GB | ~1x       | Máxima  |

> Velocidade "Nx" = processa N horas de áudio em 1 hora de CPU.
> Com GPU NVIDIA, todos os modelos são ~5-10x mais rápidos.
