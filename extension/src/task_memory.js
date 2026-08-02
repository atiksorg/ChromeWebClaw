// task_memory.js — Structured session memory for planning-capable agent.
//
// Unlike history[] (which is a rolling log of last N actions), task memory
// is a persistent, structured store that survives the entire session:
//   - Planner's output (criteria, action template, irreversibility flag)
//   - Candidate list with per-item statuses
//   - User context (resume, contacts) — never trimmed
//   - Phase tracking (planning → extracting → filtering → confirming → executing → done)
//   - Progress counters (processed, succeeded, failed, skipped)
//
// Task memory is passed into the model prompt on every executor step,
// giving the model full context without relying on action history.

export const PHASES = {
  IDLE:        'idle',
  PLANNING:    'planning',
  EXTRACTING:  'extracting',
  FILTERING:   'filtering',
  CONFIRMING:  'confirming',
  EXECUTING:   'executing',
  DONE:        'done'
};

const ITEM_STATUSES = {
  PENDING:    'pending',
  PROCESSING: 'processing',
  DONE:       'done',
  FAILED:     'failed',
  SKIPPED:    'skipped'
};

export class TaskMemory {
  constructor() {
    this.reset();
  }

  reset() {
    this.phase = PHASES.IDLE;
    this.taskType = 'simple';       // 'simple' | 'batch'
    this.plan = null;                // Planner output { steps, criteria, actionTemplate, requiresConfirmation }
    this.items = [];                 // Candidate list: [{ id, url, title, status, error?, result? }]
    this.userContext = '';            // Resume, contacts, templates
    this.errors = [];                // [{ itemId, error, phase }]
    this.startedAt = 0;
    this.completedAt = 0;
    this.searchPageUrl = '';          // URL of the search/listing page (for self-healing navigation)
    this.searchPageTitle = '';        // Title of the search/listing page
    this.scratchpad = [];             // Scratchpad notes: persistent facts saved across pages
  }

  // ---- Phase management ----

  setPhase(phase) {
    this.phase = phase;
    if (phase === PHASES.DONE) {
      this.completedAt = Date.now();
    }
  }

  // ---- Plan management ----

  setPlan(plan) {
    this.plan = plan;
    this.taskType = (plan && plan.type === 'batch') ? 'batch' : 'simple';
  }

  // ---- User context ----

  setUserContext(ctx) {
    this.userContext = ctx || '';
  }

  // ---- Scratchpad management ----

  addNote(note) {
    if (!note) return;
    const noteStr = typeof note === 'string' ? note : JSON.stringify(note);
    if (!this.scratchpad.includes(noteStr)) {
      this.scratchpad.push(noteStr);
    }
  }

  addNotes(notesList) {
    if (!Array.isArray(notesList)) return;
    notesList.forEach(note => this.addNote(note));
  }

  getScratchpadText() {
    if (this.scratchpad.length === 0) return '';
    return 'AGENT\'S SCRATCHPAD (saved facts from previous pages):\n' + this.scratchpad.map(n => `- ${n}`).join('\n');
  }

  // ---- Item management ----

  addItem(item) {
    const id = item.id || `item_${this.items.length + 1}`;
    this.items.push({
      id,
      url: item.url || '',
      title: item.title || '',
      selector: item.selector || '',
      status: ITEM_STATUSES.PENDING,
      error: null,
      result: null,
      data: item.data || null   // extra structured data (price, email, etc.)
    });
    return id;
  }

  addItems(itemsList) {
    return itemsList.map(item => this.addItem(item));
  }

  updateItemStatus(itemId, status, error, result) {
    const item = this.items.find(i => i.id === itemId);
    if (!item) return false;
    item.status = status;
    if (error !== undefined) item.error = error;
    if (result !== undefined) item.result = result;
    return true;
  }

  removeItem(itemId) {
    const idx = this.items.findIndex(i => i.id === itemId);
    if (idx >= 0) {
      this.items.splice(idx, 1);
      return true;
    }
    return false;
  }

  skipItem(itemId) {
    return this.updateItemStatus(itemId, ITEM_STATUSES.SKIPPED);
  }

  getItemsByStatus(status) {
    return this.items.filter(i => i.status === status);
  }

  getNextPending() {
    return this.items.find(i => i.status === ITEM_STATUSES.PENDING) || null;
  }

  // ---- Progress ----

  getProgress() {
    const total = this.items.length;
    const done = this.items.filter(i => i.status === ITEM_STATUSES.DONE).length;
    const failed = this.items.filter(i => i.status === ITEM_STATUSES.FAILED).length;
    const skipped = this.items.filter(i => i.status === ITEM_STATUSES.SKIPPED).length;
    const processing = this.items.filter(i => i.status === ITEM_STATUSES.PROCESSING).length;
    const pending = this.items.filter(i => i.status === ITEM_STATUSES.PENDING).length;
    const processed = done + failed + skipped;
    return { total, done, failed, skipped, processing, pending, processed };
  }

  // ---- Serialize for model prompt ----

  /**
   * Build a text block that gets injected into executor/step prompts.
   * Includes plan, candidate list, progress — everything the model needs.
   */
  toPromptContext() {
    const parts = [];

    if (this.plan) {
      parts.push(`TASK PLAN:
- Type: ${this.taskType}
- Goal: ${this.plan.goal || '(not specified)'}
- Criteria: ${JSON.stringify(this.plan.criteria || {})}
- Action template: ${JSON.stringify(this.plan.actionTemplate || {})}
- Requires confirmation: ${this.plan.requiresConfirmation ? 'YES' : 'NO'}`);
    }

    if (this.userContext) {
      parts.push(`USER CONTEXT:\n"""\n${this.userContext}\n"""`);
    }

    // Add scratchpad notes if any
    const scratchpadText = this.getScratchpadText();
    if (scratchpadText) {
      parts.push(scratchpadText);
    }

    if (this.items.length > 0) {
      const progress = this.getProgress();
      const itemLines = this.items.slice(0, 50).map((item, i) => {
        const extras = [];
        if (item.url) extras.push(`url=${item.url}`);
        if (item.title) extras.push(`title="${item.title}"`);
        if (item.selector) extras.push(`sel=${item.selector}`);
        if (item.error) extras.push(`err="${item.error}"`);
        if (item.data) extras.push(`data=${JSON.stringify(item.data)}`);
        return `  ${i + 1}. [${item.status}] ${item.id} ${extras.join(' | ')}`;
      });
      parts.push(`CANDIDATES (${progress.processed}/${progress.total} processed, ${progress.failed} failed, ${progress.skipped} skipped):
${itemLines.join('\n')}`);
    }

    return parts.join('\n\n');
  }

  // ---- Summary report ----

  getReport() {
    const p = this.getProgress();
    const elapsed = this.completedAt ? this.completedAt - this.startedAt : Date.now() - this.startedAt;
    const errors = this.items
      .filter(i => i.error)
      .map(i => ({ id: i.id, error: i.error }));

    return {
      phase: this.phase,
      taskType: this.taskType,
      elapsed,
      ...p,
      errors
    };
  }

  // ---- Serialization for message passing (popup/status) ----

  toStatusPayload() {
    const p = this.getProgress();
    return {
      phase: this.phase,
      taskType: this.taskType,
      progress: p,
      itemCount: this.items.length,
      planGoal: this.plan?.goal || null,
      requiresConfirmation: this.plan?.requiresConfirmation || false,
      pendingItems: this.getItemsByStatus(ITEM_STATUSES.PENDING).map(i => ({
        id: i.id,
        url: i.url,
        title: i.title,
        data: i.data
      }))
    };
  }
}
