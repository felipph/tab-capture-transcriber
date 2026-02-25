# Exemplo de Backend WebSocket (Python)

O recorder envia dois tipos de mensagem pelo WebSocket:

**1. Áudio binário** — chunks de `ArrayBuffer` com áudio WebM/Opus em tempo real
**2. Metadados JSON** — eventos da chamada como texto

## Protocolo

```
→ JSON  { type: "SESSION_START",    participants, activeSpeaker, timestamp }
→ BIN   [ArrayBuffer: audio chunk]
→ JSON  { type: "SPEAKER_CHANGE",   speaker, timestamp, elapsedSeconds }
→ JSON  { type: "PARTICIPANTS_UPDATE", participants, timestamp }
→ BIN   [ArrayBuffer: audio chunk]
→ ...
→ JSON  { type: "RECORDING_STOP",   duration, timestamp }
```

## Servidor de exemplo (Python)

```python
# pip install websockets
import asyncio, websockets, json, datetime, os

OUTPUT_DIR = "recordings"
os.makedirs(OUTPUT_DIR, exist_ok=True)

async def handler(websocket):
    session_id = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    audio_file = open(f"{OUTPUT_DIR}/audio_{session_id}.webm", "wb")
    timeline   = []
    
    print(f"[{session_id}] Cliente conectado")

    try:
        async for message in websocket:
            if isinstance(message, bytes):
                # Chunk de áudio — escreve diretamente no arquivo
                audio_file.write(message)

            elif isinstance(message, str):
                # Metadado JSON
                data = json.loads(message)
                event_type = data.get("type")
                timestamp  = data.get("timestamp", 0)
                
                timeline.append(data)
                print(f"  [{event_type}] {data}")

                if event_type == "SPEAKER_CHANGE":
                    speaker  = data.get("speaker")
                    elapsed  = data.get("elapsedSeconds", 0)
                    h, m, s  = elapsed//3600, (elapsed%3600)//60, elapsed%60
                    print(f"  🎙 Falando: {speaker} @ {h:02d}:{m:02d}:{s:02d}")

                elif event_type == "PARTICIPANTS_UPDATE":
                    names = list(data.get("participants", {}).values())
                    print(f"  👥 Participantes: {', '.join(names)}")

                elif event_type == "RECORDING_STOP":
                    # Salva timeline em JSON
                    with open(f"{OUTPUT_DIR}/timeline_{session_id}.json", "w") as f:
                        json.dump(timeline, f, indent=2, ensure_ascii=False)
                    print(f"  ✓ Timeline salva")

    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        audio_file.close()
        print(f"[{session_id}] Conexão encerrada. Arquivo: audio_{session_id}.webm")

async def main():
    print("Servidor WebSocket rodando em ws://localhost:8765")
    async with websockets.serve(handler, "localhost", 8765):
        await asyncio.Future()  # roda para sempre

asyncio.run(main())
```

## Rodar

```bash
pip install websockets
python server.py
```

Depois configure a URL `ws://localhost:8765` na aba **Config** do recorder e ative **Enviar áudio para backend**.

## Resultado

Cada sessão gera dois arquivos em `recordings/`:
- `audio_20240225_143022.webm` — áudio completo da chamada
- `timeline_20240225_143022.json` — eventos com timestamps (participantes, quem falou, quando)

O arquivo `.webm` pode ser transcrito com Whisper:
```bash
pip install openai-whisper
whisper audio_20240225_143022.webm --language Portuguese
```
