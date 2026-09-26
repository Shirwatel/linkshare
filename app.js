const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.LINKSHARE_CONFIG;
const supabase = window.supabaseCreateClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const pairView = document.getElementById('pairView');
const connectingView = document.getElementById('connectingView');
const feedView = document.getElementById('feedView');
const statusDot = document.getElementById('statusDot');
const feedList = document.getElementById('feedList');
const pairError = document.getElementById('pairError');

const PAIRING_ID_KEY = 'linkshare_pairing_id';

init();

async function init() {
  registerServiceWorker();

  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (code) return connectWithCode(code, true);

  // A home-screen shortcut launches with ?pid=<uuid> baked in (see
  // updateManifestForInstall below) so it reconnects even on phones where
  // the installed app's storage isn't shared with the regular browser tab.
  const pid = params.get('pid');
  if (pid) return restorePairingId(pid);

  const stored = localStorage.getItem(PAIRING_ID_KEY);
  if (stored) return enterFeed(stored);

  showView(pairView);
}

async function restorePairingId(pid) {
  showView(connectingView);
  const { data: exists, error } = await supabase.rpc('pairing_exists', { p_id: pid });
  if (error || !exists) {
    pairError.textContent = "This shortcut's connection isn't valid anymore \u2014 open the extension and scan a new QR code.";
    return showView(pairView);
  }
  localStorage.setItem(PAIRING_ID_KEY, pid);
  enterFeed(pid);
}

function showView(view) {
  [pairView, connectingView, feedView].forEach((v) => v.classList.add('hidden'));
  view.classList.remove('hidden');
}

// ---------- pairing ----------

async function connectWithCode(code, fromQr) {
  showView(fromQr ? connectingView : pairView);
  pairError.textContent = '';

  const { data, error } = await supabase.rpc('find_pairing_by_code', { p_code: code });
  const row = Array.isArray(data) ? data[0] : data;

  if (error) {
    pairError.textContent = `Couldn't reach the server: ${error.message || JSON.stringify(error)}`;
    console.error('Link Share connect error:', error);
    return showView(pairView);
  }
  if (!row) {
    pairError.textContent = 'No pairing found for that code. Double-check the extension and try again.';
    return showView(pairView);
  }
  if (new Date(row.code_expires_at) < new Date()) {
    pairError.textContent = 'That code expired \u2014 open the extension for a new one.';
    return showView(pairView);
  }

  await supabase.rpc('mark_phone_connected', { p_id: row.id });
  localStorage.setItem(PAIRING_ID_KEY, row.id);
  enterFeed(row.id);
}

document.getElementById('connectBtn').addEventListener('click', () => {
  const code = document.getElementById('codeInput').value.trim();
  if (code.length === 6) connectWithCode(code, false);
});

document.getElementById('showRestoreBtn').addEventListener('click', () => {
  document.getElementById('restoreRow').classList.toggle('hidden');
});

document.getElementById('restoreConnectBtn').addEventListener('click', () => {
  const code = document.getElementById('restoreCodeInput').value.trim();
  if (code) restorePairingId(code);
});

document.getElementById('unpairBtn').addEventListener('click', () => {
  localStorage.removeItem(PAIRING_ID_KEY);
  location.href = location.pathname;
});

// ---------- feed ----------

let pairingId = null;
let channel = null;

async function enterFeed(id) {
  pairingId = id;
  statusDot.classList.add('connected');
  showView(feedView);
  updateManifestForInstall(id);
  await loadFeed();
  subscribeRealtime();
  maybeShowInstallBanner();
  maybeRequestNotifications();
  showPlanBanner(id);
}

