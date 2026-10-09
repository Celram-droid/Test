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
const clone = value => JSON.parse(JSON.stringify(value));
const randomItem = list => list[Math.floor(Math.random() * list.length)];
const nameOf = uid => roomState?.players?.[uid]?.name || 'Unbekannt';
const myUid = () => auth.currentUser?.uid || '';
const amActive = () => roomState?.game?.activeUid === myUid();
const playersInOrder = () => (roomState?.game?.order || Object.keys(roomState?.players || {})).filter(uid => roomState?.players?.[uid]);

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

function roundId() {
  return `r_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
  if (category === 'duell') return [...(DATA.duelle?.['1v1'] || []), ...(DATA.duelle?.['2v2'] || [])].find(x => x.id === id) || null;
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
    players: { [uid]: { name, joinedAt: createdAt } },
    game: { phase: 'lobby' }
  });
  saveSession(code, name);
  openRoom(code);
}

async function joinRoom() {
  const name = $('playerName').value.trim();
  const code = $('joinCode').value.trim().toUpperCase();
  if (!name || name.length > 24 || !code) throw new Error('Bitte Name und Spielcode eingeben.');
  await ensureAnonymousAuth();
  const snapshot = await get(ref(db, `rooms/${code}/meta`));
  const meta = snapshot.val();
  if (!meta) throw new Error('Dieses Spiel wurde nicht gefunden.');
  if (meta.status !== 'lobby') throw new Error('Dieses Spiel wurde bereits gestartet oder geschlossen.');
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
      alertUser('Dieses Spiel existiert nicht mehr.', true);
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
  if (!roomState) return;
  if (roomState.meta?.status === 'lobby' && roomState.players?.[myUid()]) {
    await remove(ref(db, `rooms/${roomCode}/players/${myUid()}`));
  }
  clearSession();
  await signOut(auth).catch(() => {});
  goHome();
}

async function startGame() {
  if (!roomState?.players?.[myUid()]) throw new Error('Du bist nicht Teil dieser Lobby.');
  const entries = Object.entries(roomState.players || {}).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  if (entries.length < 2) throw new Error('Zum Starten werden mindestens zwei Spieler benötigt.');
  const order = entries.map(([uid]) => uid);
  const gameRef = ref(db, `rooms/${roomCode}/game`);
  const result = await runTransaction(gameRef, current => {
    if (!current || current.phase !== 'lobby') return;
    return {
      phase: 'playing',
      order,
      activeIndex: 0,
      activeUid: order[0],
      turnNumber: 1,
      titles: {},
      effects: {},
      lastNotice: `Das Spiel beginnt. ${nameOf(order[0])} ist zuerst dran.`
    };
  });
  if (!result.committed) throw new Error('Das Spiel wurde bereits von jemand anderem gestartet.');
  await update(ref(db, `rooms/${roomCode}/meta`), { status: 'playing' });
}

function renderRoom() {
  const players = roomState.players || {};
  const game = roomState.game || { phase: 'lobby' };
  renderPlayers(players, game);
  const inLobby = roomState.meta?.status === 'lobby' && game.phase !== 'playing';
  $('leaveLobbyBtn').classList.toggle('hidden', !inLobby);
  renderLobbyActions(inLobby);
  show('gameArea', game.phase === 'playing');
  if (game.phase === 'playing') renderGame();
}

function renderPlayers(players, game) {
  const el = $('playerList');
  el.replaceChildren();
  const entries = Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  if (!entries.length) {
    el.textContent = 'Noch niemand in der Lobby.';
    return;
  }
  for (const [uid, player] of entries) {
    const card = node('div', '', `box player-card${game.activeUid === uid ? ' active' : ''}`);
    const left = node('div');
    const name = node('strong', `${player.name}${uid === myUid() ? ' (du)' : ''}`);
    left.append(name);
    if (game.activeUid === uid) left.append(node('div', 'Aktiver Spieler', 'muted'));
    const right = node('div', '', 'player-meta');
    const title = game.titles?.[uid];
    if (title) right.append(node('span', `👑 ${title.title}`, 'tag'));
    const effects = Object.values(game.effects?.[uid] || {});
    for (const effect of effects) right.append(node('span', `⚡ ${effect.label}`, 'tag'));
    card.append(left, right);
    el.append(card);
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
  const game = roomState.game;
  const activeName = nameOf(game.activeUid);
  const header = $('turnHeader');
  header.replaceChildren();
  header.append(node('h2', `Zug ${game.turnNumber || 1}: ${activeName}`));
  if (game.lastNotice) header.append(node('div', game.lastNotice, 'notice'));

  renderStateOverview();
  renderCategoryArea();
  renderCurrentRound();
  renderEndTurn();
  renderActiveRules();
  renderTitlesEffects();
}

function renderStateOverview() {
  const el = $('stateOverview');
  el.replaceChildren();
  const ruleCount = Object.keys(roomState.activeRules || {}).length;
  const titleCount = Object.keys(roomState.game?.titles || {}).length;
  const a = node('div', '', 'box'); a.append(node('strong', `${ruleCount} aktive Regel${ruleCount === 1 ? '' : 'n'}`));
  const b = node('div', '', 'box'); b.append(node('strong', `${titleCount} aktive${titleCount === 1 ? 'r' : ''} Titel`));
  el.append(a, b);
}

function renderCategoryArea() {
  const el = $('categoryArea');
  el.replaceChildren();
  const current = roomState.current;
  if (current && current.status !== 'resolved') return;
  if (current?.status === 'resolved') return;
  if (!amActive()) {
    el.append(node('div', `${nameOf(roomState.game.activeUid)} wählt die Feldkategorie.`, 'notice'));
    return;
  }
  el.append(node('h3', 'Auf welchem Feld bist du gelandet?'));
  const grid = node('div', '', 'category-grid');
  const categories = [
    ['wissen', '🧠 Wissen'], ['duell', '⚔️ Duell'], ['trinken', '🥤 Trinken'],
    ['regel', '📜 Regel'], ['rolle', '👑 Titel / Rolle'], ['ereignis', '🎲 Ereignis']
  ];
  for (const [key, label] of categories) {
    const button = node('button', label);
    if (key === 'wissen' && activeKnowledge().length === 0) button.title = 'Noch keine Wissensfragen mit fertiger Lösung aktiviert.';
    button.onclick = action(() => startCategory(key));
    grid.append(button);
  }
  el.append(grid);
}

async function startCategory(category) {
  if (!amActive()) throw new Error('Nur die aktive Person darf eine Kategorie starten.');
  if (roomState.current && roomState.current.status !== 'resolved') throw new Error('Die aktuelle Runde ist noch nicht abgeschlossen.');
  let item;
  if (category === 'wissen') {
    const available = activeKnowledge();
    if (!available.length) throw new Error('Aktuell ist noch keine Wissensfrage aktiviert. Trage später in game-data.json die echten Lösungen ein und setze active auf true.');
    item = randomItem(available);
  } else if (category === 'duell') {
    const one = DATA.duelle?.['1v1'] || [];
    const two = Object.keys(roomState.players || {}).length >= 4 ? (DATA.duelle?.['2v2'] || []) : [];
    item = randomItem([...one, ...two]);
  } else {
    const key = { trinken: 'trinken', regel: 'regeln', rolle: 'rollen', ereignis: 'ereignisse' }[category];
    let available = [...(DATA[key] || [])];
    if (category === 'regel') {
      const activeIds = new Set(Object.values(roomState.activeRules || {}).map(r => r.contentId));
      const unused = available.filter(r => !activeIds.has(r.id));
      if (unused.length) available = unused;
    }
    item = randomItem(available);
  }
  if (!item) throw new Error('Für diese Kategorie sind keine Inhalte vorhanden.');
  await set(ref(db, `rooms/${roomCode}/current`), {
    id: roundId(),
    category,
    contentId: item.id,
    status: 'active',
    startedBy: myUid(),
    startedAt: now()
  });
}

function renderCurrentRound() {
  const el = $('currentArea');
  el.replaceChildren();
  const current = roomState.current;
  if (!current) return;
  const content = contentBy(current.category, current.contentId);
  if (!content) {
    el.append(node('div', 'Der Inhalt dieser Runde wurde in game-data.json nicht gefunden.', 'notice error'));
    return;
  }
  if (current.category === 'wissen') renderKnowledge(el, current, content);
  else if (current.category === 'duell') renderDuel(el, current, content);
  else if (current.category === 'trinken') renderDrink(el, current, content);
  else if (current.category === 'regel') renderRule(el, current, content);
  else if (current.category === 'rolle') renderRole(el, current, content);
  else if (current.category === 'ereignis') renderEvent(el, current, content);
}

function contentCard(title, text, kicker = '') {
  const card = node('div', '', 'content-card');
  if (kicker) card.append(node('div', kicker, 'muted'));
  card.append(node('h2', title), node('p', text, 'big'));
  return card;
}

async function resolveCurrent(extra = {}) {
  if (!amActive()) throw new Error('Nur die aktive Person kann diese Runde abschließen.');
  await update(ref(db, `rooms/${roomCode}/current`), { status: 'resolved', resolvedAt: now(), ...extra });
}

function renderDrink(el, current, content) {
  el.append(contentCard('Trinken', content.text));
  if (current.status === 'active' && amActive()) {
    const button = node('button', 'Erledigt');
    button.onclick = action(() => resolveCurrent());
    el.append(button);
  }
}

function renderRole(el, current, content) {
  el.append(contentCard(content.title, content.text, 'Neuer Titel / neue Rolle'));
  if (current.status === 'active' && amActive()) {
    const button = node('button', 'Titel übernehmen');
    button.onclick = action(async () => {
      await set(ref(db, `rooms/${roomCode}/game/titles/${myUid()}`), { id: content.id, title: content.title, text: content.text, assignedAt: now() });
      await resolveCurrent({ resultText: `${nameOf(myUid())} trägt jetzt den Titel „${content.title}“.` });
    });
    el.append(button);
  }
  if (current.resultText) el.append(node('div', current.resultText, 'notice'));
}

function variableLabel(key) {
  return ({ platz: 'Festgelegter Platz', wort: 'Festgelegtes Wort', antwortwort: 'Antwortwort', zahl: 'Verbotene Zahl', eigene_regel: 'Eigene Regel' })[key] || key;
}

function buildRuleVariableForm(rule, prefix = 'rule') {
  const wrap = node('div', '', 'stack');
  const variables = rule.variables || [];
  if (!variables.length) return { element: wrap, read: () => ({}) };
  if (variables.includes('neue_namen')) {
    const inputs = {};
    wrap.append(node('strong', 'Neue Namen für alle festlegen:'));
    for (const uid of playersInOrder()) {
      const label = node('label', nameOf(uid));
      const input = document.createElement('input');
      input.placeholder = `Neuer Name für ${nameOf(uid)}`;
      inputs[uid] = input;
      label.append(input); wrap.append(label);
    }
    return { element: wrap, read: () => ({ neue_namen: Object.fromEntries(Object.entries(inputs).map(([uid, input]) => [uid, input.value.trim()])) }) };
  }
  if (variables.includes('trinkbuddy')) {
    const selects = {};
    wrap.append(node('strong', 'Trinkbuddy für jede Person festlegen:'));
    for (const uid of playersInOrder()) {
      const label = node('label', nameOf(uid));
      const select = document.createElement('select');
      for (const other of playersInOrder().filter(x => x !== uid)) select.append(new Option(nameOf(other), other));
      selects[uid] = select;
      label.append(select); wrap.append(label);
    }
    return { element: wrap, read: () => ({ trinkbuddy: Object.fromEntries(Object.entries(selects).map(([uid, select]) => [uid, select.value])) }) };
  }
  const inputs = {};
  for (const key of variables) {
    const label = node('label', variableLabel(key));
    const input = document.createElement(key === 'eigene_regel' ? 'textarea' : 'input');
    if (key === 'zahl') input.type = 'number';
    inputs[key] = input;
    label.append(input); wrap.append(label);
  }
  return { element: wrap, read: () => Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()])) };
}

function validateRuleVariables(rule, values) {
  if (!(rule.variables || []).length) return;
  if (rule.variables.includes('neue_namen')) {
    if (Object.values(values.neue_namen || {}).some(v => !v)) throw new Error('Bitte für jede Person einen neuen Namen eintragen.');
    return;
  }
  if (rule.variables.includes('trinkbuddy')) return;
  for (const key of rule.variables) if (!String(values[key] ?? '').trim()) throw new Error(`Bitte „${variableLabel(key)}“ ausfüllen.`);
}

function renderRule(el, current, content) {
  el.append(contentCard(content.title, content.text, 'Neue Regel'));
  if (current.status === 'active' && amActive()) {
    const form = buildRuleVariableForm(content);
    el.append(form.element);
    const button = node('button', 'Regel aktivieren');
    button.onclick = action(async () => {
      const variables = form.read();
      validateRuleVariables(content, variables);
      const key = `a_${current.id}`;
      await set(ref(db, `rooms/${roomCode}/activeRules/${key}`), {
        contentId: content.id, title: content.title, text: content.text, variables, activatedAt: now(), activatedBy: myUid()
      });
      await resolveCurrent({ resultText: `„${content.title}“ ist jetzt aktiv.` });
    });
    el.append(button);
  }
  if (current.resultText) el.append(node('div', current.resultText, 'notice'));
}

function renderVariableSummary(variables) {
  const wrap = node('div', '', 'muted');
  if (!variables || !Object.keys(variables).length) return wrap;
  const parts = [];
  for (const [key, value] of Object.entries(variables)) {
    if (key === 'neue_namen') parts.push('Neue Namen: ' + Object.entries(value).map(([uid, v]) => `${nameOf(uid)} → ${v}`).join(', '));
    else if (key === 'trinkbuddy') parts.push('Trinkbuddys: ' + Object.entries(value).map(([uid, other]) => `${nameOf(uid)} ↔ ${nameOf(other)}`).join(', '));
    else parts.push(`${variableLabel(key)}: ${value}`);
  }
  wrap.textContent = parts.join(' · ');
  return wrap;
}

function renderActiveRules() {
  const el = $('activeRules');
  el.replaceChildren();
  const rules = Object.values(roomState.activeRules || {});
  if (!rules.length) { el.append(node('p', 'Noch keine aktive Regel.', 'muted')); return; }
  for (const rule of rules) {
    const card = node('div', '', 'box rule-card');
    card.append(node('strong', rule.title), node('p', rule.text));
    card.append(renderVariableSummary(rule.variables));
    el.append(card);
  }
}

function renderTitlesEffects() {
  const el = $('titlesEffects');
  el.replaceChildren();
  for (const uid of playersInOrder()) {
    const box = node('div', '', 'box');
    box.append(node('strong', nameOf(uid)));
    const title = roomState.game.titles?.[uid];
    box.append(node('p', title ? `Titel: ${title.title} – ${title.text}` : 'Titel: keiner'));
    const effectEntries = Object.entries(roomState.game.effects?.[uid] || {});
    if (!effectEntries.length) {
      box.append(node('p', 'Effekte: keine', 'muted'));
    } else {
      box.append(node('p', `Effekte: ${effectEntries.map(([, e]) => e.label).join(', ')}`, 'muted'));
      if (uid === myUid()) {
        const controls = node('div', '', 'row');
        for (const [key, effect] of effectEntries) {
          if (key === 'pause') continue;
          const consume = node('button', `${effect.label} verbraucht`, 'secondary');
          consume.onclick = action(async () => {
            if (!confirm(`Effekt „${effect.label}“ wirklich als verbraucht markieren?`)) return;
            await remove(ref(db, `rooms/${roomCode}/game/effects/${uid}/${key}`));
          });
          controls.append(consume);
        }
        if (controls.childElementCount) box.append(controls);
      }
    }
    el.append(box);
  }
}

function renderKnowledge(el, current, content) {
  el.append(contentCard('Wissen', content.question, content.subtype || ''));
  if (current.status === 'active') {
    const answers = current.answers || {};
    if (!answers[myUid()]) {
      const wrap = node('div', '', 'stack');
      let getValue;
      if (content.answerType === 'single_choice') {
        let selected = '';
        for (const option of content.options || []) {
          const button = node('button', option, 'answer-option');
          button.onclick = () => {
            selected = option;
            wrap.querySelectorAll('.answer-option').forEach(x => x.classList.toggle('selected', x === button));
          };
          wrap.append(button);
        }
        getValue = () => selected;
      } else {
        const input = document.createElement('input');
        input.type = 'number';
        input.step = 'any';
        input.placeholder = content.unit ? `Deine Schätzung (${content.unit})` : 'Deine Schätzung';
        wrap.append(input);
        getValue = () => input.value;
      }
      const submit = node('button', 'Antwort abgeben');
      submit.onclick = action(async () => {
        const value = String(getValue()).trim();
        if (!value) throw new Error('Bitte zuerst eine Antwort eingeben.');
        await set(ref(db, `rooms/${roomCode}/current/answers/${myUid()}`), { value, submittedAt: now() });
      });
      wrap.append(submit); el.append(wrap);
    } else {
      el.append(node('div', `Deine Antwort: ${answers[myUid()].value}`, 'notice'));
    }
    const count = Object.keys(answers).length;
    el.append(node('p', `${count} von ${Object.keys(roomState.players || {}).length} Antworten abgegeben.`, 'muted'));

    const bonus = roomState.game.effects?.[roomState.game.activeUid]?.wissensbonus;
    if (amActive() && bonus) {
      const redraw = node('button', 'Wissensbonus nutzen: neue Frage ziehen', 'secondary');
      redraw.onclick = action(async () => {
        const available = activeKnowledge().filter(q => q.id !== content.id);
        if (!available.length) throw new Error('Es gibt keine weitere aktive Wissensfrage.');
        const next = randomItem(available);
        await remove(ref(db, `rooms/${roomCode}/game/effects/${myUid()}/wissensbonus`));
        await set(ref(db, `rooms/${roomCode}/current`), {
          id: roundId(), category: 'wissen', contentId: next.id, status: 'active', startedBy: myUid(), startedAt: now(), bonusRedraw: true
        });
      });
      el.append(redraw);
    }
    if (amActive()) {
      const reveal = node('button', `Lösung zeigen & auswerten (${count} Antwort${count === 1 ? '' : 'en'})`);
      reveal.disabled = count === 0;
      reveal.onclick = action(async () => {
        if (!confirm('Lösung jetzt zeigen? Danach können keine weiteren Antworten abgegeben werden.')) return;
        const result = evaluateKnowledge(content, answers);
        await resolveCurrent({ result });
      });
      el.append(reveal);
    }
  } else {
    renderKnowledgeResult(el, current, content);
  }
}

function evaluateKnowledge(content, answers) {
  const correct = content.correctAnswer;
  const result = { correctAnswer: String(correct), unit: content.unit || '', winners: [] };
  if (content.answerType === 'number') {
    const target = Number(correct);
    let best = Infinity;
    for (const [uid, a] of Object.entries(answers || {})) {
      const n = Number(a.value);
      if (!Number.isFinite(n) || !Number.isFinite(target)) continue;
      const diff = Math.abs(n - target);
      if (diff < best) { best = diff; result.winners = [uid]; }
      else if (diff === best) result.winners.push(uid);
    }
    result.bestDifference = Number.isFinite(best) ? best : null;
  } else {
    result.winners = Object.entries(answers || {}).filter(([, a]) => String(a.value) === String(correct)).map(([uid]) => uid);
  }
  return result;
}

function renderKnowledgeResult(el, current, content) {
  const result = current.result || {};
  el.append(node('div', `Lösung: ${result.correctAnswer ?? content.correctAnswer}${content.unit ? ` ${content.unit}` : ''}`, 'notice'));
  const answers = current.answers || {};
  for (const [uid, a] of Object.entries(answers)) el.append(node('div', `${nameOf(uid)}: ${a.value}`, 'box'));
  if (result.winners?.length) el.append(node('div', `Am nächsten / richtig: ${result.winners.map(nameOf).join(', ')}`, 'notice'));
}

function renderDuel(el, current, content) {
  el.append(contentCard(content.title, content.text, `Duell ${content.mode}`));
  if (!current.participantMap) {
    if (!amActive()) { el.append(node('div', `${nameOf(roomState.game.activeUid)} legt die Duellteilnehmer fest.`, 'notice')); return; }
    renderDuelSetup(el, current, content);
    return;
  }
  const participants = Object.keys(current.participantMap).filter(uid => current.participantMap[uid]);
  const info = node('div', '', 'box');
  if (content.mode === '1v1') info.textContent = `${nameOf(current.sideA)} gegen ${nameOf(current.sideB)}`;
  else info.textContent = `Team A: ${(current.teamA || []).map(nameOf).join(' + ')} · Team B: ${(current.teamB || []).map(nameOf).join(' + ')}`;
  el.append(info);

  if (current.status === 'active' && participants.includes(myUid())) {
    const votes = current.duelVotes || {};
    if (!votes[myUid()]) {
      const voteWrap = node('div', '', 'stack');
      voteWrap.append(node('strong', 'Wer hat gewonnen?'));
      const options = content.mode === '1v1'
        ? [[current.sideA, nameOf(current.sideA)], [current.sideB, nameOf(current.sideB)]]
        : [['A', `Team A (${(current.teamA || []).map(nameOf).join(' + ')})`], ['B', `Team B (${(current.teamB || []).map(nameOf).join(' + ')})`]];
      for (const [value, label] of options) {
        const b = node('button', label, 'secondary');
        b.onclick = action(() => set(ref(db, `rooms/${roomCode}/current/duelVotes/${myUid()}`), { choice: value, votedAt: now() }));
        voteWrap.append(b);
      }
      el.append(voteWrap);
    } else el.append(node('p', 'Deine Gewinner-Auswahl wurde gespeichert.', 'muted'));
  }

  const votes = current.duelVotes || {};
  if (Object.keys(votes).length) {
    const voteText = Object.entries(votes).map(([uid, v]) => `${nameOf(uid)} → ${content.mode === '1v1' ? nameOf(v.choice) : `Team ${v.choice}`}`).join(' · ');
    el.append(node('div', `Bestätigungen: ${voteText}`, 'box'));
  }

  if (current.status === 'active' && amActive()) {
    const label = node('label', 'Endgültiges Ergebnis');
    const select = document.createElement('select');
    if (content.mode === '1v1') {
      select.append(new Option(nameOf(current.sideA), current.sideA), new Option(nameOf(current.sideB), current.sideB));
    } else {
      select.append(new Option('Team A', 'A'), new Option('Team B', 'B'));
    }
    label.append(select); el.append(label);
    const done = node('button', 'Duellergebnis übernehmen');
    done.onclick = action(() => resolveCurrent({ duelWinner: select.value }));
    el.append(done);
  }
  if (current.status === 'resolved') {
    const winner = content.mode === '1v1' ? nameOf(current.duelWinner) : `Team ${current.duelWinner}`;
    el.append(node('div', `Gewinner: ${winner}`, 'notice'));
  }
}

function renderDuelSetup(el, current, content) {
  const active = roomState.game.activeUid;
  const others = playersInOrder().filter(uid => uid !== active);
  if (content.mode === '1v1') {
    const label = node('label', 'Gegner auswählen');
    const select = document.createElement('select');
    for (const uid of others) select.append(new Option(nameOf(uid), uid));
    label.append(select); el.append(label);
    const b = node('button', 'Duell festlegen');
    b.onclick = action(async () => {
      const opponent = select.value;
      if (!opponent) throw new Error('Bitte einen Gegner auswählen.');
      await update(ref(db, `rooms/${roomCode}/current`), {
        sideA: active, sideB: opponent, participantMap: { [active]: true, [opponent]: true }
      });
    }); el.append(b);
  } else {
    if (others.length < 3) { el.append(node('div', 'Für ein 2v2 werden vier Spieler benötigt.', 'notice error')); return; }
    const selects = [];
    for (const title of ['Dein Teampartner', 'Gegner 1', 'Gegner 2']) {
      const label = node('label', title); const select = document.createElement('select');
      for (const uid of others) select.append(new Option(nameOf(uid), uid));
      label.append(select); el.append(label); selects.push(select);
    }
    const b = node('button', 'Teams festlegen');
    b.onclick = action(async () => {
      const chosen = selects.map(s => s.value);
      if (new Set(chosen).size !== 3) throw new Error('Bitte drei unterschiedliche Personen auswählen.');
      const [mate, o1, o2] = chosen;
      await update(ref(db, `rooms/${roomCode}/current`), {
        teamA: [active, mate], teamB: [o1, o2],
        participantMap: { [active]: true, [mate]: true, [o1]: true, [o2]: true }
      });
    }); el.append(b);
  }
}

const SELF_EFFECTS = {
  ereignis_002_doppelwurf: ['doppelwurf', 'Doppelwurf'],
  ereignis_003_halber_wurf: ['halberwurf', 'Halber Wurf'],
  ereignis_021_turbo: ['turbo', 'Turbo'],
  ereignis_022_pause: ['pause', 'Pause (nächsten Zug aussetzen)'],
  ereignis_023_neuwurf: ['neuwurf', 'Neuwurf'],
  ereignis_032_duellschutz: ['duellschutz', 'Duellschutz'],
  ereignis_033_revanche: ['revanche', 'Revanche'],
  ereignis_034_wissensbonus: ['wissensbonus', 'Wissensbonus'],
  ereignis_051_richtungswechsel: ['richtungswechsel', 'Richtungswechsel']
};

const TARGET_EFFECTS = {
  ereignis_020_blockade: ['blockade', 'Blockade: nächster Zug höchstens 3 Felder'],
  ereignis_024_wurfelklau: ['wurfelklau', 'Würfelklau beim nächsten Zug']
};

async function addEffect(uid, key, label, sourceId, extra = {}) {
  await set(ref(db, `rooms/${roomCode}/game/effects/${uid}/${key}`), { label, sourceId, createdAt: now(), ...extra });
}

function renderEvent(el, current, content) {
  el.append(contentCard(content.title, content.text, 'Ereignis'));
  if (current.resultText) el.append(node('div', current.resultText, 'notice'));
  if (current.status !== 'active') return;

  if (content.id === 'ereignis_036_gruppenentscheidung') { renderGroupVote(el, current); return; }
  if (!amActive()) { el.append(node('div', `${nameOf(roomState.game.activeUid)} führt das Ereignis aus.`, 'notice')); return; }

  if (SELF_EFFECTS[content.id]) {
    const [key, label] = SELF_EFFECTS[content.id];
    const b = node('button', 'Effekt speichern');
    b.onclick = action(async () => { await addEffect(myUid(), key, label, content.id); await resolveCurrent({ resultText: `${label} wurde gespeichert.` }); });
    el.append(b); return;
  }
  if (TARGET_EFFECTS[content.id]) { renderTargetEffect(el, current, content); return; }
  if (content.id === 'ereignis_025_titel_verlieren') { renderTitleLose(el); return; }
  if (content.id === 'ereignis_026_titel_tauschen') { renderTitleSwap(el); return; }
  if (content.id === 'ereignis_027_titel_klauen') { renderTitleSteal(el); return; }
  if (content.id === 'ereignis_028_titelroulette') { renderTitleRoulette(el); return; }
  if (content.id === 'ereignis_029_regel_loschen') { renderRuleDelete(el); return; }
  if (content.id === 'ereignis_030_regelwechsel') { renderRuleChange(el, current); return; }
  if (content.id === 'ereignis_047_freie_wahl') { renderFreeChoice(el); return; }
  if (content.id === 'ereignis_048_opfer') { renderSacrifice(el); return; }

  const done = node('button', 'Erledigt');
  done.onclick = action(() => resolveCurrent({ resultText: 'Ereignis bestätigt.' }));
  el.append(done);
}

function renderTargetEffect(el, current, content) {
  const [key, labelText] = TARGET_EFFECTS[content.id];
  const label = node('label', 'Person auswählen');
  const select = document.createElement('select');
  for (const uid of playersInOrder().filter(uid => uid !== myUid())) select.append(new Option(nameOf(uid), uid));
  label.append(select); el.append(label);
  const b = node('button', 'Effekt zuweisen');
  b.onclick = action(async () => {
    if (!select.value) throw new Error('Bitte eine Person auswählen.');
    await addEffect(select.value, key, labelText, content.id, { byUid: myUid() });
    await resolveCurrent({ resultText: `${nameOf(select.value)} hat jetzt den Effekt „${labelText}“.` });
  }); el.append(b);
}

function renderTitleLose(el) {
  const b = node('button', 'Titel abgeben');
  b.onclick = action(async () => { await remove(ref(db, `rooms/${roomCode}/game/titles/${myUid()}`)); await resolveCurrent({ resultText: 'Der aktuelle Titel wurde entfernt.' }); });
  el.append(b);
}

function renderTitleSwap(el) {
  const label = node('label', 'Person zum Tauschen'); const select = document.createElement('select');
  for (const uid of playersInOrder().filter(uid => uid !== myUid())) select.append(new Option(nameOf(uid), uid));
  label.append(select); el.append(label);
  const b = node('button', 'Titel tauschen');
  b.onclick = action(async () => {
    const other = select.value; if (!other) throw new Error('Bitte eine Person auswählen.');
    const mine = roomState.game.titles?.[myUid()] || null; const theirs = roomState.game.titles?.[other] || null;
    await set(ref(db, `rooms/${roomCode}/game/titles/${myUid()}`), theirs);
    await set(ref(db, `rooms/${roomCode}/game/titles/${other}`), mine);
    await resolveCurrent({ resultText: `Titel mit ${nameOf(other)} getauscht.` });
  }); el.append(b);
}

function renderTitleSteal(el) {
  const candidates = playersInOrder().filter(uid => uid !== myUid() && roomState.game.titles?.[uid]);
  if (!candidates.length) { el.append(node('div', 'Niemand anderes hat aktuell einen Titel.', 'warn')); const b=node('button','Ohne Effekt abschließen'); b.onclick=action(()=>resolveCurrent()); el.append(b); return; }
  const label = node('label', 'Titel klauen von'); const select = document.createElement('select');
  for (const uid of candidates) select.append(new Option(`${nameOf(uid)} – ${roomState.game.titles[uid].title}`, uid));
  label.append(select); el.append(label);
  const b = node('button', 'Titel klauen'); b.onclick = action(async () => {
    const other = select.value; const title = roomState.game.titles[other];
    await set(ref(db, `rooms/${roomCode}/game/titles/${myUid()}`), title);
    await remove(ref(db, `rooms/${roomCode}/game/titles/${other}`));
    await resolveCurrent({ resultText: `${nameOf(myUid())} hat „${title.title}“ von ${nameOf(other)} übernommen.` });
  }); el.append(b);
}

function renderTitleRoulette(el) {
  const b = node('button', 'Titelroulette ausführen');
  b.onclick = action(async () => {
    const order = playersInOrder(); const oldTitles = clone(roomState.game.titles || {}); const nextTitles = {};
    for (const [uid, title] of Object.entries(oldTitles)) {
      const i = order.indexOf(uid); if (i < 0) continue;
      const leftUid = order[(i + 1) % order.length]; nextTitles[leftUid] = title;
    }
    await set(ref(db, `rooms/${roomCode}/game/titles`), Object.keys(nextTitles).length ? nextTitles : null);
    await resolveCurrent({ resultText: 'Alle vorhandenen Titel wurden in Lobby-Reihenfolge weitergegeben.' });
  }); el.append(b);
}

function renderRuleDelete(el) {
  const entries = Object.entries(roomState.activeRules || {});
  if (!entries.length) { el.append(node('div', 'Es ist aktuell keine Regel aktiv.', 'warn')); const b=node('button','Ohne Effekt abschließen'); b.onclick=action(()=>resolveCurrent()); el.append(b); return; }
  const label = node('label', 'Regel entfernen'); const select = document.createElement('select');
  for (const [key, rule] of entries) select.append(new Option(rule.title, key));
  label.append(select); el.append(label);
  const b = node('button', 'Regel löschen'); b.onclick = action(async () => { const title=roomState.activeRules[select.value].title; await remove(ref(db, `rooms/${roomCode}/activeRules/${select.value}`)); await resolveCurrent({ resultText: `„${title}“ wurde entfernt.` }); }); el.append(b);
}

function renderRuleChange(el, current) {
  const activeEntries = Object.entries(roomState.activeRules || {});
  if (!activeEntries.length) { el.append(node('div', 'Es ist keine aktive Regel vorhanden, die ersetzt werden könnte.', 'warn')); const b=node('button','Ohne Effekt abschließen'); b.onclick=action(()=>resolveCurrent()); el.append(b); return; }
  if (!current.ruleChange) {
    const b = node('button', 'Zufälligen Regelwechsel ziehen');
    b.onclick = action(async () => {
      const [removeKey, removeRule] = randomItem(activeEntries);
      const activeIds = new Set(activeEntries.map(([, r]) => r.contentId));
      const candidates = (DATA.regeln || []).filter(r => !activeIds.has(r.id));
      if (!candidates.length) throw new Error('Es gibt keine weitere Regel zum Ersetzen.');
      const replacement = randomItem(candidates);
      await update(ref(db, `rooms/${roomCode}/current`), { ruleChange: { removeKey, removeTitle: removeRule.title, replacementId: replacement.id } });
    }); el.append(b); return;
  }
  const replacement = contentBy('regel', current.ruleChange.replacementId);
  el.append(node('div', `„${current.ruleChange.removeTitle}“ wird durch „${replacement.title}“ ersetzt.`, 'notice'));
  const form = buildRuleVariableForm(replacement, 'replacement'); el.append(form.element);
  const b = node('button', 'Regelwechsel anwenden'); b.onclick = action(async () => {
    const variables = form.read(); validateRuleVariables(replacement, variables);
    await remove(ref(db, `rooms/${roomCode}/activeRules/${current.ruleChange.removeKey}`));
    await set(ref(db, `rooms/${roomCode}/activeRules/a_${current.id}`), { contentId: replacement.id, title: replacement.title, text: replacement.text, variables, activatedAt: now(), activatedBy: myUid() });
    await resolveCurrent({ resultText: `„${current.ruleChange.removeTitle}“ wurde durch „${replacement.title}“ ersetzt.` });
  }); el.append(b);
}

function renderGroupVote(el, current) {
  const votes = current.eventVotes || {};
  if (!votes[myUid()]) {
    const wrap = node('div', '', 'vote-row');
    const forward = node('button', '3 Felder vor');
    const title = node('button', 'Neuer Titel', 'secondary');
    forward.onclick = action(() => set(ref(db, `rooms/${roomCode}/current/eventVotes/${myUid()}`), { choice: 'forward', votedAt: now() }));
    title.onclick = action(() => set(ref(db, `rooms/${roomCode}/current/eventVotes/${myUid()}`), { choice: 'title', votedAt: now() }));
    wrap.append(forward, title); el.append(wrap);
  } else el.append(node('p', 'Deine Stimme wurde gespeichert.', 'muted'));
  const counts = { forward: 0, title: 0 }; Object.values(votes).forEach(v => { if (counts[v.choice] !== undefined) counts[v.choice]++; });
  el.append(node('div', `Zwischenstand: 3 Felder vor ${counts.forward} · Neuer Titel ${counts.title}`, 'box'));
  if (amActive()) {
    const b = node('button', 'Abstimmung auswerten'); b.onclick = action(async () => {
      if (counts.forward === counts.title) throw new Error('Die Abstimmung ist aktuell unentschieden. Es müssen noch Stimmen abgegeben werden.');
      if (counts.title > counts.forward) {
        const role = randomItem(DATA.rollen || []);
        await set(ref(db, `rooms/${roomCode}/game/titles/${myUid()}`), { id: role.id, title: role.title, text: role.text, assignedAt: now() });
        await resolveCurrent({ resultText: `Die Gruppe hat für einen neuen Titel gestimmt: „${role.title}“.` });
      } else await resolveCurrent({ resultText: 'Die Gruppe hat für 3 Felder vor gestimmt.' });
    }); el.append(b);
  }
}

function renderFreeChoice(el) {
  const wrap = node('div', '', 'vote-row');
  const move = node('button', '2 Felder vor'); const title = node('button', 'Neuen Titel ziehen', 'secondary');
  move.onclick = action(() => resolveCurrent({ resultText: `${nameOf(myUid())} geht 2 Felder vor.` }));
  title.onclick = action(async () => {
    const role = randomItem(DATA.rollen || []);
    await set(ref(db, `rooms/${roomCode}/game/titles/${myUid()}`), { id: role.id, title: role.title, text: role.text, assignedAt: now() });
    await resolveCurrent({ resultText: `Neuer Titel: „${role.title}“.` });
  });
  wrap.append(move, title); el.append(wrap);
}

function renderSacrifice(el) {
  const title = roomState.game.titles?.[myUid()];
  if (!title) { el.append(node('div', 'Du hast aktuell keinen Titel, den du abgeben könntest.', 'warn')); const b=node('button','Ereignis abschließen'); b.onclick=action(()=>resolveCurrent()); el.append(b); return; }
  const b = node('button', `Titel „${title.title}“ abgeben und 2 Felder vor`);
  b.onclick = action(async () => { await remove(ref(db, `rooms/${roomCode}/game/titles/${myUid()}`)); await resolveCurrent({ resultText: `Titel abgegeben. ${nameOf(myUid())} darf 2 Felder vorgehen.` }); }); el.append(b);
}

function renderEndTurn() {
  const el = $('endTurnArea');
  el.replaceChildren();
  const current = roomState.current;
  if (!current || current.status !== 'resolved') return;
  if (!amActive()) { el.append(node('div', `${nameOf(roomState.game.activeUid)} beendet den Zug.`, 'notice')); return; }
  const b = node('button', 'Zug beenden → nächste Person', 'success');
  b.onclick = action(endTurn); el.append(b);
}

async function endTurn() {
  if (!amActive()) throw new Error('Nur die aktive Person kann den Zug beenden.');
  if (roomState.current?.status !== 'resolved') throw new Error('Das Feld muss zuerst abgeschlossen werden.');
  await remove(ref(db, `rooms/${roomCode}/current`));
  const gameRef = ref(db, `rooms/${roomCode}/game`);
  const result = await runTransaction(gameRef, game => {
    if (!game || game.activeUid !== myUid()) return;
    const order = (game.order || []).filter(uid => roomState.players?.[uid]);
    if (!order.length) return game;
    let index = Number(game.activeIndex || 0);
    const effects = game.effects || {};
    const skipped = [];
    let nextUid = null;
    for (let tries = 0; tries <= order.length; tries++) {
      index = (index + 1) % order.length;
      const candidate = order[index];
      if (effects[candidate]?.pause) {
        skipped.push(candidate);
        delete effects[candidate].pause;
        if (!Object.keys(effects[candidate]).length) delete effects[candidate];
        continue;
      }
      nextUid = candidate; break;
    }
    if (!nextUid) { index = (Number(game.activeIndex || 0) + 1) % order.length; nextUid = order[index]; }
    game.activeIndex = index;
    game.activeUid = nextUid;
    game.turnNumber = Number(game.turnNumber || 0) + 1;
    game.effects = effects;
    game.lastNotice = skipped.length
      ? `${skipped.map(nameOf).join(', ')} ${skipped.length === 1 ? 'setzt' : 'setzen'} wegen „Pause“ aus. ${nameOf(nextUid)} ist dran.`
      : `${nameOf(nextUid)} ist dran.`;
    return game;
  });
  if (!result.committed) throw new Error('Der Zug konnte nicht weitergeschaltet werden.');
}

$('createRoomBtn').onclick = action(createRoom);
$('joinBtn').onclick = action(joinRoom);
$('leaveLobbyBtn').onclick = action(leaveLobby);

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
    } else clearSession();
  } else if (session?.name) {
    $('playerName').value = session.name;
  }
} catch (error) {
  console.error(error);
  alertUser(error.message || String(error), true);
}
