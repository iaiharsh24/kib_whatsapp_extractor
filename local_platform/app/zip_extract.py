"""Safe WhatsApp export zip extraction and chat/media discovery."""
from __future__ import annotations

import shutil
import zipfile
from pathlib import Path

from app.parser import HEADER_ANDROID, HEADER_IOS

ROOT = Path(__file__).resolve().parents[2]
EXTRACT_DIR = Path(ROOT) / "local_data" / "extracted"
UPLOAD_DIR = Path(ROOT) / "local_data" / "uploads"
SKIP_DIRS = {"node_modules", ".git", "__macosx", ".venv", "dist", "build"}
CHAT_BASENAMES = {"_chat.txt", "chat.txt"}
MAX_MEMBER_BYTES = 2 * 1024 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024


def looks_like_zip(path: Path) -> bool:
    if path.suffix.lower() == ".zip":
        return True
    with path.open("rb") as handle:
        magic = handle.read(4)
    return magic in {b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"}


def _decode_zip_name(info: zipfile.ZipInfo) -> str:
    name = info.filename
    if info.flag_bits & 0x800:
        return name
    try:
        return name.encode("cp437").decode("utf-8")
    except Exception:
        try:
            return name.encode("cp437").decode("cp1252")
        except Exception:
            return name


def extract_zip(zip_path: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    dest = dest.resolve()
    total = 0
    with zipfile.ZipFile(zip_path) as archive:
        for info in archive.infolist():
            name = _decode_zip_name(info).replace("\\", "/")
            if not name or name.endswith("/"):
                continue
            parts = Path(name).parts
            if any(part.lower() in SKIP_DIRS or part.startswith("._") for part in parts):
                continue
            if Path(name).name in {".ds_store", "thumbs.db"}:
                continue
            target = (dest / name).resolve()
            if not str(target).startswith(str(dest)):
                continue
            if info.file_size > MAX_MEMBER_BYTES:
                continue
            total += info.file_size
            if total > MAX_TOTAL_BYTES:
                raise ValueError("Zip is larger than the local extract limit (8 GB).")
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info) as source, target.open("wb") as out:
                shutil.copyfileobj(source, out)


def _sniff_whatsapp_txt(path: Path) -> bool:
    try:
        sample = path.read_text(encoding="utf-8", errors="replace")[:12000]
    except OSError:
        return False
    hits = 0
    for raw in sample.splitlines()[:40]:
        line = raw.lstrip("\ufeff\u200e\u200f")
        if HEADER_IOS.match(line) or HEADER_ANDROID.match(line):
            hits += 1
            if hits >= 2:
                return True
    return False


def find_chat_exports(root: Path) -> list[Path]:
    found: list[Path] = []
    for path in root.rglob("*.txt"):
        if any(part.lower() in SKIP_DIRS for part in path.parts):
            continue
        name = path.name.lower()
        if name in CHAT_BASENAMES or name.startswith("whatsapp chat"):
            found.append(path)
            continue
        if _sniff_whatsapp_txt(path):
            found.append(path)
    named = [
        path
        for path in found
        if path.name.lower() in CHAT_BASENAMES or path.name.lower().startswith("whatsapp chat")
    ]
    selected = named or found
    unique: list[Path] = []
    seen = set()
    for path in selected:
        key = str(path.resolve()).lower()
        if key not in seen:
            seen.add(key)
            unique.append(path)
    unique.sort(key=lambda item: (0 if item.name.lower().startswith("whatsapp chat") or item.name.lower() in CHAT_BASENAMES else 1, item.name.lower()))
    return unique


def index_media(root: Path) -> dict[str, Path]:
    index: dict[str, Path] = {}
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if path.suffix.lower() == ".txt" and (
            path.name.lower().startswith("whatsapp chat") or path.name.lower() in CHAT_BASENAMES
        ):
            continue
        if any(part.lower() in SKIP_DIRS for part in path.parts):
            continue
        index[path.name.lower()] = path
        index[path.name.lower().replace(" ", "_")] = path
    return index


def lookup_media(filename: str | None, index: dict[str, Path]) -> Path | None:
    if not filename:
        return None
    name = Path(filename.replace("\\", "/")).name.strip().strip('"').strip("'")
    if not name:
        return None
    direct = index.get(name.lower()) or index.get(name.lower().replace(" ", "_"))
    if direct:
        return direct
    stem = Path(name).stem.lower().rstrip(".")
    if not stem:
        return None
    for key, path in index.items():
        if Path(key).stem.lower().rstrip(".") == stem:
            return path
    return None


def find_extracted_file(upload_id: str, filename: str) -> Path | None:
    root = (EXTRACT_DIR / upload_id).resolve()
    if not root.exists():
        return None
    want = Path(filename.replace("\\", "/")).name
    if not want or want in {".", ".."}:
        return None
    for path in root.rglob("*"):
        if path.is_file() and path.name.lower() == want.lower():
            resolved = path.resolve()
            if str(resolved).startswith(str(root)):
                return resolved
    return None


def delete_upload_files(upload_id: str) -> None:
    extract = EXTRACT_DIR / upload_id
    if extract.exists():
        shutil.rmtree(extract, ignore_errors=True)
    if UPLOAD_DIR.exists():
        for path in UPLOAD_DIR.glob(f"{upload_id}_*"):
            try:
                path.unlink()
            except OSError:
                pass
