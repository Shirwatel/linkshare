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

  const stored = localStorage.getItem(PAIRING_ID_KEY);
  if (stored) return enterFeed(stored);

  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  if (code) return connectWithCode(code, true);

  showView(pairView);
}

function showView(view) {
  [pairView, connectingView, feedView].forEach((v) => v.classList.add('hidden'));
  view.classList.remove('hidden');
}

// ---------- pairing ----------

async function connectWithCode(code, fromQr) {
  showView(fromQr ? connectingView : pairView);
  pairError.textContent = '';

  const { data, error } = await supabase
    .from('pairings')
    .select('id, code_expires_at, phone_connected')
    .eq('pairing_code', code)
    .maybeSingle();

  if (error) {
    pairError.textContent = `Couldn't reach the server: ${error.message || JSON.stringify(error)}`;
    console.error('Link Share connect error:', error);
    return showView(pairView);
  }
  if (!data) {
    pairError.textContent = 'No pairing found for that code. Double-check the extension and try again.';
    return showView(pairView);
  }
  if (new Date(data.code_expires_at) < new Date()) {
    pairError.textContent = 'That code expired \u2014 open the extension for a new one.';
    return showView(pairView);
  }

  await supabase.from('pairings').update({ phone_connected: true }).eq('id', data.id);
  localStorage.setItem(PAIRING_ID_KEY, data.id);
  enterFeed(data.id);
}

document.getElementById('connectBtn').addEventListener('click', () => {
  const code = document.getElementById('codeInput').value.trim();
  if (code.length === 6) connectWithCode(code, false);
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
  await loadFeed();
  subscribeRealtime();
  maybeShowInstallBanner();
  maybeRequestNotifications();
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
  await supabase.from('items').insert({ pairing_id: pairingId, type, content: text, sender: 'phone' });
  input.value = '';
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
