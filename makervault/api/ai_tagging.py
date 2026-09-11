import base64
import json
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from sqlmodel import Session

import httpx

from db import THUMBS, engine
from models import Asset
from settings_service import get_bool_setting, get_setting, set_bool_setting, set_setting

AI_ENDPOINT_KEY = "ai_endpoint"
AI_API_KEY_KEY = "ai_api_key"
AI_MODEL_KEY = "ai_model"
AI_MAX_TAGS_KEY = "ai_max_tags"
AI_JSON_MODE_KEY = "ai_json_mode"
AI_REVIEW_MODE_KEY = "ai_review_mode"
AI_AUTO_TAG_KEY = "ai_auto_tag"

DEFAULT_ENDPOINT = "http://localhost:11434/v1"
DEFAULT_MODEL = ""
DEFAULT_MAX_TAGS = 10
REQUEST_TIMEOUT_SECONDS = 120

MAX_FILENAME_TAGS = 4

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
_JSON_OBJECT_RE = re.compile(r"\{[\s\S]*\}")
_GENERIC_TAG_RE = re.compile(r"^(model|models|3d|3dprint|3dprinting|object|item|thing|stuff|piece|image|picture|tag|tags|keyword|keywords|file|part)$")


@dataclass
class AiSettings:
  endpoint: str
  model: str
  max_tags: int
  json_mode: bool
  review_mode: bool
  auto_tag: bool
  api_key_set: bool


@dataclass
class AssetView:
  """Minimal detached asset view for tag generation outside a session."""

  id: str
  filename: str


class AiTagError(Exception):
  """User-presentable AI tagging failure."""


def get_ai_settings() -> AiSettings:
  return AiSettings(
    endpoint=(get_setting(AI_ENDPOINT_KEY) or DEFAULT_ENDPOINT).strip(),
    model=(get_setting(AI_MODEL_KEY) or DEFAULT_MODEL).strip(),
    max_tags=_parse_max_tags(get_setting(AI_MAX_TAGS_KEY)),
    json_mode=get_bool_setting(AI_JSON_MODE_KEY, True),
    review_mode=get_bool_setting(AI_REVIEW_MODE_KEY, True),
    auto_tag=get_bool_setting(AI_AUTO_TAG_KEY, False),
    api_key_set=bool((get_setting(AI_API_KEY_KEY) or "").strip()),
  )


def _parse_max_tags(raw: Optional[str]) -> int:
  try:
    value = int(raw or "")
  except (TypeError, ValueError):
    return DEFAULT_MAX_TAGS
  return max(1, min(50, value))


def save_ai_settings(
  endpoint: str,
  api_key: Optional[str],
  model: str,
  max_tags: int,
  json_mode: bool,
  review_mode: bool,
  auto_tag: bool,
) -> AiSettings:
  set_setting(AI_ENDPOINT_KEY, (endpoint or "").strip() or DEFAULT_ENDPOINT)
  if api_key is not None:
    set_setting(AI_API_KEY_KEY, api_key.strip())
  set_setting(AI_MODEL_KEY, (model or "").strip())
  set_setting(AI_MAX_TAGS_KEY, str(_parse_max_tags(str(max_tags))))
  set_bool_setting(AI_JSON_MODE_KEY, json_mode)
  set_bool_setting(AI_REVIEW_MODE_KEY, review_mode)
  set_bool_setting(AI_AUTO_TAG_KEY, auto_tag)
  return get_ai_settings()


# Tag hygiene ---------------------------------------------------------------

def normalize_tag(tag: Any) -> str:
  if not isinstance(tag, str):
    return ""
  normalized = tag.lower().strip()
  normalized = re.sub(r"[^\w\s-]", "", normalized, flags=re.UNICODE)
  normalized = re.sub(r"\s+", " ", normalized).strip()
  normalized = re.sub(r"^3d\s+model$", "", normalized)
  return normalized


def is_tag_valid(tag: str) -> bool:
  if not tag or len(tag) < 2 or len(tag) > 50:
    return False
  if _GENERIC_TAG_RE.match(tag):
    return False
  return True


def deduplicate_tags(tags: List[str]) -> List[str]:
  result: List[str] = []
  for tag in tags:
    if tag in result:
      continue
    duplicate = next(
      (existing for existing in result if tag in existing or existing in tag),
      None,
    )
    if duplicate is not None:
      if len(tag) < len(duplicate):
        result[result.index(duplicate)] = tag
      continue
    result.append(tag)
  return result


