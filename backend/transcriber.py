"""
transcriber.py — Transcrição com Whisper + identificação de falantes

Fluxo:
  1. Converte audio.webm → audio.wav com ffmpeg
  2. Roda Whisper com word_timestamps=True para ter precisão em nível de palavra
  3. Para cada segmento, consulta o speaker_events da sessão para saber quem falava
  4. Agrupa segmentos consecutivos do mesmo speaker
  5. Gera transcript.json (estruturado) e transcript.txt (legível)
"""

import json
import subprocess
import sys
from pathlib import Path
from typing import Optional
from dataclasses import dataclass, field

try:
    from faster_whisper import WhisperModel
    WHISPER_AVAILABLE = True
except ImportError:
    WHISPER_AVAILABLE = False

try:
    from rich.console import Console
    from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn, TimeElapsedColumn
    from rich.table import Table
    from rich.panel import Panel
    from rich import print as rprint
    RICH_AVAILABLE = True
except ImportError:
    RICH_AVAILABLE = False

console = Console() if RICH_AVAILABLE else None

# Cache do modelo — carregado uma vez por processo e reutilizado
_model_cache: dict[str, "WhisperModel"] = {}


def _get_model(model_name: str) -> "WhisperModel":
    """Retorna modelo cacheado ou carrega na primeira chamada."""
    if model_name not in _model_cache:
        try:
            _model_cache[model_name] = WhisperModel(model_name, device="cuda")
        except Exception as e:
            print(f"[faster-whisper] CUDA indisponível ({e}), usando CPU...")
            _model_cache[model_name] = WhisperModel(model_name, device="cpu")
    return _model_cache[model_name]


@dataclass
class TranscriptSegment:
    speaker: Optional[str]
    start: float      # segundos desde o início da gravação
    end: float
    text: str
    words: list = field(default_factory=list)  # word-level timestamps se disponível


def convert_to_wav(webm_path: Path, wav_path: Path) -> bool:
    """Converte WebM/Opus → WAV 16kHz mono (formato ideal para Whisper)."""
    cmd = [
        "ffmpeg", "-y",
        "-i", str(webm_path),
        "-ar", "16000",   # 16kHz — requisito do Whisper
        "-ac", "1",       # mono
        "-f", "wav",
        str(wav_path)
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"[ffmpeg] Erro: {result.stderr[-500:]}")
        return False
    return True


def speaker_at(speaker_events: list, elapsed_seconds: float) -> Optional[str]:
    """
    Dado um tempo em segundos, retorna quem estava falando naquele momento.
    Usa os eventos SPEAKER_CHANGE registrados durante a sessão.
    """
    if not speaker_events:
        return None
    current = None
    for ev in speaker_events:
        if ev["elapsedSeconds"] <= elapsed_seconds:
            current = ev["speaker"]
        else:
            break
    return current


def merge_segments(segments: list[TranscriptSegment]) -> list[TranscriptSegment]:
    """
    Mescla segmentos consecutivos do mesmo speaker para evitar fragmentação
    excessiva. Agrupa segmentos do mesmo speaker se o gap for < 2 segundos.
    """
    if not segments:
        return []

    merged = [segments[0]]
    for seg in segments[1:]:
        prev = merged[-1]
        gap = seg.start - prev.end
        same_speaker = prev.speaker == seg.speaker

        if same_speaker and gap < 2.0:
            # Mescla no anterior
            merged[-1] = TranscriptSegment(
                speaker=prev.speaker,
                start=prev.start,
                end=seg.end,
                text=prev.text + " " + seg.text,
                words=prev.words + seg.words,
            )
        else:
            merged.append(seg)

    return merged


