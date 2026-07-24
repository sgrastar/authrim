-- Normalize legacy Chinese locale keys to the BCP 47 tags used by LoginUI.

UPDATE screens
SET localizations_json = json_set(
  json_remove(localizations_json, '$.zh_CN'),
  '$."zh-CN"',
  json(json_extract(localizations_json, '$.zh_CN'))
)
WHERE localizations_json IS NOT NULL
  AND json_type(localizations_json, '$.zh_CN') IS NOT NULL;

UPDATE screens
SET localizations_json = json_set(
  json_remove(localizations_json, '$.zh_TW'),
  '$."zh-TW"',
  json(json_extract(localizations_json, '$.zh_TW'))
)
WHERE localizations_json IS NOT NULL
  AND json_type(localizations_json, '$.zh_TW') IS NOT NULL;
