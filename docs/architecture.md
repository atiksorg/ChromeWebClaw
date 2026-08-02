# Architecture

## Overview

WebClaw is a Chrome extension that uses AI vision to autonomously interact with websites. It runs in a dedicated background tab, captures screenshots, and executes actions based on AI decisions.

## Components

### 1. Popup (popup.html/js)
- User interface for task input
- Preset tasks for quick actions
- Real-time status display
- Session export functionality

### 2. Background Service Worker (background.js)
- State machine managing agent lifecycle
- API calls to AI model
- Badge updates and notifications
- Log fan-out to multiple listeners

### 3. Agent Tab (agent.html/js)
- Dedicated hidden tab for agent operations
- Contains iframe for target website
- Address bar for URL control
- Status indicator

### 4. Content Script (content.js)
- DOM interaction layer
- Element snapshot for AI
- Action execution (click, type, scroll)
- Runs in iframe context

### 5. Settings (settings.js)
- Multi-source configuration
- Priority: Local > Gist > Sync storage
- Remote config support via GitHub Gist

## Data Flow

```
User Input → Popup → Background Service Worker
                         ↓
                    AI Model API
                         ↓
                    Screenshot + DOM Snapshot
                         ↓
                    AI Decision (JSON action)
                         ↓
                    Content Script Execution
                         ↓
                    Result Observation
                         ↓
                    Next Iteration or Done
```

## Key Design Decisions

### 1. Dedicated Agent Tab
- **Why**: CaptureVisibleTab works on active tab, agent needs to stay active
- **Benefit**: User can work on other tabs while agent runs

### 2. Frame-based Injection
- **Why**: Content script runs inside iframe, not parent page
- **Benefit**: Better isolation, avoids conflicts with host page

### 3. Screenshot + DOM Hybrid
- **Why**: Model sees both visual layout and structured elements
- **Benefit**: More accurate element identification

### 4. Gist-based Config
- **Why**: Settings survive extension reinstalls
- **Benefit**: Cross-device sync, version history

## API Integration

### ProTalk Async API
```javascript
// Create task
POST https://ai.pro-talk.ru/api/async/router
{
  "base_url": "https://openrouter.ai/api/v1/chat/completions",
  "model": "xiaomi/mimo-v2.5",
  "messages": [...],
  "stream": false
}

// Poll task
GET https://ai.pro-talk.ru/api/async/router/{taskId}
```

### Retry Logic
- Exponential backoff for 429/5xx errors
- Max 4 attempts per request
- Timeout: 5 minutes per poll cycle

## Security Considerations

### Permissions
- `activeTab`: Access to current tab (user-initiated)
- `tabs`: Create/manage agent tab
- `storage`: Persist settings
- `scripting`: Inject content scripts
- `webNavigation`: Track iframe navigation

### Data Handling
- Screenshots sent to AI, then discarded
- Settings stored locally (sync via Gist)
- No telemetry or tracking

### Secret Storage
- `auth_token` and `api_key` are stored **only** in `chrome.storage.local` (device-local, never synced to Google Account)
- Remote config (Gist) is **never** allowed to import secrets
- No CORS proxy fallback for config fetch (prevents key leakage to third-party proxies)

### DNR Session Rules (Iframe Header Bypass)
- X-Frame-Options and CSP headers are stripped **only** from sub_frames inside the dedicated agent tab
- Rules are scoped via `tabIds: [agentTabId]` — all other user tabs are unaffected
- Session rules are automatically removed when the agent stops

## Performance Optimizations

### Element Snapshot
- Limit to 120 interactive elements
- Filter invisible elements
- Compact CSS selectors

### Screenshot Quality
- PNG format for clarity
- Capture only visible tab
- Refocus on "No window" errors

### History Management
- Keep last 10 actions
- Truncate long observations
- Efficient JSON serialization

## Long-Running Process Monitoring (v3.1)

### Problem
Long-running operations (file uploads, data processing, AI generation) previously caused the agent to burn API calls on every step — the model would observe "still loading" dozens of times, wasting tokens and time.

### Solution: Local Polling Engine
A new `wait_for_completion` action delegates monitoring to `content.js` without AI calls:

```
Model sees spinner → emits wait_for_completion → content.js monitors locally → 
result/timeout/error → model called once for next decision
```

### Supported Condition Types

| Type | Description | Example |
|------|-------------|---------|
| `selector_disappear` | Element vanishes or becomes invisible | Spinner stops |
| `selector_appear` | Element becomes visible | Result container appears |
| `progress` | Numeric attribute reaches target | `aria-valuenow` hits 100 |
| `text_appear` | Text appears in page body | "Complete" shown |
| `url_change` | URL contains substring | Redirect to results |

