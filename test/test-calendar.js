// OAuth races, token rotation, pagination and agenda privacy.
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var create = require('../server/lib/calendar').create;
var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glasshouse-calendar-'));
var seq = 0;
var base = Date.parse('2026-11-04T10:00:00Z');
var id = '0ffe5808-9b38-4dd2-831b-669b8bbcdb99';
function setup(saved) {
  var file = path.join(dir, String(++seq) + '.json');
  if (saved) fs.writeFileSync(file, JSON.stringify(saved));
  var calls = [], timers = [], time = base;
  var calendar = create({ stateFile: file, now: function () { return time; },
    request: function (url, fields, token, cb) { calls.push({ url: url, fields: fields, token: token, cb: cb }); },
    later: function (fn, ms) { var item = { fn: fn, ms: ms }; timers.push(item); return item; },
    cancel: function (item) { item.cancelled = true; }
  });
  return { calendar: calendar, calls: calls, timers: timers, file: file,
    advance: function (ms) { time += ms; },
    reply: function (value, err) { var call = calls.shift(); assert(call, 'expected Microsoft request'); call.cb(err || null, value); return call; }
  };
}
function credentials() { return { clientId: id, refreshToken: 'refresh-secret', accessToken: 'access-secret', expires: base + 3600000 }; }
function event(title, hour, extra) {
  var e = { subject: title, start: { dateTime: '2026-11-04T' + hour + ':00:00.0000000' }, end: { dateTime: '2026-11-04T' + hour + ':30:00.0000000' } };
  Object.keys(extra || {}).forEach(function (k) { e[k] = extra[k]; }); return e;
}
function signIn(s) {
  var result;
  s.calendar.begin({}, function (r) { result = r; });
  assert.strictEqual(s.calls[0].fields.client_id, id);
  assert.strictEqual(s.calls[0].fields.scope.indexOf('Calendars.ReadWrite'), -1);
  assert(s.calls[0].fields.scope.indexOf('Tasks.ReadWrite') !== -1);
  s.reply({ device_code: 'device-secret', user_code: 'ABCD', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5 });
  assert.strictEqual(result.pending.code, 'ABCD');
  assert.strictEqual(JSON.stringify(result).indexOf('device-secret'), -1);
  return result;
}

var s = setup();
signIn(s);
s.timers.shift().fn();
s.reply({ error: 'slow_down' });
assert.strictEqual(s.timers[0].ms, 10000);
s.timers.shift().fn();
s.reply({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 });
assert(s.calendar.status().connected);
assert.strictEqual(JSON.stringify(s.calendar.status()).indexOf('secret'), -1);
assert.strictEqual(JSON.parse(fs.readFileSync(s.file, 'utf8')).refreshToken, 'refresh-secret');
if (process.platform !== 'win32') assert.strictEqual(fs.statSync(s.file).mode & 511, 384);

var first, second;
s.calendar.agenda(function (r) { first = r; });
s.calendar.agenda(function (r) { second = r; });
assert.strictEqual(s.calls.length, 1, 'concurrent agenda requests coalesce');
assert(s.calls[0].url.indexOf('calendarView') !== -1, 'calendarView expands recurring occurrences');
assert(s.calls[0].url.indexOf(encodeURIComponent('2026-11-11T10:00:00.000Z')) !== -1);
s.reply({ value: [event('Private title', '13', { sensitivity: 'private' }), event('Cancelled', '12', { isCancelled: true })],
  '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?$skip=100' });
s.reply({ value: [event('<img onerror=bad()>', '11'), event('Ended', '09'), event('All day', '00', { isAllDay: true, end: { dateTime: '2026-11-05T00:00:00' } })] });
assert.deepStrictEqual(first, second);
assert.deepStrictEqual(first.events.map(function (e) { return e.title; }), ['All day', '<img onerror=bad()>', 'Private title']);
assert.strictEqual(JSON.stringify(first).indexOf('secret'), -1);
assert.strictEqual(first.events[0].allDay, true);
s.calendar.agenda(function () {});
assert.strictEqual(s.calls.length, 0, 'cache avoids extra Microsoft calls');
s.advance(300001);
s.calendar.agenda(function (r) { first = r; });
s.reply(null, new Error('offline'));
assert(first.stale && first.updated && first.events.length === 3);

