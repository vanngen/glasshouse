let scheduledData = null;
let scheduledTimer = null;
let scheduledVisible = false;
let scheduledLoading = false;
let scheduledLoadGeneration = 0;
let scheduledAppsDirty = false;
let scheduledTimerDirty = false;
let scheduledSaving = false;

function scheduledMessage(text, bad = false) {
  q('scheduled-message').textContent = text;
  q('scheduled-message').classList.toggle('bad', bad);
}

function scheduledAppRow(action = { appId: '', delaySeconds: 20 }) {
  const row = document.createElement('div');
  row.className = 'scheduled-app-row';
  const select = document.createElement('select');
  select.className = 'pill-sel scheduled-app-select';
  select.setAttribute('aria-label', t('scheduled.app', 'App'));
  const apps = [...(scheduledData?.apps || [])].sort((a, b) => a.title.localeCompare(b.title));
  if (action.appId && !apps.some(a => a.id === action.appId)) apps.unshift({ id: action.appId, title: action.appId });
  const placeholder = document.createElement('option');
  placeholder.value = ''; placeholder.textContent = t('scheduled.choose', 'Choose an app');
  select.appendChild(placeholder);
  apps.forEach(app => {
    const option = document.createElement('option');
    option.value = app.id; option.textContent = app.title;
    select.appendChild(option);
  });
  select.value = action.appId;
  const label = document.createElement('label');
  label.className = 'scheduled-delay';
  const caption = document.createElement('span');
  caption.textContent = t('scheduled.delay', 'Seconds after wake');
  const delay = document.createElement('input');
  delay.type = 'number'; delay.min = '5'; delay.max = '600'; delay.step = '1';
  delay.required = true; delay.value = action.delaySeconds;
  delay.setAttribute('aria-label', t('scheduled.delay', 'Seconds after wake'));
  label.append(caption, delay);
  const remove = document.createElement('button');
  remove.type = 'button'; remove.textContent = t('common.remove', 'Remove');
  remove.addEventListener('click', () => { row.remove(); scheduledAppsDirty = true; });
  row.append(select, label, remove);
  row.addEventListener('input', () => { scheduledAppsDirty = true; });
  row.querySelectorAll('input, select, button').forEach(el => { el.disabled = !scheduledData.writable; });
  q('scheduled-apps-list').appendChild(row);
}

function renderScheduled(data) {
  scheduledData = data;
  q('scheduled-enabled').disabled = !data.writable;
  q('scheduled-add').disabled = !data.writable;
  q('scheduled-save').disabled = !data.writable || scheduledSaving;
  q('scheduled-timer-save').disabled = !data.writable || !data.timer || scheduledSaving;
  if (!scheduledAppsDirty) {
    q('scheduled-enabled').checked = data.settings.enabled;
    q('scheduled-apps-list').replaceChildren();
    data.settings.actions.forEach(scheduledAppRow);
  }
  if (!scheduledTimerDirty && data.timer) {
    q('scheduled-timer-enabled').checked = data.timer.enabled;
    q('scheduled-timer-time').value = data.timer.time;
    q('scheduled-days').querySelectorAll('input').forEach(input => { input.checked = data.timer.days.includes(Number(input.value)); });
  }
  q('scheduled-timer-enabled').disabled = !data.writable || !data.timer;
  q('scheduled-timer-time').disabled = !data.writable || !data.timer;
  q('scheduled-days').querySelectorAll('input').forEach(input => { input.disabled = !data.writable || !data.timer; });
  q('scheduled-timer-note').textContent = !data.timer ? t('scheduled.noTimer', 'The TV did not report its power-on timer settings.') :
    !data.timer.enabled ? t('scheduled.timerOff', 'The power-on timer is off. Enable it to wake the TV for these apps.') :
    t('scheduled.timerOn', 'Uses the TV’s local clock. No repeat days means the next occurrence only.');
  const observed = data.observed;
  q('scheduled-wake').textContent = observed ? t('scheduled.lastWake', 'Last observed wake: {reason}', { reason: observed.reason || t('common.unknown', 'Unknown') }) :
    t('scheduled.waiting', 'Waiting for the next timer wake-up.');
  const run = data.lastRun;
  q('scheduled-run').textContent = run ? t('scheduled.run', 'Last run: {time} · {state}', {
    time: new Date(run.at).toLocaleString(), state: scheduledRunState(run.state)
  }) : t('scheduled.noRun', 'No scheduled launches yet.');
  q('scheduled-results').replaceChildren();
  (run?.steps || []).forEach(step => {
    const item = document.createElement('li');
    const app = (data.apps || []).find(a => a.id === step.appId);
    item.textContent = t('scheduled.result', '{app} · {delay}s · {state}', {
      app: app?.title || step.appId, delay: step.delaySeconds, state: scheduledRunState(step.state)
    });
    q('scheduled-results').appendChild(item);
  });
}

