-- Normalize legacy Chinese locale keys to the BCP 47 tags used by LoginUI.

UPDATE screens
SET localizations_json = (localizations_json - 'zh_CN')
  || jsonb_build_object('zh-CN', localizations_json -> 'zh_CN')
WHERE localizations_json ? 'zh_CN';

UPDATE screens
SET localizations_json = (localizations_json - 'zh_TW')
  || jsonb_build_object('zh-TW', localizations_json -> 'zh_TW')
WHERE localizations_json ? 'zh_TW';
