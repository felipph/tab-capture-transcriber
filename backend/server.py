"""
server.py — Servidor WebSocket principal do Teams Capture Pro

Recebe do browser:
  Texto  → JSON com metadados (SESSION_START, AUDIO_CHUNK_META, SPEAKER_CHANGE,
                               CONTENT_FRAME, PARTICIPANTS_UPDATE, RECORDING_STOP)
  Binário → chunk de áudio (WebM/Opus) ou frame PNG de conteúdo compartilhado

Processa em tempo real:
  • Grava áudio continuamente em audio.webm
  • Salva frames PNG com nome incluindo speaker e timestamp
  • Constrói timeline e speaker_map em memória
  • Ao receber RECORDING_STOP, transcreve o áudio completo

Uso:
    python server.py [--host 0.0.0.0] [--port 8765]
                     [--model medium] [--language pt]
                     [--no-transcribe]
"""

import asyncio
import json
import argparse
import datetime
import signal
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Optional

import websockets
from websockets.server import WebSocketServerProtocol

from storage import Session, new_session_id, BASE_DIR
from transcriber import transcribe, WHISPER_AVAILABLE
from live_transcriber import LiveTranscriber, LiveSegment, FASTER_WHISPER_AVAILABLE

try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.live import Live
    from rich.table import Table
    from rich.text import Text
    from rich import print as rprint
    RICH = True
except ImportError:
    RICH = False

console = Console() if RICH else None


# ── Config (via CLI args) ─────────────────────────────────────────────────────
class Config:
    host:         str  = "localhost"
    port:         int  = 8765
    whisper_model: str = "large-v3-turbo"
    language:     str  = "pt"
    auto_transcribe: bool = True


cfg = Config()

# Sessões ativas: websocket → Session
active_sessions: dict[WebSocketServerProtocol, Session] = {}
# Transcrição em tempo real: websocket → LiveTranscriber
active_transcribers: dict[WebSocketServerProtocol, LiveTranscriber] = {}
# Pool de processo dedicado para transcrição (1 worker — evita contenção de GPU)
transcription_pool: ProcessPoolExecutor = None


# ── Logging ───────────────────────────────────────────────────────────────────
def ts() -> str:
    return datetime.datetime.now().strftime("%H:%M:%S")

def log(msg: str, style: str = ""):
    if RICH:
        prefix = f"[dim]{ts()}[/dim]"
        console.print(f"{prefix} {msg}")
    else:
        print(f"[{ts()}] {msg}")

def log_ok(msg: str):
    log(f"[green]✓[/green] {msg}" if RICH else f"✓ {msg}")

def log_warn(msg: str):
    log(f"[yellow]⚠[/yellow] {msg}" if RICH else f"⚠ {msg}")

def log_error(msg: str):
    log(f"[red]✗[/red] {msg}" if RICH else f"✗ {msg}")

def log_event(event: str, detail: str = ""):
    marker = {
        "AUDIO_CHUNK_META":    "[blue]♪[/blue]",
        "CONTENT_FRAME":       "[yellow]📸[/yellow]",
        "SPEAKER_CHANGE":      "[cyan]🎙[/cyan]",
        "PARTICIPANTS_UPDATE": "[magenta]👥[/magenta]",
        "SESSION_START":       "[green]▶[/green]",
        "RECORDING_START":     "[green]●[/green]",
        "RECORDING_STOP":      "[red]■[/red]",
    }.get(event, "  ")
    if RICH:
        console.print(f"  [dim]{ts()}[/dim] {marker} [bold]{event}[/bold]"
                      + (f"  [dim]{detail}[/dim]" if detail else ""))
    else:
        print(f"  [{ts()}] {event} {detail}")


# ════════════════════════════════════════════════════════════════════════════
# ── Handler por cliente ────────────────────────────────────────────────────
# ════════════════════════════════════════════════════════════════════════════

