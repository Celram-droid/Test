import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, signInAnonymously, signOut } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getDatabase, ref, get, set, update, remove, onValue, runTransaction } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const $ = id => document.getElementById(id);
const show = (id, yes) => $(id).classList.toggle('hidden', !yes);
const node = (tag, text = '', className = '') => {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  return el;
};
const now = () => Date.now();
const randomItem = list => list[Math.floor(Math.random() * list.length)];
const myUid = () => auth.currentUser?.uid || '';

let DATA = null;
let app, auth, db;
let roomCode = '';
let roomState = null;
let unsubscribeRoom = null;

function alertUser(message, error = false) {
  const el = $('message');
  el.textContent = message;
  el.className = message ? `notice${error ? ' error' : ''}` : 'hidden';
  if (message) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function action(fn) {
  return async (...args) => {
    try {
      alertUser('');
      await fn(...args);
    } catch (error) {
      console.error(error);
      alertUser(error?.message || String(error), true);
    }
  };
}

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), n => alphabet[n % alphabet.length]).join('');
}

function cardId() {
  return `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function saveSession(code, name) {
  localStorage.setItem('quizSession', JSON.stringify({ room: code, name }));
}

function getSession() {
  try { return JSON.parse(localStorage.getItem('quizSession') || 'null'); }
  catch { return null; }
}

function clearSession() {
  localStorage.removeItem('quizSession');
}

async function ensureAnonymousAuth() {
  if (!auth.currentUser) await signInAnonymously(auth);
}

async function loadContent() {
  const response = await fetch('./game-data.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('game-data.json konnte nicht geladen werden.');
  DATA = await response.json();
}

function contentBy(category, id) {
  if (!DATA || !id) return null;
  if (category === 'duell') {
    return [...(DATA.duelle?.['1v1'] || []), ...(DATA.duelle?.['2v2'] || [])].find(x => x.id === id) || null;
  }
  const map = { wissen: 'wissen', trinken: 'trinken', regel: 'regeln', rolle: 'rollen', ereignis: 'ereignisse' };
  return (DATA[map[category]] || []).find(x => x.id === id) || null;
}

function activeKnowledge() {
  return (DATA.wissen || []).filter(q => q.active === true && q.answerStatus !== 'placeholder' && q.correctAnswer !== '__NOCH_OFFEN__');
}

async function createRoom() {
  const name = $('playerName').value.trim();
  if (!name || name.length > 24) throw new Error('Bitte einen Namen mit maximal 24 Zeichen eingeben.');
  await ensureAnonymousAuth();

  let code = '';
  for (let i = 0; i < 6; i++) {
    const candidate = makeCode();
    if (!(await get(ref(db, `rooms/${candidate}`))).exists()) { code = candidate; break; }
  }
  if (!code) throw new Error('Es konnte kein freier Spielcode erzeugt werden. Bitte erneut versuchen.');

  const uid = myUid();
  const createdAt = now();
  await set(ref(db, `rooms/${code}`), {
    meta: { status: 'lobby', createdAt, createdBy: uid },
    players: { [uid]: { name, joinedAt: createdAt } }
  });
  saveSession(code, name);
  openRoom(code);
}

async function joinRoom() {
  const name = $('playerName').value.trim();
  const code = $('joinCode').value.trim().toUpperCase();
  if (!name || name.length > 24 || !code) throw new Error('Bitte Name und Spielcode eingeben.');
  await ensureAnonymousAuth();

  const meta = (await get(ref(db, `rooms/${code}/meta`))).val();
  if (!meta) throw new Error('Diese Lobby wurde nicht gefunden.');
  if (meta.status !== 'lobby') throw new Error('Dieses Spiel wurde bereits gestartet.');

  await set(ref(db, `rooms/${code}/players/${myUid()}`), { name, joinedAt: now() });
  saveSession(code, name);
  openRoom(code);
}

function openRoom(code) {
  roomCode = code;
  if (unsubscribeRoom) unsubscribeRoom();
  show('home', false);
  show('room', true);
  $('roomCode').textContent = code;

  const link = new URL(window.location.href);
  link.searchParams.set('room', code);
  $('inviteLink').href = link.href;
  $('inviteLink').textContent = link.href;

  unsubscribeRoom = onValue(ref(db, `rooms/${code}`), snapshot => {
    roomState = snapshot.val();
    if (!roomState) {
      clearSession();
      alertUser('Die Lobby wurde beendet.', false);
      goHome();
      return;
    }
    renderRoom();
  }, error => alertUser(`Firebase-Fehler: ${error.message}`, true));
}

function goHome() {
  if (unsubscribeRoom) unsubscribeRoom();
  unsubscribeRoom = null;
  roomCode = '';
  roomState = null;
  show('home', true);
  show('room', false);
}

async function leaveLobby() {
  if (roomState?.players?.[myUid()]) {
    await remove(ref(db, `rooms/${roomCode}/players/${myUid()}`));
  }
  clearSession();
  await signOut(auth).catch(() => {});
  goHome();
}

async function endLobby() {
  if (!roomState?.players?.[myUid()]) throw new Error('Du bist nicht Teil dieser Lobby.');
  if (!confirm('Lobby wirklich für alle beenden? Alle Mitspieler werden zurück zur Startseite geschickt.')) return;
  await remove(ref(db, `rooms/${roomCode}`));
  clearSession();
  await signOut(auth).catch(() => {});
  goHome();
}

async function startGame() {
  const count = Object.keys(roomState?.players || {}).length;
  if (!roomState?.players?.[myUid()]) throw new Error('Du bist nicht Teil dieser Lobby.');
  if (count < 2) throw new Error('Zum Starten werden mindestens zwei Spieler benötigt.');
  await update(ref(db, `rooms/${roomCode}/meta`), { status: 'playing' });
}

function renderRoom() {
  renderPlayers();
  const inLobby = roomState.meta?.status === 'lobby';
  renderLobbyActions(inLobby);
  $('inviteWrap').classList.toggle('hidden', !inLobby);
  show('gameArea', !inLobby);
  if (!inLobby) renderGame();
}

function renderPlayers() {
  const el = $('playerList');
  el.replaceChildren();
  const entries = Object.entries(roomState?.players || {}).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  if (!entries.length) {
    el.textContent = 'Noch niemand in der Lobby.';
    return;
  }
  for (const [uid, player] of entries) {
    el.append(node('div', `${player.name}${uid === myUid() ? ' (du)' : ''}`, 'player-card'));
  }
}

function renderLobbyActions(inLobby) {
  const el = $('lobbyActions');
  el.replaceChildren();
  if (!inLobby) return;
  const count = Object.keys(roomState.players || {}).length;
  el.append(node('p', `${count} Spieler in der Lobby. Sobald alle da sind, kann jemand das Spiel starten.`, 'muted'));
  const button = node('button', 'Spiel starten');
  button.disabled = count < 2;
  button.onclick = action(startGame);
  el.append(button);
}

function renderGame() {
  renderCategoryArea();
  renderCurrentCard();
}

function renderCategoryArea() {
  const el = $('categoryArea');
  el.replaceChildren();
  if (roomState.current) return;

  el.append(node('h2', 'Kategorie auswählen'));
  const grid = node('div', '', 'category-grid');
  const categories = [
    ['wissen', '🧠 Wissen'],
    ['duell', '⚔️ Duell'],
    ['trinken', '🥤 Trinken'],
    ['regel', '📜 Regel'],
    ['rolle', '👑 Titel / Rolle'],
    ['ereignis', '🎲 Ereignis']
  ];

  for (const [key, label] of categories) {
    const button = node('button', label);
    if (key === 'wissen' && activeKnowledge().length === 0) {
      button.title = 'Noch keine Wissensfragen mit fertiger Lösung aktiviert.';
    }
    button.onclick = action(() => drawCard(key));
    grid.append(button);
  }
  el.append(grid);
}

async function drawCard(category) {
  if (!roomState?.players?.[myUid()]) throw new Error('Du bist nicht Teil dieser Lobby.');
  if (roomState.current) throw new Error('Es ist bereits eine Karte geöffnet.');

  let item;
  if (category === 'wissen') {
    const available = activeKnowledge();
    if (!available.length) throw new Error('Aktuell ist noch keine Wissensfrage mit fertiger Lösung aktiviert.');
    item = randomItem(available);
  } else if (category === 'duell') {
    const one = DATA.duelle?.['1v1'] || [];
    const two = Object.keys(roomState.players || {}).length >= 4 ? (DATA.duelle?.['2v2'] || []) : [];
    item = randomItem([...one, ...two]);
  } else {
    const key = { trinken: 'trinken', regel: 'regeln', rolle: 'rollen', ereignis: 'ereignisse' }[category];
    item = randomItem(DATA[key] || []);
  }

  if (!item) throw new Error('Für diese Kategorie sind keine Inhalte vorhanden.');

  const nextCard = {
    id: cardId(),
    category,
    contentId: item.id,
    startedBy: myUid(),
    startedAt: now(),
    solutionVisible: false
  };

  const result = await runTransaction(ref(db, `rooms/${roomCode}/current`), current => {
    if (current) return;
    return nextCard;
  });
  if (!result.committed) throw new Error('Jemand anderes hat gerade bereits eine Karte gezogen.');
}

function contentCard(title, text, kicker = '') {
  const card = node('div', '', 'content-card');
  if (kicker) card.append(node('div', kicker, 'muted'));
  card.append(node('h2', title), node('p', text, 'big'));
  return card;
}

function renderCurrentCard() {
  const el = $('currentArea');
  el.replaceChildren();
  const current = roomState.current;
  if (!current) return;

  const content = contentBy(current.category, current.contentId);
  if (!content) {
    el.append(node('div', 'Der Inhalt dieser Karte wurde in game-data.json nicht gefunden.', 'notice error'));
    appendDoneButton(el);
    return;
  }

  if (current.category === 'wissen') {
    el.append(contentCard('Wissen', content.question, content.subtype || ''));
    if (current.solutionVisible) {
      const answer = `${content.correctAnswer}${content.unit ? ` ${content.unit}` : ''}`;
      el.append(node('div', `Lösung: ${answer}`, 'notice'));
    } else {
      const reveal = node('button', 'Lösung anzeigen', 'secondary');
      reveal.onclick = action(() => update(ref(db, `rooms/${roomCode}/current`), { solutionVisible: true }));
      el.append(reveal);
    }
  } else if (current.category === 'duell') {
    el.append(contentCard(content.title, content.text, `Duell ${content.mode}`));
  } else if (current.category === 'trinken') {
    el.append(contentCard('Trinken', content.text));
  } else if (current.category === 'regel') {
    el.append(contentCard(content.title, content.text, 'Regel'));
    if ((content.variables || []).length) {
      el.append(node('div', 'Legt die benötigten Werte oder Personen gemeinsam fest. Die Webseite speichert die Regel nicht.', 'notice'));
    }
  } else if (current.category === 'rolle') {
    el.append(contentCard(content.title, content.text, 'Titel / Rolle'));
  } else if (current.category === 'ereignis') {
    el.append(contentCard(content.title, content.text, 'Ereignis'));
  }

  appendDoneButton(el);
}

function appendDoneButton(el) {
  const done = node('button', 'Fertig → zurück zu den Kategorien');
  done.className = 'full';
  done.onclick = action(async () => {
    if (!roomState?.players?.[myUid()]) throw new Error('Du bist nicht Teil dieser Lobby.');
    await remove(ref(db, `rooms/${roomCode}/current`));
  });
  el.append(done);
}

$('createRoomBtn').onclick = action(createRoom);
$('joinBtn').onclick = action(joinRoom);
$('leaveLobbyBtn').onclick = action(leaveLobby);
$('endLobbyBtn').onclick = action(endLobby);

try {
  await loadContent();
  const placeholders = [firebaseConfig.apiKey, firebaseConfig.databaseURL, firebaseConfig.appId].some(v => !v || String(v).startsWith('HIER_'));
  if (placeholders) throw new Error('Bitte zuerst firebase-config.js mit API-Key, Realtime-Database-URL und App-ID ausfüllen.');

  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getDatabase(app);
  await auth.authStateReady();

  const invite = new URLSearchParams(location.search).get('room');
  if (invite) $('joinCode').value = invite.toUpperCase();

  const session = getSession();
  const inviteCode = invite?.toUpperCase() || '';
  if (session?.room && auth.currentUser && (!inviteCode || session.room === inviteCode)) {
    const player = (await get(ref(db, `rooms/${session.room}/players/${myUid()}`))).val();
    if (player) {
      $('playerName').value = session.name || player.name || '';
      openRoom(session.room);
    } else {
      clearSession();
    }
  } else if (session?.name) {
    $('playerName').value = session.name;
  }
} catch (error) {
  console.error(error);
  alertUser(error.message || String(error), true);
}