> Note: Network idle detection is handled separately in `background.js` via CDP `Network` domain events and is used in `waitPageReady()` before each agent step, not as a `wait_for_completion` condition.

### Implementation Details

**MutationObserver** (primary sensor):
- Subscribed to `document.body` with `childList: true, subtree: true`
- For `progress` conditions: also watches `attributes` with specific `attributeFilter`
- Debounced (100ms) to let DOM settle before checking
- Zero CPU when DOM is idle

**Adaptive Polling** (fallback + URL change):
- Intervals: 500ms → 500ms → 1s → 1s → 2s → 2s → 3s → 5s (capped)
- Primary for `url_change` (no DOM mutation to observe)
- Fallback for MutationObserver edge cases

**Error Detection** (short-circuit):
- Watches for `[role="alert"]`, `.error`, `.alert-danger`, `.toast-error`
- Matches against: error, failed, failure, ошибка, не удалось, something went wrong
- Immediately fails the wait with error details

**Progress Stall Detection**:
- Tracks `aria-valuenow` (or custom attribute)
- If value unchanged for 10 consecutive polls → reports stall
- Returns `{ stalled: true, value, target }` for model decision

### UI States During Waiting
The agent tab shows a distinct visual state:
- **Badge**: Blue (#0ea5e9) with step count
- **Status dot**: Pulsing blue animation (`dot.waiting`)
- **Status text**: "waiting: [condition summary]"

### Economic Impact
- **Before**: N API calls during wait (each = screenshot + DOM + model)
- **After**: 1 API call at start + 1 at completion/error
- **Savings**: ~95% reduction in API costs for long-running operations

## Session Logging & HTML Reports (v4.1)

### Overview
The agent captures a complete session log including screenshots, API calls, actions, and observations. Two export formats are available:

1. **HTML Report** — visual timeline with persistent screenshot URLs, collapsible API call details, and error summary
2. **API Log (text)** — raw CURL commands + responses for debugging

### Architecture

```
Agent Loop (each step)
  ├── captureScreenshot() → base64 data URL
  ├── callModelWithBackoff() → providers.js logs CURL + response via sessionLogger
  ├── performAction() → observation
  └── sessionLogger.logStep() → screenshotDataUrl, pageInfo, prompt, response, action, observation
                                    │
                                    └── _queueScreenshotUpload() (async, non-blocking)
                                            │
                                            ▼
                                  file.pro-talk.ru/ptrn
                                            │
                                            ▼
                                  persistent URL stored in step.screenshotUrl
```

### Screenshot Upload
- **API**: `POST https://file.pro-talk.ru/ptrn` with `X-Upload-Token` header
- **Token**: Non-confidential, hardcoded in `session_logger.js`
- **Behavior**: Uploads happen asynchronously in the background during the agent loop. Each screenshot is queued and uploaded one at a time to avoid overwhelming the API.
- **Fallback**: If upload fails, the HTML report uses inline base64 data URLs as fallback (screenshots still display, just not as persistent links).

### CURL Logging
Every AI API call is logged with:
- Full CURL command (with masked auth tokens)
- Request body (with base64 images replaced by placeholders)
- Raw response body (full JSON)
- HTTP status code
- Response duration in milliseconds

### HTML Report Structure
```
┌─ Summary Cards (steps, API calls, screenshots, errors, duration)
├─ Task Context (collapsible)
├─ Steps Timeline (collapsible per-step)
│   ├── Screenshot (clickable, lightbox)
│   ├── Page URL
│   ├── Parsed Action
│   ├── Raw Model Response
│   └── Observation
├─ API Calls (collapsible per-call)
│   ├── CURL Command (green, copy-pasteable)
│   ├── Request Body
│   └── Raw Response
├─ Errors (if any)
└─ Footer
```

### Message Bus Integration
```
popup → { kind: 'export_html_report' } → background.js → sessionLogger.downloadHtmlReport()
popup → { kind: 'export_api_log' }    → background.js → sessionLogger.downloadApiLog()
```

### Data Flow
- `providers.js` → `sessionLogger.logApiCall()` after each model API call
- `background.js` → `sessionLogger.logStep()` after each agent step
- `batch_executor.js` → `sessionLogger.logStep()` for each batch item
- `sessionLogger.complete()` → called when agent finishes
- `sessionLogger.waitForUploads()` → waits up to 30s for pending screenshot uploads

## Extension Points

### Adding New Actions
1. Define in `buildAgentPrompt()` (background.js)
2. Handle in `performAction()` (background.js)
3. Implement in content.js message listener

### Custom Templates
```yaml
name: "Template Name"
task: "Task description"
context: "Additional context"
steps:
  - action: click
    selector: ".button"
```

### Remote Config Sources
- GitHub Gist (recommended)
- Any CORS-enabled JSON endpoint
- Proxied through corsproxy.io if needed