async def handle_client(websocket: WebSocketServerProtocol):
    session_id = new_session_id()
    session_name = None  # será definido quando receber RECORDING_START
    session    = Session.create(session_id, session_name)
    await session.open_audio()
    active_sessions[websocket] = session

    # Cria transcritor em tempo real se faster-whisper estiver disponível
    live_tr = None
    if FASTER_WHISPER_AVAILABLE and cfg.auto_transcribe:
        live_tr = LiveTranscriber(
            model_name=cfg.whisper_model,
            language=cfg.language,
            transcribe_interval=8.0,
        )
        active_transcribers[websocket] = live_tr

    client_addr = websocket.remote_address
    log(f"[bold]Nova conexão[/bold] de [cyan]{client_addr}[/cyan]  "
        f"→ sessão [bold yellow]{session_id}[/bold yellow]"
        + ("  [green](live transcription)[/green]" if live_tr else ""))

    try:
        async for message in websocket:

            # ── Mensagem de texto (JSON) ──────────────────────────────────
            if isinstance(message, str):
                await handle_json(session, websocket, message)

            # ── Mensagem binária (áudio ou PNG) ───────────────────────────
            elif isinstance(message, bytes):
                await handle_binary(session, websocket, message)

    except websockets.exceptions.ConnectionClosed as e:
        log_warn(f"Conexão encerrada abruptamente ({e.code})")
        # Salva o que tiver
        await finalize_session(session, websocket, auto_transcribe=False)

    finally:
        # Para transcritor em tempo real
        if live_tr:
            live_tr.stop()
            active_transcribers.pop(websocket, None)
        await session.close_audio()
        active_sessions.pop(websocket, None)
        log(f"[dim]Sessão {session_id} finalizada.[/dim]")


# ── Handler JSON ──────────────────────────────────────────────────────────────
async def handle_json(session: Session, websocket: WebSocketServerProtocol, raw: str):
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        log_warn("JSON inválido recebido — ignorando")
        return

    event_type = data.get("type", "UNKNOWN")
    session.add_timeline_event(data)

    # ── SESSION_START ─────────────────────────────────────────────────────
    if event_type == "SESSION_START":
        session.participants = data.get("participants", {})
        names = list(session.participants.values())
        log_event("SESSION_START", ", ".join(names) if names else "sem participantes")

    # ── RECORDING_START ───────────────────────────────────────────────────
    elif event_type == "RECORDING_START":
        session.participants = data.get("participants", session.participants)
        
        # Se temos o título da aba, recria a sessão com nome correto
        tab_title = data.get("tabTitle")
        if tab_title:
            from storage import sanitize_folder_name
            new_folder = f"{session.id}_{sanitize_folder_name(tab_title)}"
            old_dir = session.dir
            new_dir = BASE_DIR / new_folder
            
            if old_dir != new_dir and not new_dir.exists():
                old_dir.rename(new_dir)
                session.dir = new_dir
                session.audio_path = new_dir / "audio.webm"
                session.timeline_path = new_dir / "timeline.json"
                session.speaker_map_path = new_dir / "speaker_map.json"
                session.frames_dir = new_dir / "frames"
                log(f"Sessão renomeada para: {new_folder}")
        
        log_event("RECORDING_START",
                  f"separate={data.get('separate', False)}")

        # Inicia transcrição em tempo real
        live_tr = active_transcribers.get(websocket)
        if live_tr:
            loop = asyncio.get_event_loop()

            def on_live_segment(seg: LiveSegment):
                """Callback chamado pela thread de transcrição — agenda envio no event loop."""
                asyncio.run_coroutine_threadsafe(
                    _send_live_segment(websocket, seg, session),
                    loop,
                )

            live_tr.start(on_segment=on_live_segment)

    # ── AUDIO_CHUNK_META ──────────────────────────────────────────────────
    # O próximo binário recebido será o chunk de áudio correspondente.
    # Armazenamos o metadado como "pendente" para correlacionar no handle_binary.
    elif event_type == "AUDIO_CHUNK_META":
        idx     = data.get("chunkIndex", -1)
        speaker = data.get("speaker")
        elapsed = data.get("elapsedSeconds", 0)

        session.pending_meta = data
        session.record_chunk_speaker(idx, speaker, data.get("timestamp", 0), elapsed)

        # Log a cada 20 chunks para não poluir o terminal
        if idx % 20 == 0:
            log_event("AUDIO_CHUNK_META",
                      f"chunk #{idx} | speaker: {speaker or '?'} | {elapsed}s")

    # ── CONTENT_FRAME ─────────────────────────────────────────────────────
    # Próximo binário é um PNG de conteúdo compartilhado.
    elif event_type == "CONTENT_FRAME":
        session.pending_meta = data
        speaker = data.get("speaker")
        elapsed = data.get("elapsedSeconds", 0)
        size    = data.get("sizeBytes", 0)
        log_event("CONTENT_FRAME",
                  f"speaker: {speaker or '?'} | {elapsed}s | {size//1024}KB")

    # ── SPEAKER_CHANGE ────────────────────────────────────────────────────
    elif event_type == "SPEAKER_CHANGE":
        speaker = data.get("speaker")
        speaker_email = data.get("speakerEmail")
        elapsed = data.get("elapsedSeconds", 0)
        session.record_speaker_change(speaker, data.get("timestamp", 0), elapsed)
        email_str = f" ({speaker_email})" if speaker_email else ""
        log_event("SPEAKER_CHANGE", f"[bold]{speaker}[/bold]{email_str} @ {elapsed}s")

        # Atualiza speaker no transcritor em tempo real
        live_tr = active_transcribers.get(websocket)
        if live_tr:
            live_tr.update_speaker(speaker, elapsed)

    # ── PARTICIPANTS_UPDATE ───────────────────────────────────────────────
    elif event_type == "PARTICIPANTS_UPDATE":
        session.participants = data.get("participants", {})
        names = list(session.participants.values())
        log_event("PARTICIPANTS_UPDATE", ", ".join(names))

    # ── RECORDING_STOP ────────────────────────────────────────────────────
    elif event_type == "RECORDING_STOP":
        duration = data.get("duration", 0)
        log_event("RECORDING_STOP", f"duração: {duration}s")

        # Para transcrição em tempo real e salva os segmentos
        live_tr = active_transcribers.get(websocket)
        live_segments = []
        if live_tr:
            live_tr.stop()
            live_segments = live_tr.all_segments
            active_transcribers.pop(websocket, None)

        # Salva transcrição em tempo real se houver segmentos
        if live_segments:
            from transcriber import save_live_transcript
            save_live_transcript(
                session_dir=session.dir,
                live_segments=live_segments,
                model_name=cfg.whisper_model,
                language=cfg.language,
            )

        await session.close_audio()
        await finalize_session(session, websocket, auto_transcribe=cfg.auto_transcribe)


