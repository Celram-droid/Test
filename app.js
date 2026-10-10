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
let activeView = 'settings';
let previousRoomStatus = '';

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
  // Alle gelieferten Wissensfragen dürfen schon gezogen werden.
  // Solange eine echte Lösung fehlt, zeigt die Webseite später nur "Antwort kommt noch".
  return DATA.wissen || [];
}

function sortedPlayers() {
  return Object.entries(roomState?.players || {}).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
}

function rolePayload(item) {
  return item ? { id: item.id, title: item.title } : null;
}

function roleInfo(role) {
  if (!role?.id) return null;
  return contentBy('rolle', role.id);
}

function ruleInfo(ruleId) {
  return contentBy('regel', ruleId);
}

function showInfoDialog(kicker, title, text) {
  const dialog = $('infoDialog');
  $('infoDialogKicker').textContent = kicker || '';
  $('infoDialogTitle').textContent = title || '';
  $('infoDialogText').textContent = text || 'Keine weitere Erklärung vorhanden.';
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function showRoleInfo(role) {
  const info = roleInfo(role);
  showInfoDialog('Titel / Rolle', info?.title || role?.title || 'Rolle', info?.text || 'Keine weitere Erklärung vorhanden.');
}

function showRuleInfo(ruleId, ruleData = null) {
  const info = ruleInfo(ruleData?.sourceId || ruleId);
  const title = ruleData?.title || info?.title || 'Regel';
  const text = ruleData?.text || info?.text || 'Keine weitere Erklärung vorhanden.';
  showInfoDialog('Aktive Regel', title, text);
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
  if (!['lobby', 'playing'].includes(meta.status)) throw new Error('Dieser Lobby kann derzeit nicht beigetreten werden.');

  await set(ref(db, `rooms/${code}/players/${myUid()}`), { name, joinedAt: now() });
  saveSession(code, name);
  openRoom(code);
}

function openRoom(code) {
  roomCode = code;
  activeView = 'settings';
  previousRoomStatus = '';
  if (unsubscribeRoom) unsubscribeRoom();
  show('home', false);
  show('room', true);
  $('roomCode').textContent = code;

  const link = new URL(window.location.href);
  link.searchParams.set('room', code);
  $('inviteLink').href = link.href;
  $('inviteLink').textContent = link.href;
  renderInviteQr(link.href);

  unsubscribeRoom = onValue(ref(db, `rooms/${code}`), snapshot => {
    roomState = snapshot.val();
    if (!roomState) {
      clearSession();
      alertUser('Die Lobby wurde beendet.', false);
      goHome();
      return;
    }
    if (!roomState.players?.[myUid()]) {
      clearSession();
      alertUser('Du wurdest aus der Lobby entfernt.', false);
      signOut(auth).catch(() => {});
      goHome();
      return;
    }
    renderRoom();
  }, error => alertUser(`Firebase-Fehler: ${error.message}`, true));
}


function renderInviteQr(url) {
  const target = $('qrCode');
  if (!target) return;
  target.replaceChildren();
  if (!window.LocalQR?.render) {
    target.textContent = 'QR-Code konnte nicht geladen werden.';
    return;
  }
  try {
    window.LocalQR.render(target, url, {
      size: 190,
      dark: '#17132f',
      light: '#ffffff',
      label: `QR-Code für Lobby ${roomCode}`
    });
  } catch (error) {
    console.error(error);
    target.textContent = 'QR-Code konnte nicht erstellt werden.';
  }
}

function goHome() {
  if (unsubscribeRoom) unsubscribeRoom();
  unsubscribeRoom = null;
  roomCode = '';
  roomState = null;
  activeView = 'settings';
  previousRoomStatus = '';
  show('home', true);
  show('room', false);
}

async function leaveLobby() {
  if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
  if (roomState?.players?.[myUid()]) {
    await remove(ref(db, `rooms/${roomCode}/players/${myUid()}`));
  }
  clearSession();
  await signOut(auth).catch(() => {});
  goHome();
}

async function kickPlayer(uid) {
  if (!roomState?.players?.[myUid()]) throw new Error('Du bist nicht Teil dieser Lobby.');
  if (uid === myUid()) throw new Error('Nutze für dich selbst „Lobby verlassen“.');
  const player = roomState?.players?.[uid];
  if (!player) return;
  if (!confirm(`${player.name} wirklich aus der Lobby entfernen?`)) return;
  await remove(ref(db, `rooms/${roomCode}/players/${uid}`));
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

function setRoomView(view) {
  const playing = roomState?.meta?.status === 'playing';
  if (view === 'game' && !playing) view = 'settings';
  activeView = view;

  show('gameView', activeView === 'game');
  show('settingsView', activeView === 'settings');

  const gameButton = $('gameTabBtn');
  const settingsButton = $('settingsTabBtn');
  gameButton.disabled = !playing;
  gameButton.classList.toggle('active', activeView === 'game');
  settingsButton.classList.toggle('active', activeView === 'settings');
}

function renderRoom() {
  renderPlayers();
  renderGamePlayers();
  renderActiveRules();
  const status = roomState.meta?.status || 'lobby';
  const inLobby = status === 'lobby';

  renderLobbyActions(inLobby);
  $('inviteWrap').classList.remove('hidden');
  show('gameArea', !inLobby);
  if (!inLobby) renderGame();

  // In der Lobby stehen die Einstellungen im Vordergrund. Sobald das Spiel
  // startet, wechselt die Oberfläche automatisch auf die Spielansicht.
  if (!previousRoomStatus) activeView = inLobby ? 'settings' : 'game';
  if (previousRoomStatus === 'lobby' && status === 'playing') activeView = 'game';
  if (inLobby) activeView = 'settings';
  previousRoomStatus = status;
  setRoomView(activeView);
}

function renderPlayers() {
  const el = $('playerList');
  el.replaceChildren();
  const entries = sortedPlayers();
  if (!entries.length) {
    el.textContent = 'Noch niemand in der Lobby.';
    return;
  }
  for (const [uid, player] of entries) {
    const card = node('div', '', 'player-card');
    const nameWrap = node('span', '');
    nameWrap.append(document.createTextNode(`${player.name}${uid === myUid() ? ' (du)' : ''}`));
    if (player.role?.title) {
      nameWrap.append(document.createTextNode(' · '));
      const roleButton = node('button', `👑 ${player.role.title}`, 'role-inline');
      roleButton.type = 'button';
      roleButton.onclick = () => showRoleInfo(player.role);
      nameWrap.append(roleButton);
    }
    card.append(nameWrap);
    if (uid !== myUid()) {
      const kick = node('button', '✕', 'danger kick-btn');
      kick.type = 'button';
      kick.title = `${player.name} aus der Lobby entfernen`;
      kick.setAttribute('aria-label', `${player.name} aus der Lobby entfernen`);
      kick.onclick = action(() => kickPlayer(uid));
      card.append(kick);
    }
    el.append(card);
  }
}

function renderGamePlayers() {
  const panel = $('gamePlayersPanel');
  const el = $('gamePlayerList');
  const playing = roomState?.meta?.status === 'playing';
  show('gamePlayersPanel', playing);
  if (!panel || !el) return;

  el.replaceChildren();
  const entries = sortedPlayers();
  if (!entries.length) {
    el.textContent = 'Noch niemand in der Lobby.';
    return;
  }

  for (const [uid, player] of entries) {
    const card = node('div', '', 'game-player-card');
    card.append(document.createTextNode(`${player.name}${uid === myUid() ? ' (du)' : ''}`));
    if (player.role?.title) {
      card.append(document.createTextNode(' · '));
      const roleButton = node('button', `👑 ${player.role.title}`, 'role-inline');
      roleButton.type = 'button';
      roleButton.onclick = () => showRoleInfo(player.role);
      card.append(roleButton);
    }
    el.append(card);
  }
}

function renderActiveRules() {
  const panel = $('activeRulesPanel');
  const el = $('activeRuleList');
  const playing = roomState?.meta?.status === 'playing';
  show('activeRulesPanel', playing);
  if (!panel || !el) return;

  el.replaceChildren();
  const entries = Object.entries(roomState?.activeRules || {}).sort((a, b) => (a[1].addedAt || 0) - (b[1].addedAt || 0));
  if (!entries.length) {
    el.append(node('div', 'Keine aktiven Regeln.', 'muted'));
    return;
  }

  for (const [ruleId, rule] of entries) {
    const row = node('div', '', 'active-rule-card');
    const info = node('button', `📜 ${rule.title || ruleInfo(ruleId)?.title || 'Regel'}`, 'info-link');
    info.type = 'button';
    info.onclick = () => showRuleInfo(ruleId, rule);
    const removeButton = node('button', '✕', 'danger rule-remove-btn');
    removeButton.type = 'button';
    removeButton.title = 'Regel deaktivieren';
    removeButton.setAttribute('aria-label', `${rule.title || 'Regel'} deaktivieren`);
    removeButton.onclick = action(async () => {
      if (!confirm(`Regel „${rule.title || 'Regel'}“ wirklich deaktivieren?`)) return;
      await remove(ref(db, `rooms/${roomCode}/activeRules/${ruleId}`));
    });
    row.append(info, removeButton);
    el.append(row);
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
    const button = node('button', label, `category-btn category-${key}`);
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
    if (!available.length) throw new Error('Es sind keine Wissensfragen vorhanden.');
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

  // Regeln werden dauerhaft als aktiv gespeichert, bis jemand sie mit X deaktiviert
  // oder ein passendes Ereignis sie entfernt/ersetzt.
  if (category === 'regel' && item.id !== 'regel_035_erstelle_eine_eigene_regel') {
    await set(ref(db, `rooms/${roomCode}/activeRules/${item.id}`), {
      id: item.id,
      title: item.title,
      addedBy: myUid(),
      addedAt: now()
    });
  }

  // Eine gezogene Rolle gehört der Person, die sie auf ihrem Handy gezogen hat.
  // Eine spätere Rolle ersetzt automatisch die bisherige Rolle dieser Person.
  if (category === 'rolle') {
    await set(ref(db, `rooms/${roomCode}/players/${myUid()}/role`), rolePayload(item));
  }
}

async function finishEventAction(resultText, updates = {}) {
  updates['current/eventResolved'] = true;
  updates['current/eventResult'] = resultText;
  await update(ref(db, `rooms/${roomCode}`), updates);
}

function selectControl(labelText, options, placeholder = 'Person auswählen') {
  const wrap = node('label', '');
  wrap.append(document.createTextNode(labelText));
  const select = document.createElement('select');
  const first = document.createElement('option');
  first.value = '';
  first.textContent = placeholder;
  select.append(first);
  for (const option of options) {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.label;
    select.append(el);
  }
  wrap.append(select);
  return { wrap, select };
}

function eventActor(current) {
  const uid = current?.startedBy;
  return { uid, player: roomState?.players?.[uid] || null };
}

async function assignRandomRole(uid) {
  const item = randomItem(DATA.rollen || []);
  if (!item) throw new Error('Es sind keine Rollen vorhanden.');
  await finishEventAction(`Neuer Titel: ${item.title}`, {
    [`players/${uid}/role`]: rolePayload(item)
  });
}

function renderEventActions(el, current, content) {
  const actor = eventActor(current);
  const actorName = actor.player?.name || 'Die Person';
  const box = node('div', '', 'event-actions');

  if (!actor.uid || !actor.player) {
    box.append(node('div', 'Die Person, die dieses Ereignis gezogen hat, ist nicht mehr in der Lobby. Rollenänderungen können deshalb nicht automatisch ausgeführt werden.', 'notice warn'));
    el.append(box);
    return;
  }

  if (current.eventResolved) {
    box.append(node('div', current.eventResult || 'Ereignis wurde umgesetzt.', 'notice'));
    el.append(box);
    return;
  }

  const allPlayers = sortedPlayers();
  const others = allPlayers.filter(([uid]) => uid !== actor.uid);
  const activeRules = Object.entries(roomState?.activeRules || {});
  let used = true;

  if (content.id === 'ereignis_025_titel_verlieren') {
    box.append(node('div', `Betroffen: ${actorName}`, 'muted'));
    const button = node('button', 'Titel jetzt entfernen');
    button.disabled = !actor.player?.role;
    button.onclick = action(() => finishEventAction(`${actorName} hat keinen Titel mehr.`, {
      [`players/${actor.uid}/role`]: null
    }));
    box.append(button);
    if (!actor.player?.role) box.append(node('div', `${actorName} hat aktuell keinen Titel.`, 'muted'));
  } else if (content.id === 'ereignis_026_titel_tauschen') {
    box.append(node('div', `Titel von ${actorName} mit einer anderen Person tauschen.`, 'muted'));
    const { wrap, select } = selectControl('Mit wem?', others.map(([uid, p]) => ({ value: uid, label: `${p.name}${p.role?.title ? ` · ${p.role.title}` : ' · ohne Titel'}` })));
    const button = node('button', 'Titel tauschen');
    button.onclick = action(async () => {
      const targetUid = select.value;
      if (!targetUid) throw new Error('Bitte eine Person auswählen.');
      const target = roomState.players[targetUid];
      const updates = {
        [`players/${actor.uid}/role`]: target.role || null,
        [`players/${targetUid}/role`]: actor.player?.role || null
      };
      await finishEventAction(`${actorName} und ${target.name} haben ihre Titel getauscht.`, updates);
    });
    box.append(wrap, button);
  } else if (content.id === 'ereignis_027_titel_klauen') {
    const withRole = others.filter(([, p]) => p.role?.title);
    box.append(node('div', `${actorName} übernimmt den Titel einer anderen Person.`, 'muted'));
    const { wrap, select } = selectControl('Titel klauen von', withRole.map(([uid, p]) => ({ value: uid, label: `${p.name} · ${p.role.title}` })), 'Person mit Titel auswählen');
    const button = node('button', 'Titel klauen');
    button.disabled = !withRole.length;
    button.onclick = action(async () => {
      const targetUid = select.value;
      if (!targetUid) throw new Error('Bitte eine Person auswählen.');
      const target = roomState.players[targetUid];
      await finishEventAction(`${actorName} hat den Titel „${target.role.title}“ von ${target.name} übernommen.`, {
        [`players/${actor.uid}/role`]: target.role,
        [`players/${targetUid}/role`]: null
      });
    });
    box.append(wrap, button);
    if (!withRole.length) box.append(node('div', 'Aktuell hat keine andere Person einen Titel.', 'muted'));
  } else if (content.id === 'ereignis_028_titelroulette') {
    const holders = allPlayers.filter(([, p]) => p.role?.title);
    box.append(node('div', 'Wählt für jede Person mit Titel aus, wer links von ihr sitzt. So kann die Webseite die Titel korrekt weitergeben.', 'muted'));
    const mappings = [];
    for (const [sourceUid, source] of holders) {
      const { wrap, select } = selectControl(`Titel von ${source.name} →`, holders.filter(([uid]) => uid !== sourceUid).map(([uid, p]) => ({ value: uid, label: p.name })), 'Person links auswählen');
      mappings.push({ sourceUid, source, select });
      box.append(wrap);
    }
    const button = node('button', 'Titelroulette ausführen');
    button.disabled = holders.length < 2;
    button.onclick = action(async () => {
      const targets = mappings.map(x => x.select.value);
      if (targets.some(v => !v)) throw new Error('Bitte für jede Person auswählen, wer links sitzt.');
      if (new Set(targets).size !== targets.length) throw new Error('Jede Person darf nur einmal als linke Person ausgewählt werden.');
      const updates = {};
      for (const mapping of mappings) updates[`players/${mapping.select.value}/role`] = mapping.source.role;
      await finishEventAction('Titelroulette wurde ausgeführt.', updates);
    });
    box.append(button);
    if (holders.length < 2) box.append(node('div', 'Für das Titelroulette brauchen mindestens zwei Personen einen Titel.', 'muted'));
  } else if (content.id === 'ereignis_029_regel_loschen') {
    const { wrap, select } = selectControl('Welche Regel?', activeRules.map(([id, r]) => ({ value: id, label: r.title || ruleInfo(id)?.title || id })), 'Aktive Regel auswählen');
    const button = node('button', 'Regel entfernen');
    button.disabled = !activeRules.length;
    button.onclick = action(async () => {
      if (!select.value) throw new Error('Bitte eine Regel auswählen.');
      const title = roomState.activeRules[select.value]?.title || ruleInfo(select.value)?.title || 'Regel';
      await finishEventAction(`Regel „${title}“ wurde entfernt.`, { [`activeRules/${select.value}`]: null });
    });
    box.append(wrap, button);
    if (!activeRules.length) box.append(node('div', 'Aktuell ist keine Regel aktiv.', 'muted'));
  } else if (content.id === 'ereignis_030_regelwechsel') {
    const button = node('button', 'Regelwechsel ausführen');
    button.disabled = !activeRules.length;
    button.onclick = action(async () => {
      if (!activeRules.length) throw new Error('Aktuell ist keine Regel aktiv.');
      const [oldId, oldRule] = randomItem(activeRules);
      const blocked = new Set(activeRules.map(([id]) => id));
      const candidates = (DATA.regeln || []).filter(rule => !blocked.has(rule.id) && rule.id !== oldId && rule.id !== 'regel_035_erstelle_eine_eigene_regel');
      const fallback = (DATA.regeln || []).filter(rule => rule.id !== oldId && rule.id !== 'regel_035_erstelle_eine_eigene_regel');
      const replacement = randomItem(candidates.length ? candidates : fallback);
      if (!replacement) throw new Error('Es konnte keine neue Regel gefunden werden.');
      await finishEventAction(`„${oldRule.title}“ wurde durch „${replacement.title}“ ersetzt.`, {
        [`activeRules/${oldId}`]: null,
        [`activeRules/${replacement.id}`]: { id: replacement.id, title: replacement.title, addedBy: myUid(), addedAt: now() }
      });
    });
    box.append(button);
    if (!activeRules.length) box.append(node('div', 'Aktuell ist keine Regel aktiv.', 'muted'));
  } else if (content.id === 'ereignis_036_gruppenentscheidung' || content.id === 'ereignis_047_freie_wahl') {
    box.append(node('div', `Nur anklicken, wenn ${actorName} die Option „neuer Titel“ wählt.`, 'muted'));
    const button = node('button', 'Neuen Titel ziehen');
    button.onclick = action(() => assignRandomRole(actor.uid));
    box.append(button);
  } else if (content.id === 'ereignis_048_opfer') {
    box.append(node('div', `Nur anklicken, wenn ${actorName} für die 2 Felder den aktuellen Titel abgibt.`, 'muted'));
    const button = node('button', 'Titel abgeben');
    button.disabled = !actor.player?.role;
    button.onclick = action(() => finishEventAction(`${actorName} hat den Titel abgegeben.`, {
      [`players/${actor.uid}/role`]: null
    }));
    box.append(button);
    if (!actor.player?.role) box.append(node('div', `${actorName} hat aktuell keinen Titel.`, 'muted'));
  } else {
    used = false;
  }

  if (used) el.append(box);
}

function contentCard(title, text, kicker = '', category = '') {
  const card = node('div', '', `content-card${category ? ` card-${category}` : ''}`);
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
    el.append(contentCard('Wissen', content.question, content.subtype || '', 'wissen'));
    if (current.solutionVisible) {
      const hasAnswer = content.answerStatus !== 'placeholder' && content.correctAnswer && content.correctAnswer !== '__NOCH_OFFEN__';
      const answer = hasAnswer
        ? `${content.correctAnswer}${content.unit ? ` ${content.unit}` : ''}`
        : 'Antwort kommt noch';
      el.append(node('div', hasAnswer ? `Antwort: ${answer}` : answer, 'answer-box'));
    } else {
      const reveal = node('button', 'Antwort anzeigen', 'secondary');
      reveal.onclick = action(() => update(ref(db, `rooms/${roomCode}/current`), { solutionVisible: true }));
      el.append(reveal);
    }
  } else if (current.category === 'duell') {
    el.append(contentCard(content.title, content.text, `Duell ${content.mode}`, 'duell'));
  } else if (current.category === 'trinken') {
    el.append(contentCard('Trinken', content.text, '', 'trinken'));
  } else if (current.category === 'regel') {
    el.append(contentCard(content.title, content.text, 'Regel', 'regel'));
    if (content.id === 'regel_035_erstelle_eine_eigene_regel') {
      const editor = node('div', '', 'custom-rule-editor');
      const titleLabel = node('label', 'Titel der eigenen Regel');
      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.maxLength = 120;
      titleInput.placeholder = 'z. B. Niemand darf Vornamen sagen';
      titleInput.value = current.customRuleTitle || '';
      titleLabel.append(titleInput);

      const textLabel = node('label', 'Beschreibung');
      const textInput = document.createElement('textarea');
      textInput.maxLength = 500;
      textInput.rows = 4;
      textInput.placeholder = 'Beschreibe kurz, was ab jetzt gilt.';
      textInput.value = current.customRuleText || '';
      textLabel.append(textInput);

      const saveButton = node('button', current.customRuleKey ? 'Änderungen speichern' : 'Eigene Regel speichern');
      const savedNotice = node('div', '', 'muted');
      if (current.customRuleKey) savedNotice.textContent = 'Diese eigene Regel ist bereits aktiv. Du kannst Titel und Beschreibung hier noch ändern.';

      saveButton.onclick = action(async () => {
        const title = titleInput.value.trim();
        const text = textInput.value.trim();
        if (!title) throw new Error('Bitte einen Titel für die eigene Regel eingeben.');
        if (!text) throw new Error('Bitte eine Beschreibung für die eigene Regel eingeben.');

        const key = current.customRuleKey || `custom_${current.id}`;
        const previousKey = current.customRuleKey || '';
        const ruleData = {
          id: key,
          sourceId: content.id,
          title,
          text,
          custom: true,
          addedBy: current.startedBy || myUid(),
          addedAt: current.customRuleAddedAt || now()
        };
        const updates = {
          [`activeRules/${key}`]: ruleData,
          'current/customRuleKey': key,
          'current/customRuleTitle': title,
          'current/customRuleText': text,
          'current/customRuleAddedAt': ruleData.addedAt
        };
        if (previousKey && previousKey !== key) updates[`activeRules/${previousKey}`] = null;
        await update(ref(db, `rooms/${roomCode}`), updates);
      });

      editor.append(titleLabel, textLabel, saveButton, savedNotice);
      el.append(editor);
    } else if ((content.variables || []).length) {
      el.append(node('div', 'Legt die benötigten Werte oder Personen gemeinsam fest. Die Regel bleibt anschließend unter „Aktive Regeln“ sichtbar.', 'notice'));
    } else {
      el.append(node('div', 'Diese Regel ist jetzt aktiv und bleibt unter „Aktive Regeln“ sichtbar.', 'notice'));
    }
  } else if (current.category === 'rolle') {
    el.append(contentCard(content.title, content.text, 'Titel / Rolle', 'rolle'));
    const owner = roomState.players?.[current.startedBy]?.name || 'Die ziehende Person';
    el.append(node('div', `Der Titel ist bei ${owner} hinterlegt.`, 'notice'));
  } else if (current.category === 'ereignis') {
    el.append(contentCard(content.title, content.text, 'Ereignis', 'ereignis'));
    renderEventActions(el, current, content);
  }

  appendDoneButton(el);
}

function appendDoneButton(el) {
  const done = node('button', 'Fertig → zurück zu den Kategorien');
  done.className = 'full';
  const current = roomState?.current;
  const needsCustomRule = current?.category === 'regel'
    && current?.contentId === 'regel_035_erstelle_eine_eigene_regel'
    && !current?.customRuleKey;
  done.disabled = needsCustomRule;
  if (needsCustomRule) done.title = 'Speichere zuerst deine eigene Regel.';
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
$('gameTabBtn').onclick = () => setRoomView('game');
$('settingsTabBtn').onclick = () => setRoomView('settings');
$('infoDialogClose').onclick = () => $('infoDialog').close();
$('infoDialog').addEventListener('click', event => {
  if (event.target === $('infoDialog')) $('infoDialog').close();
});

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
