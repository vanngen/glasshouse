// Browser regression for the calendar panel, using synthetic appointments.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright-core');
const assets = path.resolve(__dirname, '../server/assets');
const server = http.createServer((req, res) => {
  const file = path.join(assets, new URL(req.url, 'http://localhost').pathname.replace(/^\/assets\//, ''));
  if (!file.startsWith(assets + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge' });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Europe/Berlin' });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.clock.install();
    const stamp = Date.now();
    const agenda = { ok: true, connected: true, updated: stamp, events: Array.from({ length: 8 }, (_, i) => ({
      title: i === 0 ? '<img src=x onerror=alert(1)>' : ['Dentist', 'Lunch with Alex', 'Project review', 'Dinner', 'Train to Hamburg', 'Birthday', 'Weekend plans'][i - 1],
      start: stamp + (i + 1) * 3600000, end: stamp + (i + 2) * 3600000, allDay: i === 7
    })) };
    const layout = { rows: ['app', 'dev', 'ch'], order: { app: [], dev: [], ch: [] }, hidden: { app: [], dev: [], ch: [] },
      channels: [], hintSeen: true, searchHintSeen: true, rowsBottom: true, view: 'alternative' };
    const tasks = { ok: true, connected: false, enabled: false, updated: stamp, tasks: [] };
    const completions = [];
    let refreshes = 0;
    let failCompletion = false;
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url());
      let body = { ok: true, build: 'calendar-test' };
      if (url.pathname === '/api/calendar/agenda') body = agenda;
      if (url.pathname === '/api/calendar/tasks') body = tasks;
      if (url.pathname === '/api/calendar/refresh') refreshes++;
      if (url.pathname === '/api/calendar/tasks/complete') {
        const item = route.request().postDataJSON(); completions.push(item);
        if (failCompletion) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'offline' }) });
        tasks.tasks = tasks.tasks.filter(task => task.id !== item.id || task.listId !== item.listId);
      }
      if (url.pathname.endsWith('/catalogue')) body = { ok: true, layout, apps: [{ id: 'netflix', title: 'Netflix' }, { id: 'youtube', title: 'YouTube' }],
        devices: [{ id: 'hdmi1', title: 'HDMI 1', port: 1, connected: true }],
        channels: layout.channels.length ? [{ id: 'ch1', title: 'News', number: '1' }] : [],
        sources: { channels: layout.channels.length }, order: { app: ['netflix', 'youtube', 'lg-home'], dev: ['hdmi1'], ch: layout.channels } };
      if (url.pathname.endsWith('/now')) body = { kind: 'input', port: 1, title: 'HDMI 1' };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto('http://127.0.0.1:' + server.address().port + '/assets/home.html');
    await page.waitForSelector('#agenda .appointment');
    await page.waitForSelector('.tile');
    assert.strictEqual(await page.locator('#agenda .appointment').count(), 4);
    assert.strictEqual(await page.locator('#agenda img').count(), 0, 'titles must stay plain text');
    assert.strictEqual(await page.locator('#agenda-note').textContent(), 'Page 1 of 2');
    async function assertSeamless() {
      const result = await page.evaluate(() => {
        const rows = document.getElementById('rows').getBoundingClientRect();
        const panel = document.getElementById('agenda'), agenda = panel.getBoundingClientRect(), style = getComputedStyle(panel);
        const overlaps = Array.from(document.querySelectorAll('#rows .row')).some(row => {
          const r = row.getBoundingClientRect();
          return r.height && r.left < agenda.right && r.right > agenda.left && r.top < agenda.bottom && r.bottom > agenda.top;
        });
        return { overlaps, width: rows.width, background: style.backgroundColor, border: style.borderTopWidth, pointer: style.pointerEvents };
      });
      assert(!result.overlaps, 'agenda must stay above every launcher row');
      assert.strictEqual(result.width, 1920, 'apps retain the full screen width');
      assert.strictEqual(result.background, 'rgba(0, 0, 0, 0)');
      assert.strictEqual(result.border, '0px');
      assert.strictEqual(result.pointer, 'none');
    }
    await assertSeamless();
    if (process.env.CALENDAR_SCREENSHOT) await page.screenshot({ path: path.resolve(process.env.CALENDAR_SCREENSHOT) });
    await page.clock.fastForward(15000);
    assert.strictEqual(await page.locator('#agenda .appointment').count(), 4);
    assert((await page.locator('#agenda').textContent()).includes('All day'));
    for (const settings of [
      { view: 'classic', rowsBottom: true, channels: [] },
      { view: 'classic', rowsBottom: false, channels: ['ch1'] },
      { view: 'alternative', rowsBottom: true, channels: ['ch1'] }
    ]) {
      Object.assign(layout, settings);
      const loaded = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/catalogue');
      await page.evaluate(() => document.dispatchEvent(new Event('webOSRelaunch')));
      await loaded;
      await page.waitForFunction(alternative => document.getElementById('stage').className.includes('alternative') === alternative, settings.view === 'alternative');
      await assertSeamless();
    }
    agenda.stale = true;
    await page.clock.fastForward(60000);
    await page.waitForFunction(() => document.getElementById('agenda-note').textContent.includes('Could not refresh'));
    agenda.stale = false; agenda.updated = 0; agenda.pending = true; agenda.events = [];
    await page.clock.fastForward(60000);
    await page.waitForFunction(() => document.getElementById('agenda-note').textContent.includes('Finish Microsoft sign-in'));
    agenda.pending = false; agenda.loading = true;
    await page.clock.fastForward(60000);
    await page.waitForFunction(() => document.getElementById('agenda-note').textContent.includes('Loading appointments'));
    agenda.loading = false; agenda.updated = stamp;
    await page.clock.fastForward(60000);
    await page.waitForFunction(() => document.getElementById('agenda-note').textContent.includes('No upcoming appointments'));
    layout.view = 'alternative'; layout.channels = []; layout.rowsBottom = true;
    agenda.events = [{ title: 'Friday appointment', start: stamp + 86400000, end: stamp + 90000000 }];
    tasks.connected = tasks.enabled = true;
    tasks.tasks = [
      { id: 'documents', listId: 'personal', title: 'Prepare appointment documents', due: '2026-11-04', list: 'Personal' },
      { id: 'shopping', listId: 'personal', title: '<img onerror=bad()>', due: null, list: 'Shopping' },
      { id: 'train', listId: 'personal', title: 'Book train tickets', due: '2026-11-06', list: 'Personal' }
    ];
    const updatedLayout = page.waitForResponse(r => new URL(r.url()).pathname === '/api/home/catalogue');
    await page.evaluate(() => document.dispatchEvent(new Event('webOSRelaunch')));
    await updatedLayout;
    await page.clock.fastForward(60000);
    await page.waitForSelector('#todo-list .todo-task');
    await assertSeamless();
    assert.strictEqual(await page.locator('#todo-list img').count(), 0);
    const columns = await page.evaluate(() => {
      const a = document.getElementById('agenda-calendar').getBoundingClientRect(), t = document.getElementById('todo').getBoundingClientRect();
      return a.right <= t.left && Math.abs(a.top - t.top) < 1;
    });
    assert(columns, 'calendar and To Do sit side by side');
    if (process.env.CALENDAR_TODO_SCREENSHOT) await page.screenshot({ path: path.resolve(process.env.CALENDAR_TODO_SCREENSHOT) });
    await page.keyboard.press('ArrowUp');
    assert.strictEqual(await page.locator('#todo-list .todo-task.focus').count(), 1, 'Up from apps enters To Do');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#todo-list button[disabled]'));
    assert.deepStrictEqual(completions[0], { id: 'documents', listId: 'personal' });
    assert(!(await page.locator('#todo-list').textContent()).includes('Prepare appointment documents'));
    failCompletion = true;
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.querySelector('#todo-list button[disabled]'));
    assert((await page.locator('#todo-list').textContent()).includes('<img onerror=bad()>'), 'failed completion retains task');
    await page.keyboard.down('Enter');
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    await page.waitForFunction(() => !document.querySelector('#todo-list button[disabled]'));
    assert.strictEqual(completions.length, 3, 'holding OK sends one completion');
    await page.keyboard.press('ArrowLeft');
    assert.strictEqual(await page.locator('#todo-list .todo-task.focus').count(), 0);
    assert.strictEqual(await page.locator('#rows .tile.focus').count(), 1, 'Left returns to apps');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    assert.strictEqual(await page.locator('#outlook-refresh.focus').count(), 1, 'Up from the first task focuses Refresh');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.getElementById('outlook-refresh').disabled);
    assert.strictEqual(refreshes, 1, 'OK on Refresh reloads calendar and tasks');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('ArrowLeft');
    tasks.connected = tasks.enabled = false; tasks.tasks = [];
    agenda.connected = false; agenda.events = [];
    await page.clock.fastForward(60000);
    await page.waitForFunction(() => !document.getElementById('stage').className.includes('with-agenda'));
    assert.deepStrictEqual(errors, []);
    console.log('calendar browser: layout, safe titles, paging, all-day events, stale state and disconnect passed');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => server.close());