async function showPlanBanner(id) {
  const banner = document.getElementById('planBanner');
  const { data, error } = await supabase.rpc('get_pairing_meta', { p_id: id });
  const meta = Array.isArray(data) ? data[0] : data;
  if (error || !meta) return banner.classList.add('hidden');
  if (meta.plan === 'free' && meta.item_count >= 10) {
    banner.textContent = 'Free plan: 10/10 items \u2014 sending more replaces the oldest. Pro (unlimited history) is coming soon.';
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

// Rewrites the install manifest's start_url to include this pairing's id,
// so the resulting home-screen shortcut is self-contained and reconnects
// on launch even if the phone doesn't share storage between the browser
// tab and the installed app.
async function updateManifestForInstall(id) {
  try {
    const res = await fetch('manifest.json');
    const manifest = await res.json();
    manifest.start_url = `/index.html?pid=${id}`;
    const blob = new Blob([JSON.stringify(manifest)], { type: 'application/json' });
    const link = document.querySelector('link[rel="manifest"]');
    if (link) link.href = URL.createObjectURL(blob);
  } catch (err) {
    console.error('Link Share: could not personalize install manifest', err);
  }
}

async function loadFeed() {
  const { data, error } = await supabase
    .from('items')
    .select('id, type, content, sender, created_at')
    .eq('pairing_id', pairingId)
    .order('created_at', { ascending: false })
    .limit(10);

  feedList.innerHTML = '';
  if (error || !data || data.length === 0) {
    feedList.innerHTML = '<li class="feed-empty">Nothing shared yet \u2014 send something from your computer.</li>';
    return;
  }
  for (const item of data) renderItem(item, false);
}

function subscribeRealtime() {
  if (channel) supabase.removeChannel(channel);
  channel = supabase
    .channel(`items-${pairingId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'items', filter: `pairing_id=eq.${pairingId}` },
      (payload) => {
        if (feedList.querySelector('.feed-empty')) feedList.innerHTML = '';
        renderItem(payload.new, true);
      }
    )
    .subscribe();
}

function renderItem(item, prepend) {
  const li = document.createElement('li');
  li.className = 'feed-item';

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = `<span>${item.type} \u00b7 ${item.sender === 'pc' ? 'from computer' : 'from phone'}</span><span>${formatTime(item.created_at)}</span>`;

  const body = document.createElement('div');
  body.className = 'body';
  if (item.type === 'image') {
    const img = document.createElement('img');
    img.src = item.content;
    body.appendChild(img);
  } else {
    body.textContent = item.content;
  }

  li.append(meta, body);
  li.addEventListener('click', () => openItem(item));
  prepend ? feedList.prepend(li) : feedList.appendChild(li);
}

function openItem(item) {
  if (item.type === 'link') window.open(item.content, '_blank');
  else if (item.type === 'image') window.open(item.content, '_blank');
  else navigator.clipboard?.writeText(item.content);
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ---------- phone -> pc ----------

document.getElementById('pcSendBtn').addEventListener('click', sendFromPhone);
document.getElementById('pcTextInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendFromPhone();
});

async function sendFromPhone() {
  const input = document.getElementById('pcTextInput');
  const text = input.value.trim();
  if (!text || !pairingId) return;
  const type = /^https?:\/\//i.test(text) ? 'link' : 'text';
  const { error } = await supabase.from('items').insert({ pairing_id: pairingId, type, content: text, sender: 'phone' });
  if (error) {
    console.error('Link Share: send failed', error);
    return;
  }
  input.value = '';
  showPlanBanner(pairingId);
}

// ---------- install prompt ----------

let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  if (pairingId) document.getElementById('installBanner').classList.remove('hidden');
});

function maybeShowInstallBanner() {
  if (deferredInstallPrompt) document.getElementById('installBanner').classList.remove('hidden');
}

document.getElementById('installBtn').addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  document.getElementById('installBanner').classList.add('hidden');
});

document.getElementById('dismissInstall').addEventListener('click', () => {
  document.getElementById('installBanner').classList.add('hidden');
});

// ---------- service worker / notifications ----------

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(console.error);
  }
}

function maybeRequestNotifications() {
  // Best-effort: lets the phone receive a push when it's not the active tab.
  // Requires the optional VAPID + edge function setup described in backend/README.md.
  if ('Notification' in window && Notification.permission === 'default') {
    // Ask lazily on first real interaction rather than immediately on load.
    document.body.addEventListener(
      'click',
      () => Notification.requestPermission().catch(() => {}),
      { once: true }
    );
  }
}
