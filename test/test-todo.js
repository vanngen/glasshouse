var assert = require('assert');
var create = require('../server/lib/todo').create;
function setup() {
  var time = 1000000, calls = [];
  var account = { connected: true, tasksEnabled: true, connectionRevision: 1, pending: null };
  var todo = create({ now: function () { return time; }, status: function () { return account; },
    graph: function (url, options, cb) { calls.push({ url: url, options: options, cb: cb }); } });
  return { todo: todo, account: account, calls: calls, advance: function () { time += 300001; },
    reply: function (r, e) { var call = calls.shift(); assert(call); call.cb(e || null, r); return call; } };
}
function seed(s) {
  assert(s.todo.list().loading);
  s.reply({ value: [{ id: 'personal', displayName: 'Personal' }] });
  assert.strictEqual(s.calls[0].url.indexOf('$select'), -1, 'personal To Do does not support field selection');
  s.reply({ value: [
    { id: 'later', title: '<img onerror=bad()>', status: 'notStarted', dueDateTime: { dateTime: '2026-11-06T00:00:00', timeZone: 'UTC' } },
    { id: 'first', title: 'Overdue task', status: 'inProgress', dueDateTime: { dateTime: '2026-11-01T00:00:00', timeZone: 'UTC' } },
    { id: 'done', title: 'Already done', status: 'completed' },
    { id: 'no-date', title: 'No date' }
  ] });
  return s.todo.list();
}
var s = setup(), result = seed(s);
assert.deepStrictEqual(result.tasks.map(function (t) { return t.id; }), ['first', 'later', 'no-date']);
assert.strictEqual(result.tasks[1].due, '2026-11-06', 'date-only deadlines do not shift timezone');
assert.strictEqual(result.tasks[1].title, '<img onerror=bad()>');
assert.strictEqual(result.tasks[0].list, 'Personal');
assert.strictEqual(s.calls.length, 0, 'five minute cache');
var completed;
s.todo.complete({ id: 'unknown', listId: 'personal' }, function (r) { completed = r; });
assert.strictEqual(completed.ok, false);
assert.strictEqual(s.calls.length, 0, 'cannot mutate a task not in the current list');
s.todo.complete({ id: 'first', listId: 'personal' }, function (r) { completed = r; });
assert.strictEqual(s.calls[0].options.method, 'PATCH');
assert.deepStrictEqual(s.calls[0].options.json, { status: 'completed' });
s.todo.complete({ id: 'first', listId: 'personal' }, function (r) { assert(!r.ok); });
assert.strictEqual(s.calls.length, 1, 'repeated OK cannot send duplicate completion requests');
s.reply(null, new Error('offline'));
assert(!completed.ok);
assert.strictEqual(s.todo.list().tasks.length, 3, 'failed completion retains the task');
s.todo.complete({ id: 'first', listId: 'personal' }, function (r) { completed = r; });
s.reply({ status: 'completed' });
assert(completed.ok);
assert.strictEqual(s.todo.list().tasks.length, 2);
s.advance(); s.todo.list(); s.reply(null, new Error('offline'));
assert(s.todo.list().stale && s.todo.list().tasks.length === 2, 'failed refresh preserves labelled cache');
s.account.connected = false;
assert.strictEqual(s.todo.list().tasks.length, 0, 'disconnect clears task data');

s = setup(); s.account.tasksEnabled = false;
assert(!s.todo.list().enabled);
assert.strictEqual(s.calls.length, 0, 'calendar-only consent does not send task requests');
s.account.tasksEnabled = true;
s.todo.list();
s.reply({ value: [], '@odata.nextLink': 'https://attacker.example/steal' });
assert(s.todo.list().stale);
assert.strictEqual(s.calls.length, 0, 'refuse cross-host pagination');

s = setup(); s.todo.list();
s.reply({ value: [{ id: 'a', displayName: 'A' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/todo/lists?$skip=1' });
s.reply({ value: [{ id: 'b', displayName: 'B' }] });
s.reply({ value: [{ id: 'a1', title: 'First' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/a/tasks?$skip=1' });
s.reply({ value: [{ id: 'a2', title: 'Second' }] });
s.reply({ value: [{ id: 'b1', title: 'Third' }] });
assert.strictEqual(s.todo.list().tasks.length, 3, 'all lists and pages are included');
assert.strictEqual(s.calls.length, 0);
s.todo.refresh();
assert.strictEqual(s.calls.length, 1, 'manual refresh bypasses the five-minute cache');
s.todo.refresh();
assert.strictEqual(s.calls.length, 1, 'manual refresh coalesces while already loading');
s.reply({ value: [] });
assert.strictEqual(s.todo.list().tasks.length, 0);

s = setup(); seed(s); s.advance(); s.todo.list();
s.todo.complete({ id: 'first', listId: 'personal' }, function (r) { assert(r.ok); });
var read = s.calls.shift(), write = s.calls.shift();
write.cb(null, { status: 'completed' });
read.cb(null, { value: [{ id: 'personal', displayName: 'Personal' }] });
assert(s.todo.list().tasks.every(function (t) { return t.id !== 'first'; }), 'an older refresh cannot resurrect completed tasks');

s = setup(); seed(s);
s.todo.complete({ id: 'first', listId: 'personal' }, function (r) { assert(!r.ok); });
s.account.connectionRevision++;
s.reply({ status: 'completed' });
assert.strictEqual(s.todo.list().tasks.length, 0);
console.log('todo: permissions, sorting, date-only deadlines, pagination, cache, known-task completion, failures and account races passed');
