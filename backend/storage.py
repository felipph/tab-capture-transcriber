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
    frames_discarded_dir: Path

    # Estado em memória (não persistido até o fim)
    timeline: list = field(default_factory=list)
    # chunkIndex → { speaker, timestamp, elapsedSeconds }
    speaker_map: dict = field(default_factory=dict)
    # Lista cronológica de eventos SPEAKER_CHANGE
    speaker_events: list = field(default_factory=list)
    participants: dict = field(default_factory=dict)

    audio_file: object = None         # file handle aberto para escrita
    frame_count: int = 0
    _discard_count: int = 0
    chunk_count: int = 0
    pending_meta: Optional[dict] = None   # metadado aguardando o próximo binário

    # ── Configuração de comparação de frames ──────────────────────────────
    # Algoritmo: "phash" (pHash + histograma) ou "pixel_diff" (% de pixels alterados)
    _frame_diff_algorithm: str = "pixel_diff"

    # Parâmetros para algoritmo "phash"
    _last_frame_phash: Optional[int] = None
    _last_frame_histogram: Optional[np.ndarray] = field(default=None, repr=False)
    _phash_max_distance: int = 16       # distância de Hamming máxima (0-64, menor = mais estrito)
    _hist_corr_threshold: float = 0.95  # correlação mínima de histograma (0-1)

    # Parâmetros para algoritmo "pixel_diff"
    _last_frame_gray: Optional[np.ndarray] = field(default=None, repr=False)
    _pixel_intensity_threshold: int = 25   # diferença mínima de intensidade (0-255) para considerar pixel como "alterado"
    _pixel_change_min_pct: float = 0.5     # % mínimo de pixels alterados para considerar frame diferente (0-100)

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
        frames_discarded = d / "frames_discarded"
        frames_discarded.mkdir(exist_ok=True)
        return cls(
            id=session_id,
            dir=d,
            audio_path=d / "audio.webm",
            timeline_path=d / "timeline.json",
            speaker_map_path=d / "speaker_map.json",
            frames_dir=frames,
            frames_discarded_dir=frames_discarded,
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

    @staticmethod
    def _compute_phash(img: Image.Image, hash_size: int = 8) -> int:
        """Perceptual hash baseado em DCT — robusto contra compressão e pequenas variações."""
        # Redimensiona para hash_size*4 x hash_size*4 para ter dados suficientes para DCT
        size = hash_size * 4
        img_gray = img.convert('L').resize((size, size), Image.Resampling.LANCZOS)
        pixels = np.array(img_gray, dtype=np.float64)

        # DCT 2D (via separable 1D DCT com scipy-free implementation)
        # Aplica DCT nas linhas e depois nas colunas
        dct = np.zeros_like(pixels)
        for i in range(size):
            for k in range(size):
                s = 0.0
                for n in range(size):
                    s += pixels[i, n] * np.cos(np.pi * k * (2 * n + 1) / (2 * size))
                dct[i, k] = s
        dct2 = np.zeros_like(dct)
        for j in range(size):
            for k in range(size):
                s = 0.0
                for n in range(size):
                    s += dct[n, j] * np.cos(np.pi * k * (2 * n + 1) / (2 * size))
                dct2[k, j] = s

        # Pega o bloco top-left hash_size x hash_size (frequências mais baixas)
        low_freq = dct2[:hash_size, :hash_size]
        # Mediana como threshold (exclui DC component [0,0])
        med = np.median(low_freq)
        # Gera hash: 1 se acima da mediana, 0 se abaixo
        bits = (low_freq > med).flatten()
        # Converte array de bits para inteiro
        h = 0
        for bit in bits:
            h = (h << 1) | int(bit)
        return h

    @staticmethod
    def _hamming_distance(h1: int, h2: int) -> int:
        """Distância de Hamming entre dois hashes (conta bits diferentes)."""
        return bin(h1 ^ h2).count('1')

    @staticmethod
    def _compute_histogram(img: Image.Image) -> np.ndarray:
        """Histograma normalizado em 3 canais (RGB), 32 bins por canal."""
        img_rgb = img.convert('RGB')
        img_small = img_rgb.resize((256, 256), Image.Resampling.LANCZOS)
        arr = np.array(img_small)
        hists = []
        for ch in range(3):
            h, _ = np.histogram(arr[:, :, ch], bins=32, range=(0, 256))
            h = h.astype(np.float64)
            norm = np.linalg.norm(h)
            if norm > 0:
                h /= norm
            hists.append(h)
        return np.concatenate(hists)

    @staticmethod
    def _histogram_correlation(h1: np.ndarray, h2: np.ndarray) -> float:
        """Correlação entre dois histogramas normalizados (-1 a 1, 1 = idênticos)."""
        m1 = h1 - np.mean(h1)
        m2 = h2 - np.mean(h2)
        denom = np.linalg.norm(m1) * np.linalg.norm(m2)
        if denom < 1e-10:
            return 1.0  # ambos constantes = iguais
        return float(np.dot(m1, m2) / denom)

    @staticmethod
    def _img_to_gray(img: Image.Image, target_size: tuple = (512, 512)) -> np.ndarray:
        """Converte PIL Image para grayscale numpy uint8 redimensionado."""
        return np.array(
            img.convert('L').resize(target_size, Image.Resampling.LANCZOS),
            dtype=np.uint8
        )

    # ── Decisão: mesmo slide? ─────────────────────────────────────────────
    def _is_same_slide_phash(self, img: Image.Image) -> tuple[bool, dict]:
        """
        Algoritmo pHash + histograma.
        Retorna: (is_same, state_dict) onde state_dict contém dados para cache.
        """
        phash = self._compute_phash(img)
        histogram = self._compute_histogram(img)
        state = {"phash": phash, "histogram": histogram}

        if self._last_frame_phash is None or self._last_frame_histogram is None:
            return False, state

        ham_dist = self._hamming_distance(phash, self._last_frame_phash)
        hist_corr = self._histogram_correlation(histogram, self._last_frame_histogram)

        phash_similar = ham_dist <= self._phash_max_distance
        hist_similar = hist_corr >= self._hist_corr_threshold

        state["metric"] = f"ham{ham_dist}_corr{hist_corr:.3f}"
        return (phash_similar and hist_similar), state

    def _is_same_slide_pixel_diff(self, img: Image.Image) -> tuple[bool, dict]:
        """
        Algoritmo Pixel Diff — conta % de pixels que mudaram acima de um limiar.
        Naturalmente ignora regiões estáticas (UI) sem precisar de crop.
        Retorna: (is_same, state_dict) onde state_dict contém dados para cache.
        """
        gray = self._img_to_gray(img)
        state = {"gray": gray}

        if self._last_frame_gray is None:
            return False, state

        # Diferença absoluta pixel a pixel
        diff = np.abs(gray.astype(np.int16) - self._last_frame_gray.astype(np.int16))
        # Pixels que mudaram acima do limiar de intensidade
        changed_mask = diff > self._pixel_intensity_threshold
        changed_pct = float(np.count_nonzero(changed_mask) / changed_mask.size * 100)

        state["metric"] = f"pxdiff{changed_pct:.2f}pct"
        return changed_pct < self._pixel_change_min_pct, state

    async def save_frame(self, data: bytes, speaker: str, elapsed: int) -> Optional[str]:
        """Salva o frame apenas se for significativamente diferente do anterior (novo slide)."""
        try:
            img = Image.open(io.BytesIO(data))
        except Exception:
            return None

        # Seleciona algoritmo de comparação
        if self._frame_diff_algorithm == "pixel_diff":
            is_same, state = self._is_same_slide_pixel_diff(img)
        else:
            is_same, state = self._is_same_slide_phash(img)

        if is_same:
            # Salva frame descartado para análise
            metric_str = state.get("metric", "unknown")
            speaker_slug = (speaker or "unknown").replace(" ", "_")[:30]
            discard_name = f"discard_{self._discard_count:04d}_{elapsed:05d}s_{metric_str}_{speaker_slug}.png"
            # criar diretorio se nao existir
            os.makedirs(self.frames_discarded_dir, exist_ok=True)
            discard_path = self.frames_discarded_dir / discard_name
            async with aiofiles.open(discard_path, "wb") as f:
                await f.write(data)
            self._discard_count += 1
            return None

        # Frames são diferentes o suficiente - salva
        speaker_slug = (speaker or "unknown").replace(" ", "_")[:30]
        filename = f"frame_{self.frame_count:04d}_{elapsed:05d}s_{speaker_slug}.png"
        path = self.frames_dir / filename
        async with aiofiles.open(path, "wb") as f:
            await f.write(data)
        self.frame_count += 1

        # Atualiza cache do algoritmo selecionado
        if self._frame_diff_algorithm == "pixel_diff":
            self._last_frame_gray = state["gray"]
        else:
            self._last_frame_phash = state["phash"]
            self._last_frame_histogram = state["histogram"]
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