s = setup(credentials());
s.advance(3600000);
s.calendar.agenda(function (r) { first = r; });
assert.strictEqual(s.calls[0].fields.grant_type, 'refresh_token');
s.reply({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600 });
assert.strictEqual(JSON.parse(fs.readFileSync(s.file, 'utf8')).refreshToken, 'rotated-refresh');
assert.strictEqual(s.calls[0].token, 'new-access');
s.reply({ value: [], '@odata.nextLink': 'https://attacker.example/steal' });
assert(first.stale);
assert.strictEqual(s.calls.length, 0, 'pagination cannot forward bearer tokens to another host');

s = setup(credentials());
s.calendar.agenda(function (r) { first = r; });
s.calendar.disconnect(function (r) { assert(!r.connected); });
s.reply({ value: [event('Late callback', '14')] });
assert(!first.connected && first.events.length === 0);
assert.deepStrictEqual(JSON.parse(fs.readFileSync(s.file, 'utf8')), {});

s = setup(); signIn(s);
var awaiting;
s.calendar.agenda(function (r) { awaiting = r; });
assert(awaiting.pending, 'pending sign-in cannot be shown as an empty calendar');
s.timers.shift().fn();
s.calendar.disconnect(function () {});
s.reply({ access_token: 'late-secret', refresh_token: 'late-secret' });
assert(!s.calendar.status().connected, 'disconnect wins over in-flight device response');

s = setup(); signIn(s); s.advance(901000); s.timers.shift().fn();
assert(!s.calendar.status().pending && s.calendar.status().message);
assert.strictEqual(s.calls.length, 0);

s = setup(credentials());
s.calendar.agenda(function (r) { first = r; });
var unauthorised = new Error('401'); unauthorised.httpStatus = 401;
s.reply(null, unauthorised);
assert.strictEqual(s.calls[0].fields.grant_type, 'refresh_token');
s.reply({ access_token: 'retried-access', refresh_token: 'retried-refresh', expires_in: 3600 });
assert.strictEqual(s.calls[0].token, 'retried-access');
s.reply(null, unauthorised);
assert.strictEqual(s.calls.length, 0, '401 is retried once, without a refresh loop');
assert(first.stale && first.message.indexOf('Microsoft rejected') !== -1);

s = setup(credentials());
s.advance(3600000);
var graphResult;
s.calendar.graph('https://graph.microsoft.com/v1.0/me/todo/lists', null, function (err, r) { graphResult = r; });
s.calendar.agenda(function () {});
assert.strictEqual(s.calls.length, 1, 'calendar and tasks share one token refresh');
assert.strictEqual(s.calls[0].fields.scope.indexOf('Tasks.ReadWrite'), -1, 'old calendar-only sessions keep working before extra consent');
s.reply({ access_token: 'shared-access', refresh_token: 'shared-refresh', scope: 'Calendars.Read', expires_in: 3600 });
assert.strictEqual(s.calls.length, 2);
s.reply({ value: [] }); s.reply({ value: [] });
assert(graphResult && Array.isArray(graphResult.value));
assert(!s.calendar.status().tasksEnabled);
s.calendar.refresh();
assert.strictEqual(s.calls.length, 1, 'manual calendar refresh bypasses cache');
s.reply({ value: [] });

console.log('calendar: sign-in, safe status, refresh, recurrence query, pagination, cache, privacy, expiry and disconnect races passed');