# ── Handler Binário ───────────────────────────────────────────────────────────
async def handle_binary(session: Session, websocket: WebSocketServerProtocol, data: bytes):
    meta = session.pending_meta
    session.pending_meta = None  # consume imediatamente

    if meta is None:
        # Binário sem metadado — trata como áudio (normal quando extensão envia chunks diretos)
        await session.write_audio(data)

        # Alimenta transcritor em tempo real mesmo sem metadado
        live_tr = active_transcribers.get(websocket)
        if live_tr:
            live_tr.feed_audio(data)
        return

    meta_type = meta.get("type", "")

    # ── Chunk de áudio ────────────────────────────────────────────────────
    if meta_type == "AUDIO_CHUNK_META":
        await session.write_audio(data)

        # Alimenta transcritor em tempo real
        live_tr = active_transcribers.get(websocket)
        if live_tr:
            elapsed = meta.get("elapsedSeconds", 0)
            speaker = meta.get("speaker")
            live_tr.feed_audio(data, elapsed, speaker)

    # ── Frame PNG de conteúdo compartilhado ───────────────────────────────
    elif meta_type == "CONTENT_FRAME":
        speaker = meta.get("speaker")
        elapsed = meta.get("elapsedSeconds", 0)
        path    = await session.save_frame(data, speaker, elapsed)
        log(f"  [dim]→[/dim] [yellow]Frame #{session.frame_count-1}[/yellow] "
            f"salvo: [dim]{Path(path).name}[/dim]")

    else:
        # Tipo desconhecido — salva como áudio por segurança
        await session.write_audio(data)


# ── Finalização da sessão ─────────────────────────────────────────────────────
async def _send_live_segment(websocket: WebSocketServerProtocol,
                              seg: LiveSegment, session: Session):
    """Envia um segmento de transcrição em tempo real de volta ao browser."""
    try:
        msg = json.dumps({
            "type": "LIVE_TRANSCRIPT",
            "text": seg.text,
            "start": seg.start,
            "end": seg.end,
            "speaker": seg.speaker,
            "words": seg.words,
            "timestamp": int(time.time() * 1000),
        })
        await websocket.send(msg)
    except Exception:
        pass  # conexão pode ter sido fechada


