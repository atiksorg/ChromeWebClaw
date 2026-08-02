# Contributing to WebClaw

Thanks for your interest in contributing! 🎉

## 🚀 Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/webclaw.git`
3. Create a branch: `git checkout -b feature/amazing-feature`
4. Make your changes
5. Test thoroughly
6. Commit: `git commit -m 'feat: add amazing feature'`
7. Push: `git push origin feature/amazing-feature`
8. Open a Pull Request

## 🐛 Reporting Bugs

### Before Submitting a Bug Report
- Check the [existing issues](https://github.com/yourusername/webclaw/issues)
- Make sure you're using the latest version

### How to Submit a Good Bug Report
1. Use the [Bug Report template](https://github.com/yourusername/webclaw/issues/new?template=bug.md)
2. Include:
   - Extension version
   - Chrome version
   - Steps to reproduce
   - Expected vs actual behavior
   - Screenshots (if applicable)
   - Console errors (F12 → Console)

## 💡 Suggesting Features

1. Check [existing feature requests](https://github.com/yourusername/webclaw/issues?q=is%3Aissue+is%3Aopen+label%3Afeature)
2. Open a [Feature Request](https://github.com/yourusername/webclaw/issues/new?template=feature.md)
3. Explain:
   - The problem you're trying to solve
   - Your proposed solution
   - Alternatives considered

## 📝 Code Style

### JavaScript
- Use ES modules (`import/export`)
- Prefer `const` over `let`
- Use descriptive variable names
- Add comments for complex logic

### Commit Messages
Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new preset task for LinkedIn
fix: handle cross-origin iframe errors
docs: update README quickstart section
style: format popup.css
refactor: simplify state management
test: add unit tests for content.js
chore: update dependencies
```

## 🧪 Testing

### Manual Testing
1. Load unpacked extension in Chrome
2. Test each feature:
   - Preset tasks
   - Manual task input
   - Export functionality
   - Settings persistence
3. Test on multiple websites
4. Test pause/resume

### Test Checklist
- [ ] Extension loads without errors
- [ ] Settings save and restore correctly
- [ ] Preset tasks populate fields
- [ ] Agent starts and stops correctly
- [ ] Export generates valid Markdown
- [ ] Logs display correctly

## 📁 Project Structure

```
webclaw/
├── extension/
│   ├── manifest.json       # Extension manifest
│   ├── src/
│   │   ├── popup.html/js   # Popup UI
│   │   ├── background.js   # Service worker
│   │   ├── agent.html/js   # Hidden tab
│   │   ├── content.js      # DOM interaction
│   │   ├── settings.js     # Settings management
│   │   └── remote_config.js # Remote config fetcher
│   └── icons/              # Extension icons
├── templates/              # Task templates
├── docs/                   # Documentation
└── server/                 # Optional self-hosted server
```

## 🎯 Areas Where Help is Needed

### High Priority
- 🐛 Bug fixes
- 📝 Documentation improvements
- 🌍 Translations (i18n)

### Medium Priority
- 🧪 Automated testing
- 📊 Performance optimization
- 🎨 UI/UX improvements

### Future Features
- 🔌 Plugin system
- 🌐 WebSocket API
- 📱 Mobile support

## 📄 License

By contributing, you agree that your contributions will be licensed under the MIT License.

## 🙏 Thank You!

Your contributions make WebClaw better for everyone!
