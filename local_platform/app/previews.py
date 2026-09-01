"""Extract URLs from WhatsApp text and build link preview cards."""
from __future__ import annotations

from html import unescape as html_unescape
import ipaddress
import json
import re
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import httpx

ROOT = Path(__file__).resolve().parents[2]
CACHE_PATH = ROOT / "local_data" / "link_previews.json"

ZW = re.compile(r"[\u200b\u200c\u200d\u2060\ufeff\u200e\u200f]")
URL_RE = re.compile(r"(?:https?://|www\.)[^\s<>\"'\)\]\|]+", re.IGNORECASE)
YT_ID = re.compile(
    r"(?:youtu\.be/|youtube\.com/(?:watch\?v=|embed/|shorts/|live/))([A-Za-z0-9_-]{6,})",
    re.IGNORECASE,
)
VIMEO_ID = re.compile(r"vimeo\.com/(?:video/)?(\d+)", re.IGNORECASE)
DRIVE_FILE = re.compile(r"drive\.google\.com/(?:file/d/|open\?id=)([A-Za-z0-9_-]+)", re.IGNORECASE)
DRIVE_FOLDER = re.compile(r"drive\.google\.com/drive/(?:u/\d+/)?folders/([A-Za-z0-9_-]+)", re.IGNORECASE)
GDOCS = re.compile(
    r"docs\.google\.com/(document|spreadsheets|presentation)/d/([A-Za-z0-9_-]+)",
    re.IGNORECASE,
)
GITHUB = re.compile(r"github\.com/([^/\s]+)/([^/\s#?]+)", re.IGNORECASE)
IG_POST = re.compile(r"instagram\.com/(?:reel|p|tv)/([A-Za-z0-9_-]+)", re.IGNORECASE)
OG_PROP = re.compile(
    r'<meta[^>]+(?:property|name)=["\'](?:og:|twitter:)?(title|description|image)["\'][^>]+content=["\']([^"\']+)',
    re.IGNORECASE,
)
OG_PROP_REV = re.compile(
    r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\'](?:og:|twitter:)?(title|description|image)["\']',
    re.IGNORECASE,
)
TITLE_TAG = re.compile(r"<title[^>]*>([^<]+)</title>", re.IGNORECASE)
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
SKIP_FETCH_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1"}
SKIP_HTML_HOSTS = {
    "instagram.com",
    "www.instagram.com",
    "facebook.com",
    "www.facebook.com",
    "m.facebook.com",
    "fb.watch",
    "meet.google.com",
}


def _clean_text(text: str | None) -> str:
    return ZW.sub("", text or "")


def normalize_urls(text: str | None) -> list[str]:
    found: list[str] = []
    for raw in URL_RE.findall(_clean_text(text)):
        url = raw.strip().rstrip(".,;:!?)]}'\"")
        if url.lower().startswith("www."):
            url = "https://" + url
        if not url.lower().startswith(("http://", "https://")):
            continue
        if url not in found:
            found.append(url)
    return found


def primary_url(text: str | None, extracted: str | None = None) -> str | None:
    if extracted and str(extracted).lower().startswith("http"):
        return extracted
    urls = normalize_urls(text)
    return urls[0] if urls else None


def _domain(url: str) -> str:
    try:
        host = urlparse(url).hostname or ""
        return host.removeprefix("www.")
    except Exception:
        return ""


def is_fetchable_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    host = (parsed.hostname or "").lower()
    if not host or host in SKIP_FETCH_HOSTS:
        return False
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local:
            return False
    except ValueError:
        pass
    return True


def _favicon(domain: str) -> str:
    return f"https://www.google.com/s2/favicons?domain={domain}&sz=128"


