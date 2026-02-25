"""
retranscribe.py — Re-transcreve uma sessão já gravada

Útil para:
  • Tentar um modelo maior após a chamada
  • Mudar idioma
  • Regenerar transcript.txt/srt sem regravar

Uso:
    python retranscribe.py output/session_20240225_143022
    python retranscribe.py output/session_20240225_143022 --model large-v3
    python retranscribe.py output/session_20240225_143022 --model large --language en
    python retranscribe.py --list     # lista todas as sessões gravadas
"""

import argparse
import json
from pathlib import Path
from transcriber import transcribe, format_time

try:
    from rich.console import Console
    from rich.table import Table
    console = Console()
    RICH = True
except ImportError:
    RICH = False


def list_sessions():
    base = Path("output")
    if not base.exists():
        print("Nenhuma sessão encontrada em ./output/")
        return

    sessions = sorted(base.glob("session_*"), reverse=True)
    if not sessions:
        print("Nenhuma sessão gravada ainda.")
        return

    if RICH:
        table = Table(title="Sessões gravadas", border_style="dim")
        table.add_column("Sessão",        style="bold cyan")
        table.add_column("Áudio",         justify="right")
        table.add_column("Frames",        justify="right")
        table.add_column("Participantes")
        table.add_column("Transcrição")

        for s in sessions:
            audio = s / "audio.webm"
            size  = f"{audio.stat().st_size/1024/1024:.1f} MB" if audio.exists() else "—"

            frames = len(list((s / "frames").glob("*.png"))) if (s / "frames").exists() else 0

            sm = s / "speaker_map.json"
            participants = "—"
            if sm.exists():
                data = json.loads(sm.read_text(encoding="utf-8"))
                names = list(data.get("participants", {}).values())
                participants = ", ".join(names[:3])
                if len(names) > 3:
                    participants += f" +{len(names)-3}"

            has_transcript = "✓" if (s / "transcript.json").exists() else "—"
            table.add_row(s.name, size, str(frames), participants, has_transcript)

        console.print(table)
    else:
        for s in sessions:
            audio = s / "audio.webm"
            size  = f"{audio.stat().st_size/1024/1024:.1f}MB" if audio.exists() else "—"
            print(f"  {s.name}  ({size})")


def main():
    parser = argparse.ArgumentParser(description="Re-transcreve sessão gravada")
    parser.add_argument("session_dir", nargs="?",
                        help="Caminho para o diretório da sessão")
    parser.add_argument("--model",    default="medium",
                        choices=["tiny","base","small","medium","large","large-v2","large-v3"])
    parser.add_argument("--language", default="pt")
    parser.add_argument("--list",     action="store_true",
                        help="Lista todas as sessões gravadas")
    args = parser.parse_args()

    if args.list or not args.session_dir:
        list_sessions()
        return

    session_dir = Path(args.session_dir)
    if not session_dir.exists():
        # Tenta prefixar com output/
        session_dir = Path("output") / args.session_dir
    if not session_dir.exists():
        print(f"Diretório não encontrado: {args.session_dir}")
        return

    transcript = transcribe(
        session_dir=session_dir,
        model_name=args.model,
        language=args.language or None,
    )

    print(f"\nDuração: {format_time(transcript['total_duration'])}")
    print(f"Segmentos: {len(transcript['segments'])}")
    print(f"Idioma detectado: {transcript['language']}")


if __name__ == "__main__":
    main()
