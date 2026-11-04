// Microsoft To Do: in-memory list cache and completion of known tasks only.
var msg = require('./say').msg;
var BASE = 'https://graph.microsoft.com/v1.0/me/todo/lists';
function create(opts) {
  var graph = opts.graph, account = opts.status, now = opts.now || Date.now;
  var tasks = [], updated = 0, attempted = 0, busy = false, message = '', revision = -1, changes = 0;
  var completing = {};
  function sync() {
    var st = account();
    if (st.connectionRevision !== revision || !st.connected || !st.tasksEnabled) {
      tasks = []; updated = attempted = 0; message = ''; completing = {};
      revision = st.connectionRevision; changes++;
    }
    return st;
  }
  function result(st) {
    return { ok: true, connected: st.connected, enabled: st.tasksEnabled, connectionRevision: st.connectionRevision, pending: !!st.pending, tasks: tasks,
      updated: updated, loading: busy && !updated, stale: !!message, message: message };
  }
  function list() {
    var st = sync();
    if (!st.connected || !st.tasksEnabled || busy || (attempted && now() - attempted < 5 * 60000)) return result(st);
    busy = true; attempted = now();
    var rev = revision, change = changes, found = [], lists = [], pages = 0;
    function valid() { var current = account(); return current.connected && current.tasksEnabled && current.connectionRevision === rev && changes === change; }
    function finish(err) {
      busy = false;
      if (!valid()) { attempted = 0; return; }
      if (err) message = msg('srv.todo.refresh', 'Tasks could not refresh. Reconnect Outlook if this continues.');
      else {
        tasks = found.sort(function (a, b) { return (a.due || '9999').localeCompare(b.due || '9999') || (b.important ? 1 : 0) - (a.important ? 1 : 0) || a.title.localeCompare(b.title); });
        updated = now(); message = '';
      }
    }
    function collect(url, prefix, append, done) {
      if (!valid()) return finish(new Error('Account changed'));
      graph(url, null, function (err, r) {
        if (!valid() || err || !r || !Array.isArray(r.value)) return finish(err || new Error('Task request failed'));
        append(r.value); pages++;
        var next = r['@odata.nextLink'];
        if (next) {
          if (pages >= 50 || next.indexOf(prefix + '?') !== 0) return finish(new Error('Invalid tasks page'));
          return collect(next, prefix, append, done);
        }
        done();
      });
    }
    function nextList() {
      if (!lists.length) return finish(null);
      if (pages >= 50) return finish(new Error('Too many task pages'));
      var selected = lists.shift(), prefix = BASE + '/' + encodeURIComponent(selected.id) + '/tasks';
      // Personal-account To Do rejects $select (HTTP 400), even though the
      // same request accepts $top and $filter. Keep only display fields below.
      collect(prefix + '?$top=100&$filter=' + encodeURIComponent("status ne 'completed'"), prefix, function (items) {
        items.forEach(function (task) {
          if (task.status === 'completed' || typeof task.id !== 'string') return;
          var due = task.dueDateTime && task.dueDateTime.dateTime;
          found.push({ id: task.id, listId: selected.id, list: String(selected.displayName || '').slice(0, 120), title: String(task.title || '').slice(0, 240),
            due: typeof due === 'string' && /^\d{4}-\d\d-\d\d/.test(due) ? due.slice(0, 10) : null, important: task.importance === 'high' });
        });
      }, nextList);
    }
    collect(BASE + '?$top=100', BASE, function (items) {
      lists = lists.concat(items.filter(function (item) { return typeof item.id === 'string'; }));
    }, nextList);
    return result(st);
  }
  function complete(body, cb) {
    var st = sync();
    if (!st.connected || !st.tasksEnabled) return cb({ ok: false, error: msg('srv.todo.connect', 'Reconnect Outlook to enable Microsoft To Do.') });
    var task = tasks.filter(function (t) { return body && t.id === body.id && t.listId === body.listId; })[0];
    if (!task) return cb({ ok: false, error: msg('srv.todo.missing', 'This task is no longer in the current list. Refresh and try again.') });
    var key = task.listId + ':' + task.id;
    if (completing[key]) return cb({ ok: false, error: msg('srv.todo.busy', 'This task is already being completed.') });
    completing[key] = true;
    var rev = revision;
    graph(BASE + '/' + encodeURIComponent(task.listId) + '/tasks/' + encodeURIComponent(task.id), { method: 'PATCH', json: { status: 'completed' } }, function (err, r) {
      delete completing[key];
      if (err || !r || r.status !== 'completed' || account().connectionRevision !== rev) return cb({ ok: false, error: msg('srv.todo.completeFailed', 'The task could not be completed. Try again.') });
      changes++;
      tasks = tasks.filter(function (t) { return t.id !== task.id || t.listId !== task.listId; });
      updated = attempted = now();
      cb({ ok: true });
    });
  }
  function refresh() { if (!busy) attempted = 0; return list(); }
  return { list: list, complete: complete, refresh: refresh };
}
module.exports = { create: create };