def parse_tags_from_response(content: str, max_tags: int, json_mode: bool) -> List[str]:
  if not content:
    return []
  cleaned = _THINK_RE.sub("", content).strip()
  if not cleaned:
    return []
  cleaned = cleaned.strip("`")
  if cleaned.startswith("json"):
    cleaned = cleaned[4:].strip()
  tags: List[str] = []
  if json_mode:
    tags = _parse_json_tags(cleaned)
  if not tags:
    tags = _parse_text_tags(cleaned)
  cleaned_tags = [t for t in (normalize_tag(tag) for tag in tags) if t and is_tag_valid(t)]
  return deduplicate_tags(cleaned_tags)[:max_tags]


def _parse_json_tags(content: str) -> List[str]:
  match = _JSON_OBJECT_RE.search(content)
  if match:
    try:
      parsed = json.loads(match.group(0))
    except ValueError:
      parsed = None
    if isinstance(parsed, dict):
      for value in ("tags", "keywords", "labels"):
        if isinstance(parsed.get(value), list):
          return [t for t in parsed[value] if isinstance(t, str)]
    if isinstance(parsed, list):
      return [t for t in parsed if isinstance(t, str)]
  return []


def _parse_text_tags(content: str) -> List[str]:
  if "," in content:
    return [part.strip() for part in content.split(",") if part.strip()]
  if "\n" in content:
    return [part.strip() for part in content.splitlines() if part.strip()]
  return [content.strip()] if content.strip() else []


# Prompt --------------------------------------------------------------------

def build_tag_prompt(filename: str, max_tags: int) -> str:
  keywords = extract_keywords_from_filename(filename)
  prompt = (
    f"You are helping organize a 3D printing and maker file library. "
    f"Generate up to {max_tags} useful category tags for this file so users can find and organize it. "
  )
  if keywords:
    prompt += (
      f'The filename is "{filename}" and contains these keywords: {", ".join(keywords)}. '
      "Use a keyword as a tag when it matches what the model actually shows. "
    )
  prompt += (
    "Focus ONLY on the object itself - ignore backgrounds, text, or UI elements. "
    'Do NOT use generic terms like "3D Model", "model", "object", "item", "thing", "tag" or "piece". '
    "Use simple, general category tags a person would search for "
    '(examples: "toy", "dragon", "bracket", "vase", "organizer", "gear", "figure", "mount"). '
    "Prefer single words; compound tags only when they add real meaning. "
    "Lowercase, no punctuation."
  )
  return prompt


def extract_keywords_from_filename(filename: str) -> List[str]:
  if not filename:
    return []
  name = filename.replace("\\", "/").split("/")[-1]
  name = name.rsplit(".", 1)[0]
  words = re.sub(r"([a-z])([A-Z])", r"\1 \2", name)
  parts = [p.strip() for p in re.split(r"[-_\s.]+", words) if len(p.strip()) > 2]
  parts = [p for p in parts if not p.isdigit()][:MAX_FILENAME_TAGS]
  unique: List[str] = []
  for part in parts:
    lowered = part.lower()
    if lowered not in unique:
      unique.append(lowered)
  return unique


JSON_RESPONSE_INSTRUCTIONS = (
  'You MUST respond with ONLY a valid JSON object in the exact format '
  '{"tags": ["tag1", "tag2"]}. No explanations, no markdown, no code fences. '
  'If you cannot identify the object, return {"tags": []}. '
)


# LLM call ------------------------------------------------------------------

def _chat_payload(
  prompt: str,
  image_data_url: str,
  model: str,
  max_tokens: int,
  json_mode: bool,
) -> Dict[str, Any]:
  payload: Dict[str, Any] = {
    "model": model,
    "messages": [
      {
        "role": "user",
        "content": [
          {"type": "text", "text": prompt},
          {"type": "image_url", "image_url": {"url": image_data_url}},
        ],
      }
    ],
    "temperature": 0.3,
    "max_tokens": max_tokens,
  }
  if json_mode:
    payload["response_format"] = {"type": "json_object"}
  return payload


def call_chat_completions(
  base_url: str,
  api_key: str,
  payload: Dict[str, Any],
  timeout: float = REQUEST_TIMEOUT_SECONDS,
) -> str:
  base = (base_url or "").strip().rstrip("/")
  if not base:
    raise AiTagError("No AI endpoint configured")
  url = f"{base}/chat/completions"
  headers = {"Content-Type": "application/json"}
  if api_key:
    headers["Authorization"] = f"Bearer {api_key}"
  try:
    response = httpx.post(url, json=payload, headers=headers, timeout=timeout)
  except httpx.TimeoutException:
    raise AiTagError("AI endpoint timed out")
  except httpx.HTTPError as exc:
    raise AiTagError(f"Could not reach AI endpoint: {exc.__class__.__name__}")
  if response.status_code in (401, 403):
    raise AiTagError("AI endpoint rejected the API key (401/403)")
  if response.status_code == 429:
    raise AiTagError("AI endpoint rate limit exceeded (429)")
  if response.status_code >= 400:
    detail = ""
    try:
      detail = response.json().get("error", {}).get("message", "")
    except Exception:
      detail = response.text[:200]
    raise AiTagError(f"AI endpoint error {response.status_code}: {detail or 'unknown error'}")
  try:
    data = response.json()
  except ValueError:
    raise AiTagError("AI endpoint returned invalid JSON")
  return extract_message_content(data)


