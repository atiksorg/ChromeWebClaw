# 🦞 WebClaw

> **An autonomous AI agent that lives in a hidden browser tab and drives any website by sight.**

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/placeholder)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/yourusername/webclaw)]()

---

[![WebClaw](https://wl.atiks.org/helpers/webclaw/webclaw_logo.jpg)](WebClaw)

## 🎬 Demo

![WebClaw Demo](demo.gif)

*Watch WebClaw automatically apply to 15 jobs on hh.ru in under 2 minutes*

---

## ⚡ Quick Start (30 seconds)

### 1. Install
```bash
# Clone the repo
git clone https://github.com/yourusername/webclaw.git

# Open Chrome → chrome://extensions
# Enable "Developer mode"
# Click "Load unpacked" → select the `extension/` folder
```

### 2. Configure
Create a GitHub Gist with your settings:
```json
{
  "auth_token": "your_protalk_token",
  "user_email": "you@example.com",
  "model": "xiaomi/mimo-v2.5",
  "step_cap": 200
}
```

In extension Settings → paste the Gist raw URL.

### 3. Use
1. Click the 🦞 icon in Chrome toolbar
2. Choose a **Quick Action** or type your task
3. Click **▶ Start**
4. Watch the magic happen!

---

## 🆚 Why WebClaw?

| Feature | WebClaw | OpenAI Operator | browser-use | Skyvern |
|---------|---------|-----------------|-------------|---------|
| **Open Source** | ✅ MIT | ❌ Closed | ✅ Apache | ✅ AGPL |
| **BYO Model** | ✅ Any | ❌ GPT-4o only | ✅ Any | ⚠️ Limited |
| **Works Offline** | ✅ Local API | ❌ Cloud-only | ⚠️ Needs LLM API | ❌ Cloud-only |
| **Price** | 🆓 Free | $200/mo | 🆓 Free | 🆓 Free tier |
| **Vision + DOM** | ✅ Both | ✅ Vision only | ⚠️ DOM only | ✅ Both |
| **Multi-tab** | ✅ Parallel | ❌ Single | ❌ Single | ❌ Single |
| **Session Export** | ✅ Markdown | ❌ No | ❌ No | ❌ No |
| **Preset Tasks** | ✅ 6 built-in | ❌ Manual | ❌ Manual | ❌ Manual |

---

## 🎯 Use Cases

### 💼 Auto-Apply to Jobs
```text
"Apply to all suitable jobs on this page using my resume"
```
WebClaw will:
- Scan job listings
- Match with your experience
- Auto-fill applications
- Skip jobs requiring login

### 📧 Extract Emails
```text
"Extract all email addresses from this page"
```

### 🛒 Add All to Cart
```text
"Add all items to cart on this shopping page"
```

### 📝 Fill Forms
```text
"Fill out this registration form with my details"
```

### 📸 Screenshot & Summarize
```text
"Take screenshots of each section and summarize the page"
```

### 👁️ Monitor Changes
```text
"Monitor this page for price changes every 30 seconds"
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Chrome Extension                         │
├─────────────────────────────────────────────────────────────┤
│  popup.html     ──→  UI controls, presets, export            │
│  background.js  ──→  State machine, API calls, badge         │
│  agent.html     ──→  Hidden tab with iframe                  │
│  content.js     ──→  DOM interaction (click, type, scroll)   │
│  settings.js    ──→  Multi-source config (local/gist/sync)   │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   AI Vision Model                            │
│  • Screenshot → "What do I see?"                            │
│  • DOM snapshot → "What elements exist?"                    │
│  • Task + History → "What should I do next?"                │
│  • Response → JSON action (click/type/scroll/navigate)      │
└─────────────────────────────────────────────────────────────┘
```

**Key Design Decisions:**
- **Dedicated Agent Tab**: Runs in background, doesn't interrupt your work
- **Frame-based injection**: content.js runs inside the iframe, not the parent page
- **Screenshot + DOM**: Model sees both the visual layout and structured element data
- **Gist-based config**: Settings survive extension reinstalls

---

## ⚙️ Settings

### Remote Config (Recommended)

Create a GitHub Gist with your settings:

```json
{
  "auth_token": "your_token_here",
  "user_email": "you@example.com",
  "model": "xiaomi/mimo-v2.5",
  "temperature": 0.2,
  "reasoning": "low",
  "step_cap": 200,
  "user_context": "My name is John, I'm a senior developer with 10 years of experience..."
}
```

**Why Gist?**
- ✅ Survives extension reinstalls
- ✅ Sync across devices
- ✅ Version history
- ✅ Works offline (cached locally)

### Supported Models

| Model | Speed | Quality | Cost |
|-------|-------|---------|------|
| `xiaomi/mimo-v2.5` | ⚡ Fast | ⭐⭐⭐ | Free |
| `openai/gpt-4o` | 🐢 Slow | ⭐⭐⭐⭐⭐ | $$ |
| `anthropic/claude-3.5-sonnet` | 🐢 Slow | ⭐⭐⭐⭐ | $$ |
| `google/gemini-2.0-flash` | ⚡ Fast | ⭐⭐⭐⭐ | $ |

---

## 🔒 Privacy

- **Your data stays local**: All processing happens in your browser
- **No telemetry**: We don't track you
- **Screenshots are ephemeral**: Sent to AI model, then deleted
- **Open source**: Audit the code yourself

---

## 🛠️ Development

### Project Structure
```
webclaw/
├── extension/
│   ├── manifest.json          # Chrome extension manifest
│   ├── icons/                 # Extension icons
│   └── src/
│       ├── popup.html/js      # Popup UI
│       ├── background.js      # Service worker (state machine)
│       ├── agent.html/js      # Hidden tab with iframe
│       ├── content.js         # DOM interaction scripts
│       ├── settings.js        # Multi-source settings
│       ├── remote_config.js   # Gist/URL config fetcher
│       └── logs.html/js       # Full-screen log viewer
├── README.md
├── LICENSE
├── CONTRIBUTING.md
└── docs/
    ├── architecture.md
    └── templates.md
```

### Build & Test
```bash
# No build step needed! Just load unpacked in Chrome.

# To test:
1. Make changes
2. Go to chrome://extensions
3. Click "Reload" on WebClaw
4. Test in browser
```

### Adding New Actions

1. **Define action in prompt** (`background.js` → `buildAgentPrompt`)
2. **Handle in content.js** (add `case` in message listener)
3. **Execute in background.js** (`performAction` function)

---

## 📝 Templates

### Template Format

```yaml
name: "Auto-apply to hh.ru"
description: "Automatically apply to all suitable jobs"
task: "Apply to all jobs that match my experience"
context: |
  I'm a senior developer with 10 years experience in:
  - Python, JavaScript, TypeScript
  - React, Node.js, Django
  - AWS, Docker, Kubernetes
  
  Desired salary: 300k RUB/month
  Location: Moscow or remote
steps:
  - action: scroll
    direction: down
  - action: wait
    selector: ".vacancy-card"
  - action: click
    selector: ".vacancy-card:first-child"
```

### Community Templates

Browse templates at [github.com/yourusername/webclaw/templates](templates/)

---

## 🤝 Contributing

We love contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Ways to Contribute
- 🐛 **Report bugs**: Open an issue
- 💡 **Suggest features**: Start a discussion
- 📝 **Add templates**: Submit a PR
- 🌍 **Translate**: Help with i18n
- ⭐ **Star the repo**: Show your support!

---

## 📄 License

MIT License — see [LICENSE](LICENSE)

---

## 🙏 Acknowledgments

- [ProTalk](https://pro-talk.ru) for the async AI API
- [Chrome Extensions](https://developer.chrome.com/docs/extensions/) documentation
- The open-source community for inspiration

---

## 📬 Contact

- **Issues**: [GitHub Issues](https://github.com/yourusername/webclaw/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/webclaw/discussions)
- **Twitter**: [@yourusername](https://twitter.com/yourusername)

---

**Made with 🦞 by the WebClaw team**
