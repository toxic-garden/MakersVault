from typing import List, Optional
from pydantic import BaseModel


class AssetCreate(BaseModel):
  title: Optional[str] = None
  notes: Optional[str] = None
  tags: List[str] = []


class ImportRequest(BaseModel):
  url: str
  title: Optional[str] = None
  notes: Optional[str] = None
  tags: List[str] = []
  folder_id: Optional[str] = None
  filename: Optional[str] = None
  makerworld_cookie: Optional[str] = None
  thingiverse_cookie: Optional[str] = None


class ImportInspectOut(BaseModel):
  filename: str
  mime: str
  is_zip: bool


class ZipEntryOut(BaseModel):
  path: str
  size: int


class ImportZipEntriesRequest(ImportRequest):
  pass


class ImportZipEntriesOut(BaseModel):
  filename: str
  entries: List[ZipEntryOut]


class ImportZipExtractRequest(ImportRequest):
  entries: List[str]


class AssetOut(BaseModel):
  id: str
  filename: str
  mime: str
  size: int
  title: Optional[str]
  notes: Optional[str]
  source_url: Optional[str]
  tags: List[str]
  url: str
  thumb_url: Optional[str]
  folder_id: Optional[str]
  thumb_eligible: bool = False


class ImportZipResult(BaseModel):
  assets: List[AssetOut]
  failed: List[str] = []


class FolderIn(BaseModel):
  name: str
  tags: List[str] = []
  parent_id: Optional[str] = None


class FolderOut(BaseModel):
  id: str
  name: str
  tags: List[str]
  parent_id: Optional[str]


class LoginRequest(BaseModel):
  username: str
  password: str


class LoginResponse(BaseModel):
  token: str
  expires_in: int


class DownloadRequest(BaseModel):
  asset_ids: Optional[List[str]] = None
  tag: Optional[str] = None
  folder_id: Optional[str] = None
  filename: Optional[str] = None


class TagUpdate(BaseModel):
  tags: List[str]


class AssetMetaUpdate(BaseModel):
  title: Optional[str] = None
  notes: Optional[str] = None
  source_url: Optional[str] = None


class AssetRename(BaseModel):
  filename: str


class AssetFolderUpdate(BaseModel):
  folder_id: Optional[str] = None


class MountImportSettings(BaseModel):
  enabled: bool
  copy_files: bool


class MountImportSettingsOut(MountImportSettings):
  path: Optional[str] = None


class AiSettingsOut(BaseModel):
  endpoint: str
  api_key_set: bool
  model: str
  max_tags: int
  json_mode: bool
  review_mode: bool
  auto_tag: bool


class AiSettingsUpdate(BaseModel):
  endpoint: str = ""
  api_key: Optional[str] = None
  model: str = ""
  max_tags: int = 10
  json_mode: bool = True
  review_mode: bool = True
  auto_tag: bool = False


class AiTagResult(BaseModel):
  asset_id: str
  ok: bool
  tags: List[str] = []
  applied: bool = False
  error: Optional[str] = None


class AiTagSingleOut(BaseModel):
  asset: AssetOut
  tags: List[str]
  applied: bool


class AiTagBatchOut(BaseModel):
  results: List[AiTagResult]
  failed: int


class AiTestOut(BaseModel):
  ok: bool
  error: Optional[str] = None


class AssetIdList(BaseModel):
  asset_ids: List[str]