def instant_preview(url: str | None) -> dict | None:
    if not url or not str(url).lower().startswith("http"):
        return None
    domain = _domain(url)
    preview = {
        "url": url,
        "domain": domain,
        "title": domain or url,
        "description": "",
        "image": _favicon(domain) if domain else None,
        "site": domain,
        "embed": None,
        "kind": "link",
    }
    yt = YT_ID.search(url)
    if yt:
        vid = yt.group(1)
        preview.update(
            {
                "title": "YouTube video",
                "site": "YouTube",
                "image": f"https://img.youtube.com/vi/{vid}/hqdefault.jpg",
                "embed": f"https://www.youtube.com/embed/{vid}",
                "kind": "video",
            }
        )
        return preview
    if "youtube.com" in domain or domain == "youtu.be":
        query = parse_qs(urlparse(url).query)
        q = unquote((query.get("search_query") or [""])[0].replace("+", " ")).strip()
        preview.update(
            {
                "title": f"YouTube: {q}" if q else "YouTube",
                "site": "YouTube",
                "kind": "video",
            }
        )
        return preview
    vim = VIMEO_ID.search(url)
    if vim:
        preview.update({"title": "Vimeo video", "site": "Vimeo", "kind": "video"})
        return preview
    drive_file = DRIVE_FILE.search(url)
    if drive_file:
        file_id = drive_file.group(1)
        preview.update(
            {
                "title": "Google Drive file",
                "site": "Google Drive",
                "image": f"https://drive.google.com/thumbnail?id={file_id}&sz=w800",
                "embed": f"https://drive.google.com/file/d/{file_id}/preview",
                "kind": "file",
            }
        )
        return preview
    drive_folder = DRIVE_FOLDER.search(url)
    if drive_folder:
        preview.update(
            {
                "title": "Google Drive folder",
                "site": "Google Drive",
                "image": _favicon("drive.google.com"),
                "kind": "file",
            }
        )
        return preview
    docs = GDOCS.search(url)
    if docs:
        kind, doc_id = docs.group(1).lower(), docs.group(2)
        labels = {"document": "Google Doc", "spreadsheets": "Google Sheet", "presentation": "Google Slides"}
        preview.update(
            {
                "title": labels.get(kind, "Google Docs"),
                "site": "Google Docs",
                "image": f"https://drive.google.com/thumbnail?id={doc_id}&sz=w800",
                "embed": f"https://docs.google.com/{kind}/d/{doc_id}/preview",
                "kind": "file",
            }
        )
        return preview
    gh = GITHUB.search(url)
    if gh and gh.group(1).lower() not in {"orgs", "settings", "topics", "features", "pricing", "marketplace"}:
        user, repo = gh.group(1), gh.group(2).rstrip("/").removesuffix(".git")
        preview.update(
            {
                "title": f"{user}/{repo}",
                "site": "GitHub",
                "image": f"https://opengraph.githubassets.com/1/{user}/{repo}",
                "kind": "code",
            }
        )
        return preview
    ig = IG_POST.search(url)
    if ig:
        code = ig.group(1)
        kind = "reel" if "/reel/" in url.lower() else "p"
        preview.update(
            {
                "title": "Instagram reel" if kind == "reel" else "Instagram post",
                "site": "Instagram",
                "embed": f"https://www.instagram.com/{kind}/{code}/embed/?hidecaption=1",
                "image": _favicon("instagram.com"),
                "kind": "video",
            }
        )
        return preview
    lowered = url.lower()
    if "instagram.com" in lowered:
        handle = urlparse(url).path.strip("/")
        preview.update(
            {
                "title": f"@{handle}" if handle and "/" not in handle else "Instagram",
                "site": "Instagram",
                "kind": "social",
            }
        )
        return preview
    if "facebook.com" in lowered or "fb.watch" in lowered:
        preview.update({"title": "Facebook", "site": "Facebook", "kind": "social"})
        return preview
    if "meet.google.com" in lowered:
        preview.update({"title": "Google Meet", "site": "Google Meet", "kind": "meeting"})
        return preview
    if "chromewebstore.google.com" in lowered:
        preview.update({"title": "Chrome extension", "site": "Chrome Web Store", "kind": "app"})
        return preview
    if "notion.so" in lowered or "notion.site" in lowered:
        preview.update({"title": "Notion page", "site": "Notion", "kind": "file"})
        return preview
    if "acrobat.adobe.com" in lowered or "adobeacrobat.app.link" in lowered:
        preview.update({"title": "Adobe Acrobat", "site": "Adobe Acrobat", "kind": "file"})
        return preview
    path = urlparse(url).path.lower()
    for ext in IMAGE_EXT:
        if path.endswith(ext):
            preview.update({"title": path.rsplit("/", 1)[-1], "image": url, "site": domain, "kind": "image"})
            return preview
    return preview


def _load_cache() -> dict:
    if not CACHE_PATH.exists():
        return {}
    try:
        return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_cache(cache: dict) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")


def _is_generic_title(title: str | None, instant: dict) -> bool:
    if not title:
        return True
    generic = {
        instant.get("domain"),
        instant.get("site"),
        "GitHub",
        "Instagram",
        "YouTube",
        "YouTube video",
        "Facebook",
        "Google Drive",
        "Google Docs",
        "Adobe Acrobat",
    }
    return title in generic


