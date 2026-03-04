"""
storage.py — Gerenciamento de sessões e arquivos em disco
Cada sessão recebe um diretório próprio com:
  session_<id>/
  ├── audio.webm          ← chunks de áudio acumulados
  ├── timeline.json       ← todos os eventos recebidos via WS
  ├── speaker_map.json    ← índice chunkIndex → speaker (construído em tempo real)
  ├── frames/             ← PNGs de conteúdo compartilhado
  │   └── frame_0001_<speaker>_<elapsed>.png
  ├── transcript.json     ← saída final da transcrição (gerado pelo transcriber)
  ├── transcript.txt      ← versão legível da transcrição
  └── transcript.srt      ← legenda no formato SRT
"""

import os
import json
import asyncio
import aiofiles
import datetime
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional
from PIL import Image
import numpy as np
import io


BASE_DIR = Path("output")


def new_session_id() -> str:
    return datetime.datetime.now().strftime("%Y%m%d_%H%M%S")


def sanitize_folder_name(name: str) -> str:
    """Remove caracteres inválidos para nome de pasta."""
    import re
    # Remove caracteres que não podem estar em nomes de arquivo/pasta
    name = re.sub(r'[<>:"/\\|?*\(\)]', '', name)
    # Limita tamanho
    return name[:50] if name else "sessao"


@dataclass
class Session:
    id: str
    dir: Path
    audio_path: Path
    timeline_path: Path
    speaker_map_path: Path
    frames_dir: Path

    # Estado em memória (não persistido até o fim)
    timeline: list = field(default_factory=list)
    # chunkIndex → { speaker, timestamp, elapsedSeconds }
    speaker_map: dict = field(default_factory=dict)
    # Lista cronológica de eventos SPEAKER_CHANGE
    speaker_events: list = field(default_factory=list)
    participants: dict = field(default_factory=dict)

    audio_file: object = None         # file handle aberto para escrita
    frame_count: int = 0
    chunk_count: int = 0
    pending_meta: Optional[dict] = None   # metadado aguardando o próximo binário
    _last_frame_fingerprint: Optional[np.ndarray] = field(default=None, repr=False)  # thumbnail do último frame salvo
    _frame_diff_threshold: float = 0.05   # threshold de diferença (0.15 = 15%) para considerar novo slide

    @classmethod
    def create(cls, session_id: str, name: str = None) -> "Session":
        if name:
            folder_name = f"{session_id}_{sanitize_folder_name(name)}"
        else:
            folder_name = f"session_{session_id}"
        d = BASE_DIR / folder_name
        d.mkdir(parents=True, exist_ok=True)
        frames = d / "frames"
        frames.mkdir(exist_ok=True)
        return cls(
            id=session_id,
            dir=d,
            audio_path=d / "audio.webm",
            timeline_path=d / "timeline.json",
            speaker_map_path=d / "speaker_map.json",
            frames_dir=frames,
        )

    async def open_audio(self):
        self.audio_file = await aiofiles.open(self.audio_path, "wb")

    async def write_audio(self, data: bytes):
        if self.audio_file:
            await self.audio_file.write(data)
            self.chunk_count += 1

    async def close_audio(self):
        if self.audio_file:
            await self.audio_file.flush()
            await self.audio_file.close()
            self.audio_file = None

    def _compute_frame_fingerprint(self, data: bytes) -> np.ndarray:
        """Gera um fingerprint da imagem (32x32 grayscale) para comparação."""
        try:
            img = Image.open(io.BytesIO(data))
            # Converte para RGB se necessário
            if img.mode != 'RGB':
                img = img.convert('RGB')
            # Redimensiona para 32x32 e converte para grayscale
            img = img.resize((32, 32), Image.Resampling.LANCZOS)
            # Converte para numpy array e grayscale
            arr = np.array(img)
            # Converte para grayscale usando luminância
            gray = np.dot(arr[...,:3], [0.299, 0.587, 0.114])
            # Normaliza para 0-1
            return gray.astype(np.float32) / 255.0
        except Exception:
            return np.zeros((32, 32), dtype=np.float32)

    def _frames_are_similar(self, fp1: np.ndarray, fp2: np.ndarray) -> bool:
        """Compara dois fingerprints e retorna True se forem similares (mesmo slide)."""
        if fp1 is None or fp2 is None:
            return False
        # Calcula a diferença média absoluta
        diff = np.abs(fp1 - fp2)
        mean_diff = np.mean(diff)
        # Se a diferença média for menor que o threshold, consideramos iguais
        return mean_diff < self._frame_diff_threshold

    async def save_frame(self, data: bytes, speaker: str, elapsed: int) -> Optional[str]:
        """Salva o frame apenas se for significativamente diferente do anterior (novo slide)."""
        # Gera fingerprint do frame atual
        current_fp = self._compute_frame_fingerprint(data)

        # Se temos um frame anterior, compara
        if self._last_frame_fingerprint is not None:
            if self._frames_are_similar(self._last_frame_fingerprint, current_fp):
                # Frames são similares - descarta (mesmo slide)
                return None

        # Frames são diferentes o suficiente - salva
        speaker_slug = (speaker or "unknown").replace(" ", "_")[:30]
        filename = f"frame_{self.frame_count:04d}_{elapsed:05d}s_{speaker_slug}.png"
        path = self.frames_dir / filename
        async with aiofiles.open(path, "wb") as f:
            await f.write(data)
        self.frame_count += 1
        self._last_frame_fingerprint = current_fp
        return str(path)

    def add_timeline_event(self, event: dict):
        self.timeline.append(event)

    def record_chunk_speaker(self, chunk_index: int, speaker: Optional[str],
                              timestamp: int, elapsed: int):
        self.speaker_map[str(chunk_index)] = {
            "speaker":        speaker,
            "timestamp":      timestamp,
            "elapsedSeconds": elapsed,
        }

    def record_speaker_change(self, speaker: Optional[str],
                               timestamp: int, elapsed: int):
        self.speaker_events.append({
            "speaker":        speaker,
            "timestamp":      timestamp,
            "elapsedSeconds": elapsed,
        })

    def speaker_at(self, elapsed_seconds: float) -> Optional[str]:
        """Retorna quem estava falando em determinado ponto da gravação."""
        if not self.speaker_events:
            return None
        speaker = None
        for ev in self.speaker_events:
            if ev["elapsedSeconds"] <= elapsed_seconds:
                speaker = ev["speaker"]
            else:
                break
        return speaker

    async def save_metadata(self):
        """Persiste timeline e speaker_map em disco ao fim da sessão."""
        async with aiofiles.open(self.timeline_path, "w", encoding="utf-8") as f:
            await f.write(json.dumps(self.timeline, indent=2, ensure_ascii=False))
        async with aiofiles.open(self.speaker_map_path, "w", encoding="utf-8") as f:
            await f.write(json.dumps({
                "chunks":         self.speaker_map,
                "speaker_events": self.speaker_events,
                "participants":   self.participants,
            }, indent=2, ensure_ascii=False))

    def summary(self) -> dict:
        size_mb = self.audio_path.stat().st_size / 1024 / 1024 if self.audio_path.exists() else 0
        return {
            "session_id":   self.id,
            "chunks":       self.chunk_count,
            "frames":       self.frame_count,
            "audio_size_mb": round(size_mb, 2),
            "participants": list(self.participants.values()),
            "speaker_changes": len(self.speaker_events),
        }
