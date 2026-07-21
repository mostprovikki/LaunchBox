// Extension template — copy this directory to extensions/<your-id>/ and edit.
// Directories starting with '_' are ignored by the loader, so renaming the
// copy is what activates it. Restart the daemon to pick it up.
export default {
  // Unique id: stored in job.type; changing it later orphans existing jobs.
  id: 'my-agent',
  name: 'My agent',
  icon: '🧩',
  description: 'One-line blurb shown in the job dialog.',

  // Job form fields (stored in job.params, validated server-side).
  // Types: text | textarea | select | number | checkbox.
  // Common keys: label, required, default, placeholder, rows (textarea),
  // options [{value,label}] (select), min/max (number),
  // advanced: true → rendered inside the Advanced section.
  fields: [
    { key: 'task', label: 'Task', type: 'textarea', rows: 3, required: true, placeholder: 'What should the agent do?' },
    { key: 'flags', label: 'Extra flags', type: 'text', default: '', advanced: true },
  ],

  // Extension-scoped settings (Settings tab). Stored in the shared settings
  // table — prefix keys with your id to avoid collisions with other extensions.
  settings: [
    { key: 'my-agent:binPath', label: 'my-agent binary path', type: 'text', default: 'my-agent', required: true },
  ],

  // Optional: cap concurrent runs of this type; extra runs queue FIFO.
  // concurrency: { settingKey: 'my-agent:maxConcurrent', default: 2 },

  // Optional: extra validation beyond the field specs. Return error strings.
  // validate(params) { return params.task.includes('rm -rf') ? ['no.'] : []; },

  // Optional: one-time boot hook (detect binaries, seed settings…).
  // init({ getSetting, setSetting }) {},

  // Required: how to spawn a run. `setting(key, default)` reads settings.
  command(job, { setting }) {
    return { cmd: setting('my-agent:binPath', 'my-agent'), args: [job.params.task] };
  },

  // Optional: parse the child's stdout into log lines + live progress.
  // Omit entirely for raw line-by-line logging.
  // createOutputHandler({ onLine, onProgress, onMeta }) {
  //   return {
  //     write(chunk) { onLine(String(chunk).trimEnd()); onProgress({ text: 'working' }); },
  //     flush() {},
  //   };
  //   // onMeta({ someKey: value }) persists to run.meta — drives runActions below.
  // },

  // Optional: per-run buttons in the log drawer. Shown when run.meta has
  // `requiresRunMeta`; exec runs server-side.
  // runActions: [
  //   { id: 'open', label: 'Open report', requiresRunMeta: 'reportPath',
  //     exec({ run, job, setting, execFileFn }) { …; return { ok: true }; } },
  // ],
};
