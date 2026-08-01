// The declarative shot list.
//
// Every DOM selector the capture uses lives in THIS FILE. After a UI overhaul,
// this is the only file you should need to touch: the runner reports which
// shots failed and why, and each failure points at the selector that moved.
//
// A shot is { file, desc, phase, fullPage?, setup? }.
//   phase 'empty'   — runs before seeding, for zero-state screens
//   phase 'main'    — the bulk, against seeded data
//   phase 'global'  — last, because these mutate app-wide state (pause modes)
// setup(page, ctx) prepares the screen; throwing marks that one shot failed and
// the run continues. ctx = { api, ids, liveRunId, drainRunId, baseUrl }.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Switch tab via the hash router and let it render. */
async function tab(page, name) {
  await page.eval((n) => { location.hash = '#' + n; }, name);
  await sleep(700);
  await page.eval(() => window.scrollTo(0, 0));
}

/** Wait until a predicate evaluated in the page turns true. */
async function until(page, fn, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.eval(fn)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function closeOverlays(page) {
  await page.eval(() => {
    document.querySelector('#log-close')?.click();
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    const m = document.querySelector('#awake-menu');
    if (m) m.hidden = true;
  });
  await sleep(250);
}

/** Open the run-log drawer for the first history row matching `text`. */
async function openLogFor(page, text) {
  await page.eval((t) => {
    const row = [...document.querySelectorAll('#runs-list .item')]
      .find((r) => r.textContent.includes(t));
    if (!row) throw new Error(`no history row containing "${t}"`);
    row.querySelector('[data-act="log"]').click();
  }, text);
  await until(page, () => !document.querySelector('#log-drawer')?.hidden, 'the log drawer to open');
  await sleep(1200); // let the log body paint / start tailing
}

async function setStatusFilter(page, status) {
  await page.eval((s) => {
    const chip = [...document.querySelectorAll('[data-status]')].find((b) => b.dataset.status === s);
    if (!chip) throw new Error(`no status chip for "${s}"`);
    chip.click();
  }, status);
  await sleep(600);
}

async function pause(page, label) {
  await page.withDialog('accept', async () => {
    await page.eval((l) => {
      const btn = [...document.querySelectorAll('#pause-seg button')]
        .find((b) => b.textContent.trim() === l);
      if (!btn) throw new Error(`no pause button "${l}"`);
      btn.click();
    }, label);
  });
  await sleep(1400);
}

export const shots = [
  // ---------------------------------------------------------------- empty ---
  {
    file: 'jobs-empty', phase: 'empty',
    desc: 'Jobs tab with no jobs yet — "Create your first job"',
    async setup(page) {
      await tab(page, 'jobs');
      await until(page, () => !document.querySelector('#jobs-empty')?.hidden, 'the empty state');
    },
  },
  {
    file: 'projects-empty', phase: 'empty',
    desc: 'Projects tab with nothing registered and no projectRoots set',
    async setup(page) { await tab(page, 'projects'); },
  },
  {
    file: 'settings-default', phase: 'empty',
    desc: 'Settings at first boot, before any demo values are written',
    fullPage: true,
    async setup(page) { await tab(page, 'settings'); },
  },

  // ----------------------------------------------------------------- jobs ---
  {
    file: 'jobs-populated', phase: 'main',
    desc: 'Jobs list: mixed statuses, usage banner, running badge',
    async setup(page) {
      await tab(page, 'jobs');
      await until(page, () => document.querySelectorAll('#jobs-list .item').length > 5, 'job rows');
    },
  },
  {
    file: 'jobs-populated-fullpage', phase: 'main', fullPage: true,
    desc: 'Every job row including the three claude jobs',
    async setup(page) { await tab(page, 'jobs'); },
  },
  {
    file: 'jobs-live-run', phase: 'main',
    desc: 'A row mid-run: pulsing "running" with wind-down + stop-now controls',
    async setup(page) {
      await tab(page, 'jobs');
      await until(
        page,
        () => [...document.querySelectorAll('#jobs-list .item')]
          .some((r) => r.querySelector('.stop-btn')),
        'a job row showing live-run controls',
      );
    },
  },
  {
    file: 'jobs-filter-match', phase: 'main',
    desc: 'Filter box narrowing the list',
    async setup(page) {
      await tab(page, 'jobs');
      await page.eval(() => {
        const el = document.querySelector('#job-search');
        el.value = 'quota';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await sleep(400);
    },
  },
  {
    file: 'jobs-filter-no-match', phase: 'main',
    desc: '"No jobs match your filter."',
    async setup(page) {
      await tab(page, 'jobs');
      await page.eval(() => {
        const el = document.querySelector('#job-search');
        el.value = 'zzz-no-such-job';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await sleep(400);
    },
    async teardown(page) {
      await page.eval(() => {
        const el = document.querySelector('#job-search');
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    },
  },

  // -------------------------------------------------------------- history ---
  {
    file: 'history-all', phase: 'main',
    desc: 'Run history across every seeded status, incl. a budget-guard skip reason',
    async setup(page) {
      await tab(page, 'history');
      await until(page, () => document.querySelectorAll('#runs-list .item').length > 5, 'run rows');
    },
  },
  {
    file: 'history-fullpage', phase: 'main', fullPage: true,
    desc: 'The whole run list',
    async setup(page) { await tab(page, 'history'); },
  },
  {
    file: 'history-filter-active', phase: 'main',
    desc: 'History filtered to Active',
    async setup(page) { await tab(page, 'history'); await setStatusFilter(page, 'active'); },
  },
  {
    file: 'history-filter-failed', phase: 'main',
    desc: 'History filtered to Failed',
    async setup(page) { await tab(page, 'history'); await setStatusFilter(page, 'fail'); },
  },
  {
    file: 'history-filter-stopped', phase: 'main',
    desc: 'History filtered to Stopped',
    async setup(page) { await tab(page, 'history'); await setStatusFilter(page, 'stopped'); },
  },
  {
    file: 'history-empty', phase: 'main',
    desc: '"No runs match." — a job that has never run',
    async setup(page, ctx) {
      await tab(page, 'history');
      await setStatusFilter(page, '');
      await page.eval((id) => {
        const sel = document.querySelector('#history-job');
        sel.value = id;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }, ctx.ids.flaky);
      await sleep(700);
    },
    async teardown(page) {
      await page.eval(() => {
        const sel = document.querySelector('#history-job');
        sel.value = '';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
    },
  },
  {
    file: 'history-winding-down', phase: 'main',
    desc: 'A run asked to wind down: "stopping…" chip, wind-down button withdrawn',
    async setup(page) {
      await tab(page, 'history');
      await until(
        page,
        () => document.querySelector('#runs-list')?.textContent.includes('stopping'),
        'a row showing the stopping… chip',
      );
    },
  },

  // ----------------------------------------------------------- log drawer ---
  {
    file: 'log-drawer-live', phase: 'main',
    desc: 'Live log tail (SSE) with Wind down + Stop now',
    async setup(page) {
      await tab(page, 'history');
      await setStatusFilter(page, 'active');
      await openLogFor(page, 'Rotate and ship logs');
    },
    teardown: closeOverlays,
  },
  {
    file: 'log-drawer-failed', phase: 'main',
    desc: 'A finished failure, with stderr in the body',
    async setup(page) {
      await tab(page, 'history');
      await setStatusFilter(page, 'fail');
      await openLogFor(page, 'Backup to NAS');
    },
    teardown: closeOverlays,
  },
  {
    file: 'log-drawer-timeout', phase: 'main',
    desc: 'A timed-out run, including the SIGTERM line',
    async setup(page) {
      await tab(page, 'history');
      await setStatusFilter(page, '');
      await openLogFor(page, 'Sync design tokens');
    },
    teardown: closeOverlays,
  },
  {
    file: 'log-drawer-winding-down', phase: 'main',
    desc: 'Already ringing: Stop now offered, Wind down withdrawn',
    async setup(page) {
      await tab(page, 'history');
      await setStatusFilter(page, 'active');
      await openLogFor(page, 'Drain message queue');
    },
    teardown: closeOverlays,
  },

  // --------------------------------------------------------- job dialogs ---
  {
    file: 'dialog-new-job-claude', phase: 'main',
    desc: 'New job, Claude type, Advanced collapsed',
    async setup(page) {
      await tab(page, 'jobs');
      await page.eval(() => document.querySelector('#new-job').click());
      await until(page, () => document.querySelector('#job-dialog')?.open, 'the job dialog');
      await sleep(400);
    },
    teardown: closeOverlays,
  },
  {
    file: 'dialog-new-job-claude-advanced', phase: 'main',
    desc: 'Advanced open: model, permissions, extra CLI args, budget guard',
    async setup(page) {
      await tab(page, 'jobs');
      await page.eval(() => {
        document.querySelector('#new-job').click();
        document.querySelector('#advanced').open = true;
      });
      await sleep(500);
      await page.eval(() => {
        const d = document.querySelector('#job-dialog');
        d.scrollTop = d.scrollHeight;
      });
      await sleep(300);
    },
    teardown: closeOverlays,
  },
  {
    file: 'dialog-new-job-command', phase: 'main',
    desc: 'New job, Shell command type — one Command field, no extension advanced fields',
    async setup(page) {
      await tab(page, 'jobs');
      await page.eval(() => {
        document.querySelector('#new-job').click();
        [...document.querySelectorAll('#f-type button')]
          .find((b) => b.textContent.includes('Shell')).click();
      });
      await sleep(500);
    },
    teardown: closeOverlays,
  },
  {
    file: 'dialog-schedule-builder', phase: 'main',
    desc: 'Four schedule rows in four different preset shapes at once',
    async setup(page) {
      await tab(page, 'jobs');
      await page.eval(() => {
        document.querySelector('#new-job').click();
        const add = document.querySelector('#add-sched');
        add.click(); add.click(); add.click();
        const rows = [...document.querySelectorAll('#sched-rows .sched-row')];
        const set = (row, preset) => {
          const s = row.querySelector('.sr-preset');
          s.value = preset;
          s.dispatchEvent(new Event('change', { bubbles: true }));
        };
        set(rows[0], 'weekdays');
        set(rows[1], 'hours');
        set(rows[2], 'reset');
        set(rows[3], 'custom');
      });
      await sleep(700);
    },
    teardown: closeOverlays,
  },
  {
    file: 'dialog-validation-errors', phase: 'main',
    desc: 'Server-side validation panel on save',
    async setup(page) {
      await tab(page, 'jobs');
      await page.eval(() => {
        document.querySelector('#new-job').click();
        const d = document.querySelector('#job-dialog');
        d.querySelector('#f-name').value = 'Archive old artifacts';
        const cmd = [...d.querySelectorAll('textarea')].find((t) => t.required);
        if (cmd) cmd.value = 'tar -czf /backup/artifacts.tgz ./dist';
        d.querySelector('#f-cwd').value = '/does/not/exist';
        d.querySelector('#job-form').requestSubmit();
      });
      await until(page, () => !document.querySelector('#form-errors')?.hidden, 'the error panel');
      await page.eval(() => { document.querySelector('#job-dialog').scrollTop = 0; });
      await sleep(300);
    },
    teardown: closeOverlays,
  },
  {
    file: 'dialog-edit-job', phase: 'main',
    desc: 'Edit an existing claude job, Advanced open and populated',
    async setup(page) {
      await tab(page, 'jobs');
      await page.eval(() => {
        const row = [...document.querySelectorAll('#jobs-list .item')]
          .find((r) => r.textContent.includes('Flaky test hunter'));
        if (!row) throw new Error('no "Flaky test hunter" row');
        row.querySelector('[data-act="edit"]').click();
      });
      await until(page, () => document.querySelector('#job-dialog')?.open, 'the edit dialog');
      await page.eval(() => { document.querySelector('#advanced').open = true; });
      await sleep(500);
    },
    teardown: closeOverlays,
  },

  // -------------------------------------------------------- burn-down ------
  {
    file: 'dialog-plan-burndown', phase: 'main',
    desc: 'Plan burn-down, initial state with the job picker',
    async setup(page) {
      await tab(page, 'jobs');
      await page.eval(() => document.querySelector('#plan-burndown').click());
      await until(page, () => document.querySelector('#plan-dialog')?.open, 'the plan dialog');
      await sleep(400);
    },
    teardown: closeOverlays,
  },
  {
    file: 'dialog-plan-burndown-preview', phase: 'main',
    desc: 'A previewed plan: confidence, reasoning, slot table, confirm button (never clicked)',
    async setup(page) {
      await tab(page, 'jobs');
      await page.eval(() => {
        document.querySelector('#plan-burndown').click();
        // The weekly window is the safer target: the 5-hour one refuses to plan
        // when it happens to be minutes from resetting.
        const w = document.querySelector('#p-window');
        w.value = 'seven_day';
        w.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#p-targetPct').value = '4';
        const boxes = [...document.querySelectorAll('#plan-dialog input[type="checkbox"]')];
        boxes.slice(0, 3).forEach((b) => {
          b.checked = true;
          b.dispatchEvent(new Event('change', { bubbles: true }));
        });
      });
      await sleep(400);
      await page.eval(() => document.querySelector('#plan-preview').click());
      await until(
        page,
        () => !document.querySelector('#plan-result')?.hidden
          || !document.querySelector('#plan-errors')?.hidden,
        'the plan to come back',
      );
      await page.eval(() => {
        const d = document.querySelector('#plan-dialog');
        d.scrollTop = d.scrollHeight;
      });
      await sleep(400);
    },
    teardown: closeOverlays,
  },

  // --------------------------------------------------------- projects -----
  {
    file: 'projects-populated', phase: 'main',
    desc: 'Three discovered repos, all pending / paused — none activated',
    async setup(page) {
      await tab(page, 'projects');
      await until(page, () => document.querySelectorAll('#projects-list .item, #projects-list > *').length > 1, 'project rows');
      await sleep(500);
    },
  },
  {
    file: 'projects-ready-beads', phase: 'main',
    desc: 'Ready-beads panel: id, priority, type and label pills from a real bd backlog',
    async setup(page) {
      await tab(page, 'projects');
      await page.eval(() => {
        const btn = [...document.querySelectorAll('#projects-list button')]
          .find((b) => b.textContent.includes('Ready'));
        if (!btn) throw new Error('no Ready… button');
        btn.click();
      });
      await sleep(3000);
    },
  },
  {
    file: 'projects-ready-all-fullpage', phase: 'main', fullPage: true,
    desc: 'All Ready panels open, showing the pending and paused row states',
    async setup(page) {
      await tab(page, 'projects');
      const n = await page.eval(() =>
        [...document.querySelectorAll('#projects-list button')]
          .filter((b) => b.textContent.includes('Ready')).length);
      for (let i = 0; i < n; i++) {
        await page.eval((idx) => {
          const btns = [...document.querySelectorAll('#projects-list button')]
            .filter((b) => b.textContent.includes('Ready'));
          const panelOpen = btns[idx]?.closest('.item, div')?.querySelector('.ready-panel');
          if (!panelOpen) btns[idx]?.click();
        }, i);
        await sleep(1500);
      }
      await sleep(1500);
    },
  },
  {
    file: 'dialog-burst', phase: 'main',
    desc: 'Burst dialog with its budget presets; picker empty because nothing is activated',
    async setup(page) {
      await tab(page, 'projects');
      await page.eval(() => document.querySelector('#project-burst').click());
      await until(page, () => document.querySelector('#burst-dialog')?.open, 'the burst dialog');
      await sleep(500);
    },
    teardown: closeOverlays,
  },

  // --------------------------------------------------------- sessions -----
  // Seeded via CS_SESSIONS_ROOT (capture.mjs -> seed.mjs's
  // buildFixtureSessions), never ~/.claude/projects. Visual language here is
  // deliberately not the rest of the app — docs/specs/2026-07-27-sessions-
  // tab-visual-design.md — so these two shots are the only place that new
  // language is captured.
  {
    file: 'sessions-populated', phase: 'main',
    desc: 'Sessions tab: chip-grid cards for the planted fixture transcripts',
    async setup(page) {
      await tab(page, 'sessions');
      await until(page, () => document.querySelectorAll('#sessions-list .s-card').length >= 4, 'session cards');
    },
  },
  {
    file: 'sessions-conversation', phase: 'main',
    desc: 'An open conversation: per-tool turns (Edit diff, TodoWrite before/after, Grep counts) expanded',
    async setup(page) {
      await tab(page, 'sessions');
      await until(page, () => document.querySelectorAll('#sessions-list .s-card').length >= 4, 'session cards');
      await page.eval(() => {
        const card = [...document.querySelectorAll('#sessions-list .s-card')]
          .find((c) => c.dataset.sessionId.includes('sess-basket-totals-refactor'));
        if (!card) throw new Error('no "sess-basket-totals-refactor" session card');
        card.querySelector('[data-act="convo"]').click();
      });
      await until(page, () => document.querySelector('#session-dialog')?.open, 'the transcript dialog');
      await sleep(500);
      await page.eval(() => {
        document.querySelectorAll('#session-transcript .t-tool .t-head').forEach((b) => b.click());
      });
      await sleep(400);
    },
    teardown: closeOverlays,
  },

  // --------------------------------------------------------- settings -----
  {
    file: 'settings-seeded', phase: 'main',
    desc: 'Settings with demo values: usage monitor, budget & reserve, task sources',
    async setup(page) { await tab(page, 'settings'); },
  },
  {
    file: 'settings-fullpage', phase: 'main', fullPage: true,
    desc: 'Every settings section in one image, Danger zone expanded',
    async setup(page) {
      await tab(page, 'settings');
      await page.eval(() => {
        const d = document.querySelector('details.danger');
        if (d) d.open = true;
      });
      await sleep(400);
    },
  },
  {
    file: 'settings-danger-zone', phase: 'main',
    desc: 'Danger zone expanded — cleanup and uninstall confirmations',
    async setup(page) {
      await tab(page, 'settings');
      await page.eval(() => {
        const d = document.querySelector('details.danger');
        if (d) d.open = true;
        window.scrollTo(0, document.body.scrollHeight);
      });
      await sleep(400);
    },
  },
  {
    file: 'settings-saved', phase: 'main',
    desc: 'The "saved ✓" acknowledgement',
    async setup(page) {
      await tab(page, 'settings');
      await page.eval(() => document.querySelector('#settings-form').requestSubmit());
      await until(
        page,
        () => document.querySelector('#settings-msg')?.textContent.includes('saved'),
        'the saved acknowledgement',
      );
      await page.eval(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(200);
    },
  },

  // ------------------------------------------------- header / global -----
  {
    file: 'usage-compact-chip', phase: 'main',
    desc: 'usageShow: compact — a header chip instead of the meter banner',
    async setup(page, ctx) {
      await ctx.api.put('/api/settings', { usageShow: 'compact' });
      await page.goto(ctx.baseUrl + '/#jobs');
      await sleep(1200);
    },
    async teardown(page, ctx) {
      await ctx.api.put('/api/settings', { usageShow: 'banner' });
      await page.goto(ctx.baseUrl + '/#jobs');
      await sleep(800);
    },
  },
  {
    file: 'keep-awake-menu', phase: 'main',
    desc: 'The ☕ keep-awake popover, all seven modes',
    async setup(page) {
      await tab(page, 'jobs');
      await page.eval(() => document.querySelector('#awake-btn').click());
      await until(page, () => !document.querySelector('#awake-menu')?.hidden, 'the awake menu');
      await sleep(300);
    },
    teardown: closeOverlays,
  },

  // These mutate app-wide state, so they go last. Hard pause kills live runs,
  // which is why it is the final shot of the run.
  {
    file: 'pause-hold', phase: 'global',
    desc: 'Hold: scheduled fires dropped, manual runs still allowed',
    async setup(page) { await tab(page, 'jobs'); await pause(page, 'Hold'); },
  },
  {
    file: 'pause-soft', phase: 'global',
    desc: 'Soft drain: nothing new starts, live work winds down',
    async setup(page) { await tab(page, 'jobs'); await pause(page, 'Soft'); },
  },
  {
    file: 'pause-hard', phase: 'global',
    desc: 'Hard stop: everything in flight killed immediately (red banner)',
    async setup(page) { await tab(page, 'jobs'); await pause(page, 'Hard'); },
  },
];
