-- EUR-407: DataForSEO is removed. Drop stored credentials and refuse the provider.
DELETE FROM "ApiKey" WHERE "provider" = 'dataforseo';

ALTER TABLE "ApiKey"
  ADD CONSTRAINT "ApiKey_provider_not_dataforseo"
  CHECK ("provider" <> 'dataforseo');
