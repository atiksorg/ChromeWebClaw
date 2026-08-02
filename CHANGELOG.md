# Changelog

All notable changes to WebClaw will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2024-01-XX

### Added
- 🎨 **Complete UI Redesign**: Modern dark theme with better UX
- ⚡ **6 Quick Preset Tasks**: One-click automation for common tasks
  - Auto-apply to jobs
  - Extract emails
  - Add all to cart
  - Fill forms
  - Screenshot & summarize
  - Monitor changes
- 📥 **Session Export**: Download session as Markdown
  - Activity log with timestamps
  - Action details
  - Success/failure tracking
- 🦞 **WebClaw Branding**: Renamed from ProTalk Chrome Claw
- 📖 **Professional README**: Landing page with demos and comparisons
- 📝 **Documentation**: CONTRIBUTING.md, LICENSE, CHANGELOG

### Changed
- ⬆️ **Version bump**: 1.1.0 → 2.0.0
- 🌐 **Language**: UI switched to English for global audience
- 🎯 **Better Quick Actions**: Improved preset task descriptions

### Improved
- 🎨 **Visual feedback**: Hover effects on preset buttons
- 📊 **Export format**: Clean Markdown tables
- 🔧 **Error messages**: More descriptive error handling

## [1.1.0] - 2024-01-XX

### Added
- 🏠 **Dedicated Agent Tab**: Hidden tab with iframe for background operation
- 📊 **Status Badge**: Real-time status indicator (idle/working/paused/error)
- ⏸️ **Pause/Resume**: Ability to pause and continue agent
- 📜 **Full-screen Logs**: Dedicated logs page with filtering
- ⚙️ **Remote Config**: GitHub Gist integration for persistent settings
- 🔑 **User Context**: Resume, contacts, cover letter support
- 🧪 **Dry-run Mode**: Preview actions without execution
- ⌨️ **Hotkey**: Alt+Shift+A to start/stop

### Actions
- 🧭 **navigate**: Direct URL navigation
- ⬅️ **back**: History back navigation
- 📄 **extract**: Extract text/html from selectors
- ⏳ **wait_url**: Wait for URL to contain substring

### Improved
- 🔄 **Exponential backoff**: Better retry logic for API errors
- 🎯 **Frame ID discovery**: Auto-detect iframe after navigation
- 🔍 **Auto-focus**: Refocus agent tab when needed
- 📍 **Navigation tracking**: WebNavigation listener for redirects

## [1.0.0] - 2024-01-XX

### Initial Release
- 🤖 **Vision-driven agent**: Screenshot + DOM analysis
- 🎯 **Action execution**: Click, type, scroll, wait
- 🔧 **Settings management**: Local storage with sync
- 📊 **Activity logging**: Real-time step tracking

---

## Roadmap

### Coming Soon
- 🔄 **Multi-tab Parallel Agents**: Run on multiple URLs simultaneously
- 📦 **Templates Repository**: YAML-based task templates
- 🔌 **Plugin System**: Custom selectors for specific sites
- 🌐 **WebSocket API**: External integration (n8n, Make, Zapier)
- 🖥️ **Self-hosted Server**: Headless mode with FastAPI

### Future Vision
- 📱 **Mobile Support**: Control from phone
- 🎓 **Agent Marketplace**: Community-contributed agents
- 🤖 **Multi-model Support**: Switch between AI providers
- 📊 **Analytics Dashboard**: Track automation success rates