def extract_message_content(data: Dict[str, Any]) -> str:
  choices = data.get("choices") or []
  if not choices:
    return ""
  message = choices[0].get("message") or {}
  content = message.get("content")
  if isinstance(content, str):
    return content
  if isinstance(content, list):
    parts = []
    for part in content:
      if isinstance(part, dict):
        text = part.get("text")
        if isinstance(text, str):
          parts.append(text)
    return "\n".join(parts)
  return ""


# Asset pipeline ------------------------------------------------------------

def asset_image_data_url(asset: "AssetView") -> Optional[str]:
  """Base64 data URL of the asset thumbnail, or None when no thumb exists."""
  for ext, mime in ((".png", "image/png"), (".jpg", "image/jpeg")):
    thumb = THUMBS / f"{asset.id}{ext}"
    if thumb.exists():
      try:
        raw = thumb.read_bytes()
        if raw:
          return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"
      except OSError:
        continue
  return None


def generate_tags_for_asset(asset: "AssetView") -> List[str]:
  """Call the configured LLM with the asset thumbnail; returns cleaned tags.

  Accepts any object with `id` and `filename` attributes (SQLModel Asset or
  AssetView snapshot).
  """
  settings = get_ai_settings()
  if not settings.model:
    raise AiTagError("No AI model configured")
  image_data_url = asset_image_data_url(asset)
  if not image_data_url:
    raise AiTagError("Asset has no thumbnail to analyze")
  prompt = build_tag_prompt(asset.filename or "", settings.max_tags)
  if settings.json_mode:
    prompt += JSON_RESPONSE_INSTRUCTIONS
  payload = _chat_payload(
    prompt=prompt,
    image_data_url=image_data_url,
    model=settings.model,
    max_tokens=1000 if settings.json_mode else 300,
    json_mode=settings.json_mode,
  )
  content = call_chat_completions(settings.endpoint, _get_api_key(), payload)
  if not content or not content.strip():
    raise AiTagError("AI endpoint returned an empty response")
  return parse_tags_from_response(content, settings.max_tags, settings.json_mode)


def test_ai_connection() -> bool:
  """Minimal text-only chat call; raises AiTagError on failure."""
  settings = get_ai_settings()
  if not settings.model:
    raise AiTagError("No AI model configured")
  payload = {
    "model": settings.model,
    "messages": [{"role": "user", "content": "ping"}],
    "max_tokens": 5,
  }
  call_chat_completions(settings.endpoint, _get_api_key(), payload, timeout=30)
  return True


def _get_api_key() -> str:
  return (get_setting(AI_API_KEY_KEY) or "").strip()


# Merge & auto-tag ----------------------------------------------------------

def apply_tags(asset_id: str, tags: List[str], mode: str) -> Asset:
  """mode: 'replace' | 'merge'. Returns the refreshed Asset."""
  with Session(engine) as s:
    asset = s.get(Asset, asset_id)
    if not asset:
      raise AiTagError("Asset not found")
    if mode == "replace":
      merged = list(dict.fromkeys(tags))
    else:
      existing = json.loads(asset.tags_json or "[]")
      merged = list(dict.fromkeys(existing + [t for t in tags if t not in existing]))
    asset.tags_json = json.dumps(merged)
    s.add(asset)
    s.commit()
    s.refresh(asset)
    return asset


def maybe_autotag_asset(asset_id: str, filename: str) -> None:
  """Fire-and-forget auto tagging for freshly uploaded assets.

  Runs in its own thread; only acts when auto-tagging is enabled, the asset
  has no tags yet, and a thumbnail exists. Failures are swallowed.
  """
  def _run() -> None:
    try:
      if not get_bool_setting(AI_AUTO_TAG_KEY, False):
        return
      with Session(engine) as s:
        asset = s.get(Asset, asset_id)
        if asset is None:
          return
        existing = json.loads(asset.tags_json or "[]")
      if existing:
        return
      view = AssetView(id=asset_id, filename=filename)
      if asset_image_data_url(view) is None:
        return
      tags = generate_tags_for_asset(view)
      if tags:
        apply_tags(asset_id, tags, "merge")
    except Exception:
      return

  threading.Thread(target=_run, daemon=True).start()


def asset_view(asset_id: str, filename: str) -> AssetView:
  return AssetView(id=asset_id, filename=filename)