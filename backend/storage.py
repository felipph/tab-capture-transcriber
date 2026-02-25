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


BASE_DIR = Path("output")


def new_session_id() -> str:
    return datetime.datetime.now().strftime("%Y%m%d_%H%M%S")


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

    @classmethod
    def create(cls, session_id: str) -> "Session":
        d = BASE_DIR / f"session_{session_id}"
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

    def open_audio(self):
        self.audio_file = open(self.audio_path, "wb")

    def write_audio(self, data: bytes):
        if self.audio_file:
            self.audio_file.write(data)
            self.chunk_count += 1

    def close_audio(self):
        if self.audio_file:
            self.audio_file.flush()
            self.audio_file.close()
            self.audio_file = None

    def save_frame(self, data: bytes, speaker: str, elapsed: int) -> str:
        speaker_slug = (speaker or "unknown").replace(" ", "_")[:30]
        filename = f"frame_{self.frame_count:04d}_{elapsed:05d}s_{speaker_slug}.png"
        path = self.frames_dir / filename
        path.write_bytes(data)
        self.frame_count += 1
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

    def save_metadata(self):
        """Persiste timeline e speaker_map em disco ao fim da sessão."""
        self.timeline_path.write_text(
            json.dumps(self.timeline, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        self.speaker_map_path.write_text(
            json.dumps({
                "chunks":         self.speaker_map,
                "speaker_events": self.speaker_events,
                "participants":   self.participants,
            }, indent=2, ensure_ascii=False),
            encoding="utf-8"
        )

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
