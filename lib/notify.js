import { execFile } from 'node:child_process';

export function shouldNotify(setting, status) {
  if (setting === 'never') return false;
  if (setting === 'always') return true;
  return status === 'fail' || status === 'timeout'; // 'failure'
}

export function notify(title, message) {
  if (process.env.CS_NO_NOTIFY === '1') return;
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFile('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`], () => {});
}