function scheduledRunState(state) {
  const labels = {
    pending: t('scheduled.state.pending', 'Waiting'), running: t('scheduled.state.running', 'Running'),
    completed: t('scheduled.state.completed', 'Completed'), failed: t('scheduled.state.failed', 'Failed'),
    cancelled: t('scheduled.state.cancelled', 'Cancelled'), interrupted: t('scheduled.state.interrupted', 'Interrupted'),
    'finished-with-errors': t('scheduled.state.errors', 'Finished with errors')
  };
  return labels[state] || state;
}

async function loadScheduled() {
  if (scheduledLoading) return;
  scheduledLoading = true;
  const generation = ++scheduledLoadGeneration;
  try {
    const response = await fetch(api('/api/scheduled'), { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || t('scheduled.loadFailed', 'Could not load scheduled apps.'));
    if (generation === scheduledLoadGeneration) renderScheduled(data);
  } catch (error) { scheduledMessage(error.message, true); }
  finally { if (generation === scheduledLoadGeneration) scheduledLoading = false; }
}

function scheduledViewVisible(visible) {
  scheduledVisible = visible;
  clearInterval(scheduledTimer);
  if (visible) {
    loadScheduled();
    scheduledTimer = setInterval(() => { if (!document.hidden && !scheduledSaving) loadScheduled(); }, 15000);
  }
}

q('scheduled-add').addEventListener('click', () => {
  if (q('scheduled-apps-list').children.length >= 10) return scheduledMessage(t('scheduled.limit', 'You can add up to 10 apps.'), true);
  scheduledAppRow(); scheduledAppsDirty = true;
});
q('scheduled-enabled').addEventListener('change', () => { scheduledAppsDirty = true; });
q('scheduled-timer-form').addEventListener('input', () => { scheduledTimerDirty = true; });
for (let day = 0; day < 7; day++) {
  const label = document.createElement('label');
  const input = document.createElement('input'); input.type = 'checkbox'; input.value = day;
  label.append(input, document.createTextNode(new Date(2023, 0, 1 + day).toLocaleDateString(document.documentElement.lang || navigator.language, { weekday: 'short' })));
  q('scheduled-days').appendChild(label);
}

async function saveScheduled(body, endpoint) {
  scheduledSaving = true;
  scheduledLoadGeneration++;
  scheduledLoading = false;
  q('scheduled-save').disabled = q('scheduled-timer-save').disabled = true;
  scheduledMessage(t('scheduled.saving', 'Saving…'));
  try {
    const response = await fetch(api(endpoint), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || t('scheduled.saveFailed', 'Could not save these settings.'));
    if (endpoint === '/api/scheduled') scheduledAppsDirty = false;
    else scheduledTimerDirty = false;
    scheduledMessage(t('scheduled.saved', 'Saved.'));
    await loadScheduled();
  } catch (error) { scheduledMessage(error.message, true); }
  finally {
    scheduledSaving = false;
    if (scheduledData) renderScheduled(scheduledData);
  }
}

q('scheduled-apps-form').addEventListener('submit', event => {
  event.preventDefault();
  const actions = Array.from(q('scheduled-apps-list').children).map(row => ({
    appId: row.querySelector('select').value, delaySeconds: Number(row.querySelector('input').value)
  }));
  saveScheduled({ enabled: q('scheduled-enabled').checked, actions }, '/api/scheduled');
});
q('scheduled-timer-form').addEventListener('submit', event => {
  event.preventDefault();
  const days = Array.from(q('scheduled-days').querySelectorAll('input:checked')).map(input => Number(input.value));
  saveScheduled({ action: 'powerTimer', value: { timer: 'on', enabled: q('scheduled-timer-enabled').checked,
    time: q('scheduled-timer-time').value, days } }, '/api/control');
});