var routes = require('../server/lib/routes');
var EventEmitter = require('events').EventEmitter;
var routeCalendar = setup();
var routeConfig = { token: 'dashboard-test-token', allowControl: true };
routes.init({ config: routeConfig, calendar: routeCalendar.calendar });
var completedFromRoute = 0;
var refreshedFromRoute = 0;
var undoneFromRoute = 0;
routes.init({ todo: { list: function () { return { ok: true, tasks: [] }; }, refresh: function () { refreshedFromRoute++; return { ok: true }; }, complete: function (body, cb) { completedFromRoute++; cb({ ok: true }); }, undo: function (body, cb) { undoneFromRoute++; cb({ ok: true }); } } });
function route(method, endpoint, key, headers) {
  var req = new EventEmitter(), response = {};
  req.url = '/api/calendar/' + endpoint + (key ? '?k=' + key : '');
  req.method = method; req.headers = headers || {};
  req.connection = { remoteAddress: '192.0.2.1' };
  req.destroy = function () {};
  routes.handleRequest(req, { writeHead: function (code, hdrs) { response.code = code; response.headers = hdrs; }, end: function (body) { response.body = body; } });
  if (method === 'POST') { req.emit('data', JSON.stringify({ id: 'task', listId: 'list' })); req.emit('end'); }
  return response;
}
assert.strictEqual(route('GET', 'status').code, 401);
var safe = route('GET', 'status', routeConfig.token);
assert.strictEqual(safe.code, 200);
assert.strictEqual(safe.headers['Cache-Control'], 'no-store');
assert.strictEqual(route('POST', 'connect', routeConfig.token, { 'content-type': 'text/plain' }).code, 415);
assert.strictEqual(route('POST', 'disconnect', routeConfig.token, { 'content-type': 'application/json', origin: 'https://attacker.example', host: 'tv.local' }).code, 403);
routeConfig.allowControl = false;
assert.strictEqual(route('POST', 'connect', routeConfig.token, { 'content-type': 'application/json' }).code, 403);
assert.strictEqual(route('POST', 'tasks/complete', routeConfig.token, { 'content-type': 'application/json' }).code, 403);
assert.strictEqual(completedFromRoute, 0);
routeConfig.allowControl = true;
assert.strictEqual(route('POST', 'tasks/complete', null, { 'content-type': 'application/json' }).code, 401);
assert.strictEqual(route('POST', 'tasks/complete', routeConfig.token, { 'content-type': 'application/json', origin: 'https://attacker.example', host: 'tv.local' }).code, 403);
assert.strictEqual(completedFromRoute, 0);
assert.strictEqual(route('POST', 'tasks/complete', routeConfig.token, { 'content-type': 'application/json' }).code, 200);
assert.strictEqual(completedFromRoute, 1);
assert.strictEqual(route('POST', 'refresh', null, { 'content-type': 'application/json' }).code, 401);
assert.strictEqual(route('POST', 'refresh', routeConfig.token, { 'content-type': 'application/json', origin: 'https://attacker.example', host: 'tv.local' }).code, 403);
assert.strictEqual(refreshedFromRoute, 0);
assert.strictEqual(route('POST', 'refresh', routeConfig.token, { 'content-type': 'application/json' }).code, 200);
assert.strictEqual(refreshedFromRoute, 1);
routeConfig.allowControl = false;
assert.strictEqual(route('POST', 'tasks/undo', routeConfig.token, { 'content-type': 'application/json' }).code, 403);
routeConfig.allowControl = true;
assert.strictEqual(route('POST', 'tasks/undo', null, { 'content-type': 'application/json' }).code, 401);
assert.strictEqual(route('POST', 'tasks/undo', routeConfig.token, { 'content-type': 'application/json', origin: 'https://attacker.example', host: 'tv.local' }).code, 403);
assert.strictEqual(undoneFromRoute, 0);
assert.strictEqual(route('POST', 'tasks/undo', routeConfig.token, { 'content-type': 'application/json' }).code, 200);
assert.strictEqual(undoneFromRoute, 1);
console.log('calendar routes: authentication, no-store, CSRF and control permission passed');
fs.readdirSync(dir).forEach(function (name) { fs.unlinkSync(path.join(dir, name)); });
fs.rmdirSync(dir);