def _merge_preview(instant: dict, stored: dict | None) -> dict:
    merged = dict(instant)
    if not stored:
        return merged
    for key, value in stored.items():
        if not value:
            continue
        if key == "title" and _is_generic_title(str(value), instant) and instant.get("title"):
            continue
        if key == "image":
            inst_img = str(instant.get("image") or "")
            if "opengraph.githubassets.com" in inst_img and ("github-logo" in str(value) or "favicon" in str(value)):
                continue
            if "img.youtube.com" in inst_img and "favicon" in str(value):
                continue
        if key == "site" and instant.get("site") and value in {instant.get("domain"), instant.get("site")}:
            if instant.get("site") != instant.get("domain"):
                continue
        merged[key] = value
    if instant.get("embed") and not merged.get("embed"):
        merged["embed"] = instant["embed"]
    if instant.get("site") and merged.get("site") == merged.get("domain") and instant["site"] != instant.get("domain"):
        merged["site"] = instant["site"]
    return merged


def _parse_html(url: str, markup: str) -> dict:
    preview = instant_preview(url) or {"url": url, "title": _domain(url), "image": None, "description": ""}
    meta: dict[str, str] = {}
    for match in OG_PROP.finditer(markup):
        meta[match.group(1).lower()] = match.group(2).strip()
    for match in OG_PROP_REV.finditer(markup):
        meta.setdefault(match.group(2).lower(), match.group(1).strip())
    title_match = TITLE_TAG.search(markup)
    title = meta.get("title") or (title_match.group(1).strip() if title_match else None)
    if title:
        cleaned = html_unescape(re.sub(r"\s+", " ", title))[:180]
        if not _is_generic_title(cleaned, preview) or _is_generic_title(preview.get("title"), preview):
            preview["title"] = cleaned
    if meta.get("description"):
        preview["description"] = html_unescape(re.sub(r"\s+", " ", meta["description"]))[:240]
    image = meta.get("image")
    if image:
        if image.startswith("//"):
            image = "https:" + image
        elif image.startswith("/") and preview.get("domain"):
            image = f"https://{preview['domain']}{image}"
        current = str(preview.get("image") or "")
        generic_logo = "github-logo" in image or image.endswith("favicon.ico")
        keep_github = "opengraph.githubassets.com" in current and generic_logo
        keep_youtube = "img.youtube.com" in current and generic_logo
        if not keep_github and not keep_youtube:
            preview["image"] = image
    return preview


def fetch_preview(url: str) -> dict:
    base = instant_preview(url) or {"url": url, "title": url, "image": None, "description": ""}
    if not is_fetchable_url(url):
        return base
    host = (urlparse(url).hostname or "").lower()
    if host in SKIP_HTML_HOSTS or host.endswith(".instagram.com"):
        return base
    cache = _load_cache()
    cached = cache.get(url)
    if cached and cached.get("title"):
        merged = _merge_preview(base, cached)
        merged["url"] = url
        if not _is_generic_title(merged.get("title"), base):
            return merged
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "").lower()
        if host in {"www.youtube.com", "youtube.com", "youtu.be"} and YT_ID.search(url):
            with httpx.Client(timeout=6.0, follow_redirects=True) as client:
                res = client.get("https://www.youtube.com/oembed", params={"url": url, "format": "json"})
                if res.status_code == 200:
                    data = res.json()
                    base["title"] = data.get("title") or base.get("title")
                    base["image"] = data.get("thumbnail_url") or base.get("image")
                    base["site"] = data.get("author_name") or "YouTube"
                    cache[url] = base
                    _save_cache(cache)
                    return base
        fetch_url = url
        if "github.com" in host and fetch_url.endswith(".git"):
            fetch_url = fetch_url[:-4]
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
        }
        with httpx.Client(timeout=8.0, follow_redirects=True, headers=headers) as client:
            res = client.get(fetch_url)
            ctype = (res.headers.get("content-type") or "").lower()
            if "text/html" in ctype:
                base = _parse_html(str(res.url), res.text[:120000])
            elif ctype.startswith("image/"):
                base["image"] = str(res.url)
                base["title"] = Path(urlparse(str(res.url)).path).name or base.get("title")
        cache[url] = base
        _save_cache(cache)
    except Exception:
        cache[url] = base
        try:
            _save_cache(cache)
        except Exception:
            pass
    return base


def preview_for_message(text: str | None, extracted: str | None, stored: dict | None = None) -> dict | None:
    urls = normalize_urls(text)
    url = primary_url(text, extracted)
    if url and url not in urls:
        urls = [url, *urls]
    if not url:
        return None
    instant = instant_preview(url) or {}
    merged = _merge_preview(instant, stored if isinstance(stored, dict) else None)
    merged["url"] = url
    merged["urls"] = urls or [url]
    if merged.get("title"):
        merged["title"] = html_unescape(str(merged["title"]))
    return merged