def format_time(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    if h > 0:
        return f"{h:02d}:{m:02d}:{s:05.2f}"
    return f"{m:02d}:{s:05.2f}"


def transcribe(session_dir: Path, model_name: str = "medium",
               language: str = "pt") -> dict:
    """
    Transcreve o áudio da sessão e gera os arquivos de saída.

    Parâmetros:
        session_dir : diretório da sessão (contém audio.webm e speaker_map.json)
        model_name  : modelo Whisper: tiny, base, small, medium, large
        language    : código ISO do idioma (None = auto-detect)

    Retorna o transcript como dict.
    """
    audio_webm    = session_dir / "audio.webm"
    audio_wav     = session_dir / "audio.wav"
    speaker_file  = session_dir / "speaker_map.json"
    out_json      = session_dir / "transcript.json"
    out_txt       = session_dir / "transcript.txt"
    out_srt       = session_dir / "transcript.srt"

    if not WHISPER_AVAILABLE:
        raise RuntimeError(
            "faster-whisper não instalado. Execute: pip install faster-whisper"
        )

    _print_step("Verificando arquivos...")
    if not audio_webm.exists():
        raise FileNotFoundError(f"Áudio não encontrado: {audio_webm}")

    # Carrega speaker events
    speaker_events = []
    participants   = {}
    if speaker_file.exists():
        data = json.loads(speaker_file.read_text(encoding="utf-8"))
        speaker_events = data.get("speaker_events", [])
        participants   = data.get("participants", {})
        # Garante ordenação cronológica
        speaker_events.sort(key=lambda e: e["elapsedSeconds"])

    # ── Conversão WebM → WAV ───────────────────────────────────────────────────
    _print_step(f"Convertendo {audio_webm.name} → WAV 16kHz mono...")
    if not convert_to_wav(audio_webm, audio_wav):
        raise RuntimeError("Falha na conversão com ffmpeg. Verifique se ffmpeg está instalado.")
    wav_size = audio_wav.stat().st_size / 1024 / 1024
    _print_ok(f"WAV gerado ({wav_size:.1f} MB)")

    # ── Carrega modelo faster-whisper (cacheado entre chamadas) ────────────────
    _print_step(f"Carregando modelo faster-whisper '{model_name}'...")
    model = _get_model(model_name)
    _print_ok("Modelo pronto")

    # ── Transcrição ────────────────────────────────────────────────────────────
    _print_step("Transcrevendo... (pode demorar alguns minutos)")
    try:
        segments_iter, info = model.transcribe(
            str(audio_wav),
            language=language or None,
            word_timestamps=True,
            vad_filter=True,
            beam_size=5,
            condition_on_previous_text=True,
        )
    except Exception as e:
        if "CUDA" in str(e) or "cuda" in str(e):
            _print_step("CUDA falhou, recarregando modelo em modo CPU...")
            # Recarrega modelo em CPU forçada
            model = WhisperModel(model_name, device="cpu")
            _model_cache[model_name] = model
            segments_iter, info = model.transcribe(
                str(audio_wav),
                language=language or None,
                word_timestamps=True,
                vad_filter=True,
                beam_size=5,
                condition_on_previous_text=True,
            )
        else:
            raise

    raw_segments = list(segments_iter)
    _print_ok(f"Transcrição concluída ({len(raw_segments)} segmentos)")

    # ── Alinha speakers com segmentos ─────────────────────────────────────────
    _print_step("Alinhando locutores com segmentos...")
    segments: list[TranscriptSegment] = []

    for seg in raw_segments:
        start = seg.start
        end   = seg.end
        text  = seg.text.strip()

        if not text:
            continue

        # Ponto médio do segmento para determinar speaker
        mid_point = (start + end) / 2
        sp = speaker_at(speaker_events, mid_point)

        # Extrai word-level timestamps se disponível
        words = []
        if seg.words:
            for w in seg.words:
                words.append({
                    "word":  w.word.strip(),
                    "start": round(w.start, 3),
                    "end":   round(w.end, 3),
                    "prob":  round(w.probability, 3),
                })

        segments.append(TranscriptSegment(
            speaker=sp,
            start=round(start, 3),
            end=round(end, 3),
            text=text,
            words=words,
        ))

    # Mescla segmentos consecutivos do mesmo speaker
    segments = merge_segments(segments)
    _print_ok(f"{len(segments)} segmentos após mesclagem")

    # ── Estatísticas por speaker ───────────────────────────────────────────────
    stats: dict[str, dict] = {}
    for seg in segments:
        sp = seg.speaker or "Desconhecido"
        if sp not in stats:
            stats[sp] = {"segments": 0, "words": 0, "duration": 0.0}
        stats[sp]["segments"] += 1
        stats[sp]["words"]    += len(seg.text.split())
        stats[sp]["duration"] += seg.end - seg.start

    # ── Monta resultado final ─────────────────────────────────────────────────
    transcript = {
        "session_id":    session_dir.name,
        "language":      info.language if info.language else language,
        "model":         model_name,
        "participants":  list(participants.values()),
        "total_duration": round(max((s.end for s in segments), default=0), 2),
        "speaker_stats": {
            sp: {
                "segments": v["segments"],
                "words":    v["words"],
                "duration_seconds": round(v["duration"], 1),
                "speaking_pct": round(
                    100 * v["duration"] /
                    max(sum(s["duration"] for s in stats.values()), 0.001), 1
                )
            }
            for sp, v in stats.items()
        },
        "segments": [
            {
                "speaker":  s.speaker,
                "start":    s.start,
                "end":      s.end,
                "duration": round(s.end - s.start, 3),
                "text":     s.text,
                "words":    s.words,
            }
            for s in segments
        ],
    }

    # ── Persiste JSON ─────────────────────────────────────────────────────────
    out_json.write_text(
        json.dumps(transcript, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # ── Persiste TXT legível ──────────────────────────────────────────────────
    lines = [
        f"═══ Transcrição — Sessão {session_dir.name} ═══",
        f"Idioma: {transcript['language']} | Modelo: {model_name}",
        f"Participantes: {', '.join(transcript['participants']) or 'Não detectados'}",
        f"Duração total: {format_time(transcript['total_duration'])}",
        "",
        "─── Participação ─────────────────────────────────────",
    ]
    for sp, v in transcript["speaker_stats"].items():
        lines.append(
            f"  {sp}: {v['words']} palavras · {format_time(v['duration_seconds'])} "
            f"({v['speaking_pct']}%)"
        )
    lines += ["", "─── Transcrição ──────────────────────────────────────", ""]

    prev_speaker = None
    for seg in segments:
        sp = seg.speaker or "Desconhecido"
        if sp != prev_speaker:
            if prev_speaker is not None:
                lines.append("")
            lines.append(f"[{format_time(seg.start)}]  {sp.upper()}")
            prev_speaker = sp
        lines.append(f"  {seg.text}")

    out_txt.write_text("\n".join(lines), encoding="utf-8")

    # ── Persiste SRT ──────────────────────────────────────────────────────────
    srt_lines = []
    for i, seg in enumerate(segments, 1):
        start_srt = _seconds_to_srt(seg.start)
        end_srt   = _seconds_to_srt(seg.end)
        sp = seg.speaker or "?"
        srt_lines += [
            str(i),
            f"{start_srt} --> {end_srt}",
            f"<{sp}> {seg.text}",
            "",
        ]
    out_srt.write_text("\n".join(srt_lines), encoding="utf-8")

    _print_ok(f"Arquivos gerados em {session_dir}/")
    _print_transcript_table(transcript)

    return transcript


def _seconds_to_srt(s: float) -> str:
    h  = int(s // 3600)
    m  = int((s % 3600) // 60)
    se = s % 60
    ms = int((se - int(se)) * 1000)
    return f"{h:02d}:{m:02d}:{int(se):02d},{ms:03d}"


def _print_step(msg: str):
    if RICH_AVAILABLE:
        console.print(f"  [cyan]→[/cyan] {msg}")
    else:
        print(f"  → {msg}")


def _print_ok(msg: str):
    if RICH_AVAILABLE:
        console.print(f"  [green]✓[/green] {msg}")
    else:
        print(f"  ✓ {msg}")


def _print_transcript_table(transcript: dict):
    if not RICH_AVAILABLE:
        return
    table = Table(title="Participação na chamada", border_style="dim")
    table.add_column("Participante",  style="bold white")
    table.add_column("Palavras",      justify="right")
    table.add_column("Tempo falando", justify="right")
    table.add_column("%",             justify="right", style="green")
    for sp, v in transcript["speaker_stats"].items():
        table.add_row(
            sp,
            str(v["words"]),
            format_time(v["duration_seconds"]),
            f"{v['speaking_pct']}%",
        )
    console.print(table)


def save_live_transcript(session_dir: Path, live_segments: list,
                         model_name: str = "large-v3-turbo",
                         language: str = "pt") -> dict:
    """
    Salva segmentos já transcritos em tempo real (do LiveTranscriber)
    nos formatos JSON, TXT e SRT — sem re-transcrever o áudio.

    live_segments: lista de LiveSegment (ou objetos com .text, .start, .end, .speaker, .words)
    """
    out_json = session_dir / "live_transcript.json"
    out_txt  = session_dir / "live_transcript.txt"
    out_srt  = session_dir / "live_transcript.srt"

    # Converte LiveSegment → TranscriptSegment
    segments = [
        TranscriptSegment(
            speaker=seg.speaker or "Desconhecido",
            start=round(seg.start, 3),
            end=round(seg.end, 3),
            text=seg.text,
            words=seg.words if seg.words else [],
        )
        for seg in live_segments if seg.text.strip()
    ]

    # Mescla segmentos consecutivos do mesmo speaker
    segments = merge_segments(segments)
    _print_ok(f"{len(segments)} segmentos após mesclagem (live)")

    # Speaker stats
    stats = {}
    for seg in segments:
        sp = seg.speaker or "Desconhecido"
        if sp not in stats:
            stats[sp] = {"segments": 0, "words": 0, "duration": 0.0}
        stats[sp]["segments"] += 1
        stats[sp]["words"]    += len(seg.text.split())
        stats[sp]["duration"] += seg.end - seg.start

    # Carrega participantes se disponível
    speaker_file = session_dir / "speaker_map.json"
    participants = {}
    if speaker_file.exists():
        data = json.loads(speaker_file.read_text(encoding="utf-8"))
        participants = data.get("participants", {})

    transcript = {
        "session_id":    session_dir.name,
        "language":      language,
        "model":         f"{model_name} (live)",
        "participants":  list(participants.values()),
        "total_duration": round(max((s.end for s in segments), default=0), 2),
        "speaker_stats": {
            sp: {
                "segments": v["segments"],
                "words":    v["words"],
                "duration_seconds": round(v["duration"], 1),
                "speaking_pct": round(
                    100 * v["duration"] /
                    max(sum(s["duration"] for s in stats.values()), 0.001), 1
                )
            }
            for sp, v in stats.items()
        },
        "segments": [
            {
                "speaker":  s.speaker,
                "start":    s.start,
                "end":      s.end,
                "duration": round(s.end - s.start, 3),
                "text":     s.text,
                "words":    s.words,
            }
            for s in segments
        ],
    }

    # Persiste JSON
    out_json.write_text(
        json.dumps(transcript, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # Persiste TXT
    lines = [
        f"═══ Transcrição (live) — Sessão {session_dir.name} ═══",
        f"Idioma: {language} | Modelo: {model_name}",
        f"Participantes: {', '.join(transcript['participants']) or 'Não detectados'}",
        f"Duração total: {format_time(transcript['total_duration'])}",
        "",
        "─── Participação ─────────────────────────────────────",
    ]
    for sp, v in transcript["speaker_stats"].items():
        lines.append(
            f"  {sp}: {v['words']} palavras · {format_time(v['duration_seconds'])} "
            f"({v['speaking_pct']}%)"
        )
    lines += ["", "─── Transcrição ──────────────────────────────────────", ""]
    prev_speaker = None
    for seg in segments:
        sp = seg.speaker or "Desconhecido"
        if sp != prev_speaker:
            if prev_speaker is not None:
                lines.append("")
            lines.append(f"[{format_time(seg.start)}]  {sp.upper()}")
            prev_speaker = sp
        lines.append(f"  {seg.text}")
    out_txt.write_text("\n".join(lines), encoding="utf-8")

    # Persiste SRT
    srt_lines = []
    for i, seg in enumerate(segments, 1):
        start_srt = _seconds_to_srt(seg.start)
        end_srt   = _seconds_to_srt(seg.end)
        sp = seg.speaker or "?"
        srt_lines += [str(i), f"{start_srt} --> {end_srt}", f"<{sp}> {seg.text}", ""]
    out_srt.write_text("\n".join(srt_lines), encoding="utf-8")

    _print_ok(f"Arquivos gerados em {session_dir}/ (live transcript)")
    _print_transcript_table(transcript)

    return transcript


# ── CLI stand-alone ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Transcreve uma sessão gravada")
    parser.add_argument("session_dir", help="Caminho para o diretório da sessão")
    parser.add_argument("--model",    default="medium",
                        choices=["tiny","base","small","medium","large","large-v2","large-v3","large-v3-turbo"])
    parser.add_argument("--language", default="pt",
                        help="Código do idioma (pt, en, es, ...) ou deixe vazio para auto-detect")
    args = parser.parse_args()

    transcribe(
        session_dir=Path(args.session_dir),
        model_name=args.model,
        language=args.language or None,
    )