async def finalize_session(session: Session,
                           websocket: Optional[WebSocketServerProtocol] = None,
                           auto_transcribe: bool = True):
    """Persiste metadados e (opcionalmente) dispara transcrição final."""
    if session.audio_file:
        await session.close_audio()

    # Persiste timeline + speaker_map
    await session.save_metadata()
    summary = session.summary()

    if RICH:
        table = Table(title=f"Sessão {session.id}", border_style="dim")
        table.add_column("Campo")
        table.add_column("Valor", style="cyan")
        for k, v in summary.items():
            table.add_row(str(k), str(v))
        console.print(table)    
    else:
        print(json.dumps(summary, indent=2))

    if not auto_transcribe:
        return
    if summary["audio_size_mb"] == 0:
        log_warn("Nenhum áudio gravado — transcrição ignorada")
        return
    if not WHISPER_AVAILABLE:
        log_warn("Whisper não disponível. Instale com: pip install faster-whisper")
        return

    log(f"\n[bold]Iniciando transcrição em processo separado[/bold] "
        f"(modelo: [cyan]{cfg.whisper_model}[/cyan])…")
    loop = asyncio.get_event_loop()
    session_dir = session.dir

    fut = loop.run_in_executor(
        transcription_pool,
        _transcribe_sync,
        session_dir,
    )

    def _on_transcribe_done(f: asyncio.Future):
        exc = f.exception()
        if exc:
            log_error(f"Erro na transcrição ({session_dir.name}): {exc}")
        else:
            result = f.result()
            n_seg = len(result.get('segments', []))
            log_ok(f"Transcrição concluída ({session_dir.name}): {n_seg} segmentos")
            log_ok(f"Arquivos: {session_dir}/transcript.{{json,txt,srt}}")

    fut.add_done_callback(_on_transcribe_done)


def _transcribe_sync(session_dir: Path) -> dict:
    """Wrapper síncrono para chamar do executor."""
    # Limpa cache do modelo e força CPU para evitar conflitos de CUDA
    from transcriber import _model_cache
    _model_cache.clear()
    return transcribe(
        session_dir=session_dir,
        model_name=cfg.whisper_model,
        language=cfg.language or None,
    )


# ── Banner ────────────────────────────────────────────────────────────────────
def print_banner():
    if RICH:
        console.print(Panel.fit(
            "[bold cyan]Teams Capture Pro[/bold cyan] — Backend WebSocket\n"
            f"[dim]ws://{cfg.host}:{cfg.port}[/dim]  •  "
            f"Whisper: [bold]{cfg.whisper_model}[/bold]  •  "
            f"Idioma: [bold]{cfg.language}[/bold]  •  "
            f"Transcrição auto: [bold]{'sim' if cfg.auto_transcribe else 'não'}[/bold]",
            border_style="cyan",
        ))
    else:
        print("=" * 60)
        print(f"  Teams Capture Pro — Backend WebSocket")
        print(f"  ws://{cfg.host}:{cfg.port}")
        print(f"  Whisper: {cfg.whisper_model} | Idioma: {cfg.language}")
        print("=" * 60)


# ── Main ──────────────────────────────────────────────────────────────────────
async def main():
    global transcription_pool
    transcription_pool = ProcessPoolExecutor(max_workers=1)

    print_banner()

    async with websockets.serve(
        handle_client,
        cfg.host,
        cfg.port,
        # Aumenta limites para suportar frames PNG grandes
        max_size=50 * 1024 * 1024,   # 50MB por mensagem
        ping_interval=30,
        ping_timeout=60,
    ):
        log_ok(f"Servidor rodando em [bold]ws://{cfg.host}:{cfg.port}[/bold]")
        log("[dim]Pressione Ctrl+C para encerrar[/dim]")

        # Mantém rodando até SIGINT
        stop = asyncio.Future()
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop.set_result, None)
            except NotImplementedError:
                pass  # Windows
        await stop

    # Finaliza sessões ainda ativas
    if active_sessions:
        log_warn(f"{len(active_sessions)} sessão(ões) ativa(s) — salvando...")
        for ws, session in list(active_sessions.items()):
            await finalize_session(session, auto_transcribe=False)

    # Encerra pool de transcrição
    if transcription_pool:
        transcription_pool.shutdown(wait=True)

    log_ok("Servidor encerrado.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Teams Capture Pro — Backend WebSocket"
    )
    parser.add_argument("--host",     default="localhost",
                        help="Endereço de escuta (padrão: localhost)")
    parser.add_argument("--port",     default=8765, type=int,
                        help="Porta (padrão: 8765)")
    parser.add_argument("--model",    default="large-v3-turbo",
                        choices=["tiny","base","small","medium","large","large-v2","large-v3","large-v3-turbo"],
                        help="Modelo Whisper (padrão: large-v3-turbo)")
    parser.add_argument("--language", default="pt",
                        help="Idioma (padrão: pt). Use '' para auto-detect")
    parser.add_argument("--no-transcribe", action="store_true",
                        help="Não transcreve automaticamente ao fim da sessão")

    args = parser.parse_args()
    cfg.host             = args.host
    cfg.port             = args.port
    cfg.whisper_model    = args.model
    cfg.language         = args.language
    cfg.auto_transcribe  = not args.no_transcribe

    asyncio.run(main())
