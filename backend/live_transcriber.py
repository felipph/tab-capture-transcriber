"""
live_transcriber.py — Transcrição em tempo real com faster-whisper

Acumula chunks de áudio WebM/Opus, converte periodicamente para WAV e
transcreve com faster-whisper. Envia segmentos transcritos de volta via callback.

Fluxo:
  1. Chunks de áudio WebM chegam do WebSocket
  2. A cada N segundos de áudio acumulado, converte o buffer para WAV
  3. Transcreve o trecho com faster-whisper
  4. Chama callback com os segmentos novos (para enviar de volta ao browser)
"""

import io
import json
import tempfile
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional, Callable
from dataclasses import dataclass, field

try:
    from faster_whisper import WhisperModel
    FASTER_WHISPER_AVAILABLE = True
except ImportError:
    FASTER_WHISPER_AVAILABLE = False

try:
    from rich.console import Console
    console = Console()
    RICH = True
except ImportError:
    RICH = False
    console = None


@dataclass
class LiveSegment:
    """Um segmento de transcrição em tempo real."""
    text: str
    start: float          # segundos absolutos desde início da gravação
    end: float
    speaker: Optional[str] = None
    words: list = field(default_factory=list)


class LiveTranscriber:
    """
    Transcritor em tempo real que acumula áudio e transcreve periodicamente.

    Uso:
        lt = LiveTranscriber(model_name="large-v3-turbo", language="pt")
        lt.start(on_segment=callback)
        lt.feed_audio(chunk_bytes, elapsed_seconds, speaker)
        ...
        lt.stop()
    """

    def __init__(
        self,
        model_name: str = "large-v3-turbo",
        language: str = "pt",
        transcribe_interval: float = 8.0,
        compute_type: str = "auto",
    ):
        self.model_name = model_name
        self.language = language
        self.transcribe_interval = transcribe_interval
        self.compute_type = compute_type

        self._model: Optional["WhisperModel"] = None
        self._audio_buffer = bytearray()       # WebM completo acumulado (nunca limpa)
        self._buffer_lock = threading.Lock()
        self._last_buffer_size = 0             # tamanho do buffer na última transcrição
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._on_segment: Optional[Callable] = None

        # Controle de offset temporal
        self._total_transcribed_seconds = 0.0
        self._last_transcribe_time = 0.0
        self._current_speaker: Optional[str] = None
        self._speaker_events: list = []

        # Acumula todos os segmentos para a transcrição final
        self.all_segments: list[LiveSegment] = []

    def _load_model(self):
        """Carrega o modelo faster-whisper (lazy loading)."""
        if self._model is not None:
            return

        if not FASTER_WHISPER_AVAILABLE:
            raise RuntimeError(
                "faster-whisper não instalado. Execute: pip install faster-whisper"
            )

        _log(f"Carregando modelo faster-whisper '{self.model_name}'...")
        self._model = WhisperModel(
            self.model_name,
            compute_type=self.compute_type,
        )
        _log_ok(f"Modelo '{self.model_name}' carregado")

    def start(self, on_segment: Callable[[LiveSegment], None]):
        """Inicia a transcrição em tempo real em background thread."""
        self._load_model()
        self._on_segment = on_segment
        self._running = True
        self._audio_buffer = bytearray()
        self._last_buffer_size = 0
        self._total_transcribed_seconds = 0.0
        self._last_transcribe_time = time.time()
        self._speaker_events = []
        self.all_segments = []

        self._thread = threading.Thread(
            target=self._transcribe_loop,
            daemon=True,
            name="live-transcriber"
        )
        self._thread.start()
        _log("Transcrição em tempo real iniciada")

    def stop(self):
        """Para a transcrição e processa qualquer áudio restante."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=30)
            self._thread = None

        # Transcreve o restante do buffer
        self._do_transcribe()
        _log("Transcrição em tempo real finalizada")

    def feed_audio(self, data: bytes, elapsed_seconds: float = 0,
                   speaker: Optional[str] = None):
        """Alimenta um chunk de áudio WebM/Opus."""
        with self._buffer_lock:
            self._audio_buffer.extend(data)

        if speaker and speaker != self._current_speaker:
            self._current_speaker = speaker
            self._speaker_events.append({
                "speaker": speaker,
                "elapsedSeconds": elapsed_seconds,
            })

    def update_speaker(self, speaker: Optional[str], elapsed_seconds: float):
        """Atualiza o speaker atual (chamado em SPEAKER_CHANGE)."""
        if speaker != self._current_speaker:
            self._current_speaker = speaker
            self._speaker_events.append({
                "speaker": speaker,
                "elapsedSeconds": elapsed_seconds,
            })

    def _transcribe_loop(self):
        """Loop de transcrição em background."""
        while self._running:
            now = time.time()
            elapsed = now - self._last_transcribe_time

            if elapsed >= self.transcribe_interval:
                self._do_transcribe()
                self._last_transcribe_time = time.time()

            time.sleep(0.5)

    def _do_transcribe(self):
        """Transcreve o áudio acumulado no buffer.

        Estratégia: mantém o WebM completo (nunca limpa), converte tudo
        para WAV cada ciclo, e só emite segmentos novos (após o offset
        já transcrito). Isso é necessário porque chunks WebM/Opus não
        são independentemente decodáveis — só o primeiro tem o header.
        """
        with self._buffer_lock:
            current_size = len(self._audio_buffer)
            # Só transcreve se houver dados novos significativos
            if current_size < 1000 or current_size == self._last_buffer_size:
                return
            # Copia o buffer inteiro (não limpa!)
            audio_data = bytes(self._audio_buffer)

        # Converte o WebM completo → WAV 16kHz mono via ffmpeg
        _log(f"Convertendo {len(audio_data)//1024}KB de áudio WebM...")
        wav_data = self._convert_to_wav(audio_data)
        if not wav_data:
            _log_error(f"Falha ao converter {len(audio_data)//1024}KB de WebM para WAV")
            return
        _log(f"WAV: {len(wav_data)//1024}KB → transcrevendo...")

        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                tmp.write(wav_data)
                tmp_path = tmp.name

            segments_iter, info = self._model.transcribe(
                tmp_path,
                language=self.language or None,
                word_timestamps=True,
                vad_filter=True,
                vad_parameters=dict(
                    min_silence_duration_ms=500,
                    speech_pad_ms=200,
                ),
                beam_size=5,
                condition_on_previous_text=True,
            )

            # Coleta todos os segmentos do áudio completo
            new_segments = []
            for seg in segments_iter:
                text = seg.text.strip()
                if not text:
                    continue

                # Só emite segmentos que começam após o que já foi transcrito
                if seg.end <= self._total_transcribed_seconds:
                    continue

                # Determina speaker baseado no ponto médio
                mid = (seg.start + seg.end) / 2
                speaker = self._speaker_at(mid)

                words = []
                if seg.words:
                    for w in seg.words:
                        words.append({
                            "word": w.word.strip(),
                            "start": round(w.start, 3),
                            "end": round(w.end, 3),
                            "prob": round(w.probability, 3),
                        })

                live_seg = LiveSegment(
                    text=text,
                    start=round(seg.start, 3),
                    end=round(seg.end, 3),
                    speaker=speaker,
                    words=words,
                )
                new_segments.append(live_seg)

            # Atualiza offset para a duração total do áudio convertido
            self._total_transcribed_seconds = info.duration
            self._last_buffer_size = current_size

            # Emite apenas os segmentos novos
            for live_seg in new_segments:
                self.all_segments.append(live_seg)
                if self._on_segment:
                    try:
                        self._on_segment(live_seg)
                    except Exception as e:
                        _log_error(f"Erro no callback de segmento: {e}")

            if new_segments:
                _log(f"{len(new_segments)} segmento(s) novo(s) | "
                     f"total: {info.duration:.1f}s de áudio")

        except Exception as e:
            _log_error(f"Erro na transcrição: {e}")
        finally:
            if tmp_path:
                try:
                    Path(tmp_path).unlink(missing_ok=True)
                except:
                    pass

    def _convert_to_wav(self, webm_data: bytes) -> Optional[bytes]:
        """Converte dados WebM/Opus em memória para WAV 16kHz mono.

        Usa arquivos temporários ao invés de pipe porque ffmpeg
        precisa de seek para parsear o container WebM corretamente.
        """
        tmp_in = None
        tmp_out = None
        try:
            # Salva WebM em arquivo temporário (ffmpeg precisa de seek)
            with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as f:
                f.write(webm_data)
                tmp_in = f.name

            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
                tmp_out = f.name

            proc = subprocess.run(
                [
                    "ffmpeg", "-y",
                    "-i", tmp_in,
                    "-ar", "16000",
                    "-ac", "1",
                    tmp_out,
                ],
                capture_output=True,
                timeout=30,
            )
            if proc.returncode != 0:
                stderr = proc.stderr[-300:].decode(errors='ignore')
                _log_error(f"ffmpeg erro: {stderr}")
                return None

            wav_data = Path(tmp_out).read_bytes()
            if len(wav_data) < 100:
                _log_error(f"WAV gerado muito pequeno ({len(wav_data)} bytes)")
                return None
            return wav_data

        except subprocess.TimeoutExpired:
            _log_error("ffmpeg timeout na conversão")
            return None
        except Exception as e:
            _log_error(f"Erro na conversão: {e}")
            return None
        finally:
            for p in (tmp_in, tmp_out):
                if p:
                    try:
                        Path(p).unlink(missing_ok=True)
                    except:
                        pass

    def _speaker_at(self, elapsed_seconds: float) -> Optional[str]:
        """Retorna quem estava falando em determinado ponto."""
        if not self._speaker_events:
            return self._current_speaker
        speaker = None
        for ev in self._speaker_events:
            if ev["elapsedSeconds"] <= elapsed_seconds:
                speaker = ev["speaker"]
            else:
                break
        return speaker or self._current_speaker


# ── Logging helpers ──────────────────────────────────────────────────────────

def _log(msg: str):
    if RICH:
        console.print(f"  [blue]🎤[/blue] {msg}")
    else:
        print(f"  🎤 {msg}")

def _log_ok(msg: str):
    if RICH:
        console.print(f"  [green]✓[/green] {msg}")
    else:
        print(f"  ✓ {msg}")

def _log_error(msg: str):
    if RICH:
        console.print(f"  [red]✗[/red] {msg}")
    else:
        print(f"  ✗ {msg}")
