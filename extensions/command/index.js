// Core extension: plain shell command cron job. The simplest possible
// extension — no output handler, no settings, no concurrency cap.
export default {
  id: 'command',
  name: 'Shell command',
  icon: '＄',
  description: 'Run a shell command on a schedule (zsh login shell).',
  fields: [
    { key: 'command', label: 'Command', type: 'textarea', rows: 2, required: true, placeholder: 'e.g. git -C ~/repo pull' },
  ],
  command(job) {
    return { cmd: '/bin/zsh', args: ['-lc', job.params.command] };
  },
};
