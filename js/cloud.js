// Accounts, plans kept on the server and share links. Everything that talks to the backend lives
// here; main.js hands it the model and the editor and otherwise stays a local-first app.
//
// Signed out, the editor works exactly as it always did — only saving and sharing need an account.

const OPEN_PLAN_KEY = 'homeplan.openPlan';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Fetch JSON from the API, throwing { status, message } on anything but a 2xx. */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = {};
  try { payload = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw Object.assign(new Error(payload.error || `Request failed (${res.status})`), { status: res.status });
  return payload;
}

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, v) { try { localStorage.setItem(key, v); } catch { /* unavailable */ } },
  drop(key) { try { localStorage.removeItem(key); } catch { /* unavailable */ } },
};

/**
 * @param {object} ctx { model, history, editor, previewToken, storageKey, onPlanLoaded }
 */
export function initCloud(ctx) {
  const { model, history, editor, previewToken, storageKey } = ctx;
  const bar = $('#account');
  let me = null;                 // { email } when signed in
  let open = null;               // { id, name, share } of the plan open from the server
  let dirty = false;
  let loading = false;           // true while we replace the model ourselves

  // ---------------------------------------------------------------- shared preview

  if (previewToken) {
    document.body.dataset.mode = 'preview';
    editor.setReadOnly(true);
    showPreview(previewToken);
    return { isPreview: () => true, save: () => {} };
  }

  async function showPreview(token) {
    const banner = document.createElement('div');
    banner.className = 'banner';
    banner.textContent = 'Loading the shared plan…';
    document.body.insertBefore(banner, $('#workspace'));
    try {
      const { name, mode, data } = await api(`/api/shared/${encodeURIComponent(token)}`);
      document.body.dataset.share = mode; // read-only hides the toolbar's editing and export buttons
      model.load(data);
      history.reset();
      ctx.onPlanLoaded?.(name);
      banner.innerHTML = `<strong></strong><span>Shared plan — read only</span>`;
      $('strong', banner).textContent = name;
      if (mode === 'copy') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'primary';
        button.textContent = 'Edit copy';
        button.addEventListener('click', () => {
          const hasOwn = !!store.get(storageKey);
          if (hasOwn && !confirm('Open a copy of this plan in the editor? It replaces the plan you were working on.')) return;
          store.set(storageKey, JSON.stringify(data));
          store.drop(OPEN_PLAN_KEY);
          location.href = '/';
        });
        banner.append(button);
      }
      const home = document.createElement('a');
      home.href = '/';
      home.textContent = 'Open Home Plan';
      banner.append(home);
    } catch (e) {
      banner.textContent = e.message;
      banner.classList.add('bad');
    }
  }

  // ---------------------------------------------------------------- account bar

  function render() {
    bar.innerHTML = '';
    if (!me) {
      bar.append(button('Sign in', signIn));
      return;
    }
    const who = document.createElement('span');
    who.className = 'who';
    who.title = me.email;
    who.textContent = open ? `${open.name}${dirty ? ' •' : ''}` : me.email;
    const share = button('Share', shareDialog);
    share.disabled = !open; // a plan has to be on the server before it can be shared
    bar.append(who, button('My plans', plansDialog), button('Save', save), share, button('Sign out', signOut));
  }

  function button(label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  /** A <dialog> with a title, some markup and a close button. Returns the dialog. */
  function dialog(title, html) {
    const d = document.createElement('dialog');
    d.className = 'cloud-dialog';
    d.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2><div class="body">${html}</div></form>`;
    document.body.append(d);
    d.addEventListener('close', () => d.remove());
    d.showModal();
    return d;
  }

  const saying = (d, text, bad = true) => {
    let p = $('.msg', d);
    if (!p) { p = document.createElement('p'); p.className = 'msg'; $('.body', d).append(p); }
    p.textContent = text;
    p.classList.toggle('bad', bad);
  };

  // ---------------------------------------------------------------- sign in / out

  function signIn() {
    const d = dialog('Sign in', `
      <label>Email <input type="email" name="email" autocomplete="username" required></label>
      <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
      <div class="actions"><button value="cancel">Cancel</button><button class="primary" id="go" value="go">Sign in</button></div>
      <p class="hint">Accounts are created by whoever runs this server; they will send you a link to set a password.</p>`);
    $('input[name=email]', d).focus();
    $('form', d).addEventListener('submit', async (e) => {
      if (e.submitter?.value !== 'go') return;
      e.preventDefault();
      const email = $('input[name=email]', d).value.trim();
      const password = $('input[name=password]', d).value;
      try {
        me = await api('/api/login', { method: 'POST', body: { email, password } });
        d.close();
        restoreOpenPlan();
        render();
      } catch (err) {
        saying(d, err.message);
      }
    });
  }

  async function signOut() {
    try { await api('/api/logout', { method: 'POST', body: {} }); } catch { /* already gone */ }
    me = null;
    open = null;
    dirty = false;
    store.drop(OPEN_PLAN_KEY);
    render();
  }

  // ---------------------------------------------------------------- saving

  async function save() {
    if (!me) return signIn();
    if (!open) return saveAs();
    try {
      const { plan } = await api(`/api/plans/${open.id}`, { method: 'PUT', body: { data: model.toJSON() } });
      open = plan;
      dirty = false;
      render();
      flash(`Saved “${plan.name}”`);
    } catch (e) {
      if (e.status === 404) { open = null; store.drop(OPEN_PLAN_KEY); render(); }
      alert(e.message);
    }
  }

  async function saveAs(suggested) {
    if (!me) return signIn();
    const name = prompt('Save this plan on the server as:', suggested || open?.name || 'My plan');
    if (name == null || !name.trim()) return;
    try {
      const { plan } = await api('/api/plans', { method: 'POST', body: { name: name.trim(), data: model.toJSON() } });
      open = plan;
      dirty = false;
      store.set(OPEN_PLAN_KEY, plan.id);
      render();
      flash(`Saved “${plan.name}”`);
    } catch (e) {
      alert(e.message);
    }
  }

  function flash(text) {
    const status = $('#status');
    if (status) status.textContent = text;
  }

  // ---------------------------------------------------------------- my plans

  async function plansDialog() {
    const d = dialog('My plans', '<p>Loading…</p>');
    let plans = [];
    try {
      ({ plans } = await api('/api/plans'));
    } catch (e) {
      saying(d, e.message);
      return;
    }
    const rows = plans.map((p) => `
      <li data-id="${esc(p.id)}">
        <span class="name">${esc(p.name)}</span>
        <span class="when">${new Date(p.updatedAt).toLocaleString()}${p.share ? ' · shared' : ''}</span>
        <button value="open" data-do="open">Open</button>
        <button value="del" class="danger" data-do="delete">Delete</button>
      </li>`).join('');
    $('.body', d).innerHTML = `
      <ul class="plan-list">${rows || '<li class="empty">Nothing saved yet.</li>'}</ul>
      <div class="actions">
        <button value="cancel">Close</button>
        <button class="primary" data-do="save-as" value="save-as">Save current plan as…</button>
      </div>`;
    $('form', d).addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-do]');
      if (!b) return;
      e.preventDefault();
      const id = b.closest('li')?.dataset.id;
      if (b.dataset.do === 'save-as') { d.close(); saveAs(); return; }
      if (b.dataset.do === 'delete') {
        if (!confirm('Delete this plan from the server? This cannot be undone.')) return;
        await api(`/api/plans/${id}`, { method: 'DELETE', body: {} }).catch((err) => alert(err.message));
        if (open?.id === id) { open = null; store.drop(OPEN_PLAN_KEY); render(); }
        b.closest('li').remove();
        return;
      }
      if (b.dataset.do === 'open') {
        if (dirty && !confirm('The plan you are editing has unsaved changes. Open the saved one anyway?')) return;
        try {
          const { plan } = await api(`/api/plans/${id}`);
          loading = true;
          model.load(plan.data);
          history.reset();
          loading = false;
          open = { id: plan.id, name: plan.name, share: plan.share };
          dirty = false;
          store.set(OPEN_PLAN_KEY, plan.id);
          ctx.onPlanLoaded?.(plan.name);
          render();
          d.close();
        } catch (err) {
          loading = false;
          saying(d, err.message);
        }
      }
    });
  }

  // ---------------------------------------------------------------- sharing

  async function shareDialog() {
    if (!open) { alert('Save this plan on the server first, then you can share it.'); return; }
    const mode = open.share?.mode || 'off';
    const d = dialog(`Share “${open.name}”`, `
      <label class="radio"><input type="radio" name="mode" value="off" ${mode === 'off' ? 'checked' : ''}> Not shared</label>
      <label class="radio"><input type="radio" name="mode" value="view" ${mode === 'view' ? 'checked' : ''}> Anyone with the link can look at it</label>
      <label class="radio"><input type="radio" name="mode" value="copy" ${mode === 'copy' ? 'checked' : ''}> …and can open an editable copy</label>
      <label class="link">Link <input type="text" id="link" readonly value="${open.share ? esc(location.origin + '/s/' + open.share.token) : ''}"></label>
      <div class="actions">
        <button value="close">Close</button>
        <button data-do="copy" value="copy">Copy link</button>
      </div>
      <p class="hint">A shared plan is sent to the viewer's browser so it can be drawn, in both modes — read-only hides the editing tools, it does not lock the data away.</p>`);
    const link = $('#link', d);
    const apply = async (value) => {
      try {
        const { share } = await api(`/api/plans/${open.id}/share`, { method: 'POST', body: { mode: value } });
        open.share = share;
        link.value = share ? `${location.origin}/s/${share.token}` : '';
        saying(d, share ? 'The link is live.' : 'Sharing is off; the old link stops working.', false);
      } catch (e) {
        saying(d, e.message);
      }
    };
    for (const radio of d.querySelectorAll('input[name=mode]')) {
      radio.addEventListener('change', () => apply(radio.value));
    }
    $('form', d).addEventListener('click', (e) => {
      const b = e.target.closest('button[data-do=copy]');
      if (!b) return;
      e.preventDefault();
      if (!link.value) return;
      navigator.clipboard?.writeText(link.value).then(() => saying(d, 'Link copied.', false), () => link.select());
    });
  }

  // ---------------------------------------------------------------- wiring

  /** After a reload, rebind the plan we had open — the editor's local autosave holds its content. */
  async function restoreOpenPlan() {
    const id = store.get(OPEN_PLAN_KEY);
    if (!id) return;
    try {
      const { plans } = await api('/api/plans');
      const found = plans.find((p) => p.id === id);
      if (found) { open = found; dirty = false; } else store.drop(OPEN_PLAN_KEY);
    } catch { /* offline or signed out */ }
    render();
  }

  model.on(() => {
    if (loading || !open || dirty) return;
    dirty = true;
    render();
  });

  window.addEventListener('beforeunload', (e) => {
    if (open && dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  (async () => {
    try { me = await api('/api/me'); } catch { me = null; }
    render();
    if (me) restoreOpenPlan();
  })();

  return { isPreview: () => false, save, saveAs, signIn };
}
