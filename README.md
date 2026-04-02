# Form Event Toolkit — Google Forms Add-on

Automatically limit registrations per option in Google Forms. When a slot fills up, the option is removed from the form without any manual intervention.

---

## Features

- **Slot limiting**: Set a max number of registrations per multiple-choice or checkbox option
- **Auto-removal**: When a slot fills up, the option disappears from the live form automatically
- **Email alerts**: Get notified at 75%, 90%, and 100% capacity
- **Concurrency-safe**: Uses `LockService.getDocumentLock()` per form — handles 150+ simultaneous submissions without miscounts
- **Fail-open**: If a lock times out (rare), the submission is accepted and the event is logged — no silent failures
- **Freemium**: 1 form/month free, unlimited forms on paid plan ($5/mo or $40/yr)

---

## Project structure

```
google-forms-event-toolkit/
├── appsscript.json   — Add-on manifest (OAuth scopes, triggers)
├── Code.gs           — Core trigger: onFormSubmit, LockService, Sheets I/O
├── Billing.gs        — LemonSqueezy license validation, freemium enforcement
├── Alerts.gs         — Threshold email alerts (75/90/100%)
├── Onboarding.gs     — Sidebar entry points, slot CRUD, trigger management
├── Sidebar.html      — Vanilla JS sidebar UI (wizard + config + account)
└── README.md         — This file
```

---

## Local development setup

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [clasp](https://github.com/google/clasp) — Google Apps Script CLI
- A Google account with Apps Script enabled

### 1. Install clasp

```bash
npm install -g @google/clasp
clasp login
```

### 2. Clone and link

```bash
git clone https://github.com/YOUR_USERNAME/google-forms-event-toolkit.git
cd google-forms-event-toolkit
```

Either create a new Apps Script project:

```bash
clasp create --type addon --title "Form Event Toolkit"
```

Or link to an existing project:

```bash
# Edit .clasp.json and set scriptId to your existing project ID
```

### 3. Push code to Apps Script

```bash
clasp push
```

### 4. Open in browser

```bash
clasp open
```

---

## Testing locally

Since Apps Script runs server-side, local unit tests mock the Google APIs. The test suite uses [Jest](https://jestjs.io/) with a custom GAS mock layer.

```bash
npm install
npm test
```

Key test scenarios:
- Single submission with 1 limited choice → DECREMENT
- Submission when slot is already full → ALREADY_FULL (idempotent)
- Slot reaching limit → REMOVED (Forms API called, Removed=true set)
- Forms API error → API_ERROR, Removed reset to false
- Lock timeout → LOCK_TIMEOUT logged, fail-open
- Duplicate trigger guard → only 1 trigger created per form

---

## Deploying to Google Workspace Marketplace

### 1. Configure billing

In `Billing.gs`, replace the placeholder constants with your real LemonSqueezy URLs:

```javascript
var LEMONSQUEEZY_CHECKOUT_URL = 'https://app.lemonsqueezy.com/checkout/buy/YOUR_PRODUCT_ID';
var LEMONSQUEEZY_VALIDATE_URL = 'https://api.lemonsqueezy.com/v1/licenses/validate';
```

### 2. Create a versioned deployment

In the Apps Script editor:
- **Deploy → New deployment**
- Type: **Add-on**
- Description: e.g. `v1.0.0`
- Click **Deploy** → copy the Deployment ID

Or via clasp:

```bash
clasp deploy --description "v1.0.0"
```

### 3. Publish to Workspace Marketplace

1. Go to [Google Workspace Marketplace SDK](https://console.cloud.google.com/apis/api/appsmarket-component.googleapis.com)
2. Enable the Marketplace SDK for your Cloud project
3. Fill in listing details: name, description, screenshots, OAuth scopes
4. Set the deployment ID from step 2
5. Submit for review

**Marketplace listing keywords** (for discoverability):
- choice eliminator
- form limiter
- slot booking google forms
- event registration google forms
- limit form responses

---

## CI/CD with GitHub Actions

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy to Apps Script

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
      - run: npm install -g @google/clasp
      - name: Write clasp credentials
        run: echo '${{ secrets.CLASP_CREDENTIALS }}' > ~/.clasprc.json
      - name: Push to Apps Script
        run: clasp push --force
      - name: Create deployment
        run: clasp deploy --description "Auto-deploy $(git rev-parse --short HEAD)"
```

Set `CLASP_CREDENTIALS` secret in GitHub with the contents of `~/.clasprc.json` after running `clasp login`.

---

## Data model

### FormConfig sheet (one tab per form: `FormConfig_<formId>`)

| Column | Type | Description |
|---|---|---|
| FormId | string | Google Form ID |
| QuestionId | string | Form item ID |
| OptionText | string | Exact option text |
| SlotLimit | number | Maximum registrations |
| SlotUsed | number | Current count |
| Removed | boolean | Whether option has been removed from form |
| Alert75Sent | boolean | 75% alert sent |
| Alert90Sent | boolean | 90% alert sent |
| Alert100Sent | boolean | 100% alert sent |
| AdminEmail | string | Email for alerts (optional) |

### EventLog sheet (shared: `EventLog`)

| Column | Description |
|---|---|
| Timestamp | When the event occurred |
| FormId | Google Form ID |
| Action | DECREMENT / REMOVED / API_ERROR / LOCK_TIMEOUT / ALREADY_FULL / UNEXPECTED_ERROR |
| QuestionId | Form item ID |
| OptionText | Option text |
| SlotBefore | SlotUsed before this event |
| SlotAfter | SlotUsed after this event |
| LockStatus | ACQUIRED / TIMEOUT |
| Notes | Error message if applicable |

EventLog is capped at 1,000 rows. Oldest 500 rows are moved to `EventLog_archive` automatically.

---

## Known limitations

- **Lock timeout**: Apps Script `LockService.tryLock()` waits up to 10 seconds. If all slots in a queue time out, those submissions are accepted fail-open (slot not decremented). In practice this means 1–3 registrations may exceed the limit during a surge. This is disclosed during setup.
- **Trigger quota**: Google Apps Script allows ~20,000 trigger executions/day on free Workspace. For high-volume events (>800 submissions/hour across all forms), each user should deploy their own script copy for dedicated quota.
- **±60 second trigger firing**: Time-based triggers (Phase 2 feature) fire within 60 seconds of the configured time — not exactly on the second.

---

## License

MIT
