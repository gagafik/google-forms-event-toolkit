# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0.0] - 2026-04-02

### Added
- `Code.gs` — core `onFormSubmit` trigger with `LockService.getDocumentLock()` per-form concurrency, batch Sheets read/write, Forms API option removal, fail-open on lock timeout, and EventLog archiving (1 000-row cap → `EventLog_archive`)
- `Billing.gs` — LemonSqueezy license key activation (UUID regex gate + HTTP validation), `isPaidUser()`, freemium enforcement (1 form/month with lazy monthly reset), `getFreemiumStatus()`, `getLicenseInfo()`
- `Alerts.gs` — threshold email alerts at 75 %, 90 %, and 100 % fill; single-cell write dedup via `Alert75Sent`/`Alert90Sent`/`Alert100Sent` columns; fails silently
- `Onboarding.gs` — `saveSlotConfig()` upsert by `(FormId, QuestionId, OptionText)`, `_ensureFormSubmitTrigger()` dedup guard, `deleteSlotConfig()` with orphan-trigger cleanup, `resetSlotUsed()`, `onAddonUninstall()` with "Clear data" path
- `Sidebar.html` — 3-step onboarding wizard, slot cards with progress bars, "Add slot" form, Account tab with freemium usage bar + LemonSqueezy checkout + license activation, "Clear data" button for pre-uninstall cleanup; XSS-safe `data-*` attribute pattern for option text in buttons
- `appsscript.json` — add-on manifest with OAuth scopes (forms, spreadsheets, script.scriptapp, userinfo.email, script.external_request, script.send_mail)
- `README.md` — clasp setup, GitHub Actions CI/CD workflow, data model reference, known limitations
