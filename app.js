(() => {
  const tg = window.Telegram?.WebApp;
  if (tg) {
    try { tg.ready(); tg.expand(); tg.setHeaderColor('#100b1d'); tg.setBackgroundColor('#100b1d'); } catch (_) {}
  }
  const query = new URLSearchParams(location.search);
  const devId = query.get('dev_id') || sessionStorage.getItem('qa_dev_id') || `guest-${Math.random().toString(36).slice(2, 9)}`;
  sessionStorage.setItem('qa_dev_id', devId);
  const initData = tg?.initData || '';
  const API_BASE = String(window.QUIZARENA_CONFIG?.apiBase || '').replace(/\/+$/, '');
  const IS_GITHUB_PAGES = location.hostname.endsWith('github.io');
  const BACKEND_MISSING = IS_GITHUB_PAGES && !API_BASE;
  let me = null, selectedCategory = 'Игры', currentView = 'home';
  let practice = null, practiceIndex = 0, practiceAnswered = false, practiceStreak = 0, practiceBestStreak = 0;
  let duelSocket = null, duelQuestion = null, duelAnswered = false, duelTimer = null, duelCompleted = false;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const headers = () => ({'Content-Type':'application/json', ...(initData ? {'X-Telegram-Init-Data':initData} : {'X-Dev-User':devId})});
  function backendUrl(path) { return API_BASE ? `${API_BASE}${path.startsWith('/') ? path : `/${path}`}` : path; }
  async function api(url, options={}) {
    if (BACKEND_MISSING) throw new Error('Интерфейс опубликован, но Backend ещё не подключён. Укажи API-адрес в config.js.');
    const response = await fetch(backendUrl(url), {...options, headers:{...headers(), ...(options.headers || {})}});
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(data.detail || `Ошибка сервера (${response.status})`);
    return data;
  }
  function toast(message) {
    const el = $('toast'); el.textContent = message; el.classList.add('show');
    clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
  }
  function haptic(type='light') { try { tg?.HapticFeedback?.impactOccurred(type); } catch (_) {} }
  document.addEventListener('click', event => { if (event.target.closest('button')) playSfx?.('click'); }, true);
  function showView(name) {
    if (name !== 'duel' && duelSocket && duelSocket.readyState <= 1) { duelSocket.close(); duelSocket = null; clearInterval(duelTimer); }
    currentView = name;
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${name}`));
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.nav === name || (name === 'practice' && b.dataset.nav === 'duel')));
    window.scrollTo({top:0,behavior:'smooth'});
    if (name === 'leaderboard') loadLeaderboard();
    if (name === 'profile') loadProfile();
  }
  function renderCategories() {
    const categories = [ ['Кино','🎬'],['Игры','🎮'],['Наука','🧪'],['Спорт','⚽'],['География','🌍'],['Технологии','💻'] ];
    $('categoryGrid').innerHTML = categories.map(([name,emoji]) => `<button class="category-card ${name===selectedCategory?'selected':''}" data-category="${name}"><span>${emoji}</span><span>${name}</span></button>`).join('');
    $('categoryGrid').querySelectorAll('[data-category]').forEach(button => button.addEventListener('click', () => {
      selectedCategory = button.dataset.category; renderCategories(); haptic();
    }));
  }
  function setProfile(profile) {
    me = profile;
    $('headerName').textContent = profile.display_name || 'Игрок';
    $('headerRating').textContent = `${profile.rating} RP`;
    $('avatar').textContent = (profile.display_name || 'Q').trim().charAt(0).toUpperCase();
    $('statWins').textContent = profile.wins;
    $('statXp').textContent = profile.xp;
    $('statRating').textContent = profile.rating;
    $('profileName').textContent = profile.display_name || 'Игрок';
    $('profileAvatar').textContent = (profile.display_name || 'Q').trim().charAt(0).toUpperCase();
    $('profileRating').textContent = profile.rating;
    $('profileWins').textContent = profile.wins;
    $('profileGames').textContent = profile.games;
    $('profileXp').textContent = profile.xp;
    const xp = profile.xp % 500;
    $('levelProgressText').textContent = `${xp} / 500 XP`;
    $('levelProgress').style.width = `${xp/5}%`;
    renderAchievements(profile);
  }
  async function loadProfile() {
    try { const data = await api('/api/me'); setProfile(data.profile); }
    catch (error) { toast(error.message); }
  }
  async function loadLeaderboard() {
    const target = $('leaderboard'); target.innerHTML = '<div class="loading-ring"></div><p class="empty-state">Загружаем рейтинг…</p>';
    try {
      const data = await api('/api/leaderboard');
      if (!data.players.length) { target.innerHTML = '<div class="empty-state">Пока нет игроков. Стань первым в рейтинге!</div>'; return; }
      target.innerHTML = data.players.map((p,i) => `<div class="leader-row"><span class="leader-place">${i<3?['🥇','🥈','🥉'][i]:i+1}</span><span class="leader-name"><b>${esc(p.display_name)}</b><small>${p.wins} побед · ${p.xp} XP</small></span><span class="leader-points">${p.rating} RP</span></div>`).join('');
    } catch (error) { target.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`; }
  }
  async function beginPractice() {
    showView('practice');
    const panel = $('practicePanel'); panel.innerHTML = '<div class="loading-ring"></div><p>Подготавливаем вопросы…</p>';
    try {
      practice = await api('/api/practice/start', {method:'POST', body:JSON.stringify({category:selectedCategory})});
      practiceIndex = 0; practiceAnswered = false; practiceStreak = 0; practiceBestStreak = 0; renderPracticeQuestion();
    } catch (error) { panel.innerHTML = `<p>${esc(error.message)}</p><button class="btn btn-outline full" id="practiceBack">Назад</button>`; $('practiceBack').onclick = () => showView('home'); }
  }
  function renderPracticeQuestion() {
    const q = practice.questions[practiceIndex];
    $('practicePanel').innerHTML = `<div class="question-top"><span>${esc(q.category.toUpperCase())}</span><span>ВОПРОС ${practiceIndex+1} / ${practice.questions.length} · 🔥 СЕРИЯ <b id="practiceStreak">${practiceStreak}</b></span></div><div class="timer-track"><span style="width:100%"></span></div><h3 class="question-title">${esc(q.question)}</h3><div class="answer-list">${q.options.map((option,i)=>`<button class="answer-option" data-answer="${i}"><span class="letter">${'ABCD'[i] || i+1}</span>${esc(option)}</button>`).join('')}</div><div id="practiceFeedback"></div>`;
    $('practicePanel').querySelectorAll('[data-answer]').forEach(button => button.addEventListener('click', () => submitPracticeAnswer(Number(button.dataset.answer))));
  }
  async function submitPracticeAnswer(answerIndex) {
    if (practiceAnswered) return;
    practiceAnswered = true; haptic();
    const q = practice.questions[practiceIndex];
    $('practicePanel').querySelectorAll('[data-answer]').forEach(b => b.disabled = true);
    try {
      const result = await api('/api/practice/answer', {method:'POST', body:JSON.stringify({session_id:practice.session_id, question_id:q.id, answer_index:answerIndex})});
      $('practicePanel').querySelectorAll('[data-answer]').forEach((b,i) => {
        if (i === result.correct_index) b.classList.add('correct');
        else if (i === answerIndex) b.classList.add('wrong');
      });
      if (result.correct) { practiceStreak++; practiceBestStreak = Math.max(practiceBestStreak, practiceStreak); playSfx(practiceStreak >= 3 ? 'combo' : 'correct'); }
      else { practiceStreak = 0; playSfx('wrong'); }
      const comboText = result.correct && practiceStreak >= 2 ? `<span class="combo-pill">🔥 COMBO ×${practiceStreak}</span>` : '';
      $('practiceFeedback').innerHTML = `<div class="explanation"><b style="color:${result.correct?'#79e1bf':'#ff8ba7'}">${result.correct?'Верно! +1':'Неверно'} ${comboText}</b>${esc(result.explanation)}</div><button class="btn btn-primary full" id="practiceNext">${practiceIndex+1===practice.questions.length?'Завершить тренировку':'Следующий вопрос →'}</button>`;
      $('practiceNext').onclick = nextPractice;
    } catch (error) { toast(error.message); practiceAnswered = false; }
  }
  async function nextPractice() {
    if (practiceIndex < practice.questions.length-1) { practiceIndex++; practiceAnswered = false; renderPracticeQuestion(); return; }
    const panel = $('practicePanel'); panel.innerHTML = '<div class="loading-ring"></div><p>Сохраняем результат…</p>';
    try {
      const result = await api('/api/practice/finish', {method:'POST', body:JSON.stringify({session_id:practice.session_id})});
      setProfile(result.profile);
      recordDailyTraining();
      if (practiceBestStreak >= 3) playSfx('victory');
      panel.innerHTML = `<div class="placeholder-icon">🏆</div><span class="eyebrow">ТРЕНИРОВКА ЗАВЕРШЕНА</span><div class="result-score">${result.correct}/${result.total}</div><p>Правильных ответов</p><div class="pill">+${result.xp_gained} XP</div><div class="pill">🔥 Лучшая серия: ${practiceBestStreak}</div><button class="btn btn-primary full" id="practiceAgain">Ещё раз</button><button class="btn btn-outline full" id="practiceHome">На главную</button>`;
      $('practiceAgain').onclick = beginPractice; $('practiceHome').onclick = () => showView('home');
    } catch (error) { panel.innerHTML = `<p>${esc(error.message)}</p><button class="btn btn-outline full" id="practiceHome">На главную</button>`; $('practiceHome').onclick = () => showView('home'); }
  }
  function startDuel() {
    if (duelSocket && duelSocket.readyState <= 1) return;
    showView('duel');
    const panel = $('duelPanel');
    panel.innerHTML = '<div class="loading-ring"></div><h3>Подключаемся к арене…</h3><p>Ищем свободного соперника.</p><button class="btn btn-outline full" id="cancelDuel">Отменить поиск</button>';
    const backendOrigin = API_BASE ? new URL(API_BASE) : new URL(location.origin);
    const scheme = backendOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams();
    if (initData) params.set('init_data', initData); else params.set('dev_id', devId);
    duelCompleted = false;
    const socket = new WebSocket(`${scheme}//${backendOrigin.host}/ws/duel?${params.toString()}`);
    duelSocket = socket;
    $('cancelDuel').onclick = () => { duelSocket?.close(); duelSocket=null; panel.innerHTML = '<div class="duel-vs">⚔️</div><h3>Поиск отменён</h3><button class="btn btn-primary full" id="findOpponent">Найти соперника</button>'; $('findOpponent').onclick=startDuel; };
    socket.onmessage = event => { let data; try { data=JSON.parse(event.data); } catch (_) { return; } handleDuelEvent(data); };
    socket.onerror = () => toast('Не удалось подключиться к арене. Проверь соединение.');
    socket.onclose = () => { clearInterval(duelTimer); if (duelSocket===socket) duelSocket=null; if (!duelCompleted && currentView==='duel' && !panel.querySelector('#findOpponent')) toast('Соединение с ареной закрыто.'); };
  }
  function handleDuelEvent(data) {
    const panel = $('duelPanel');
    if (data.type === 'waiting') {
      panel.innerHTML = `<div class="loading-ring"></div><h3>Ищем соперника…</h3><p>Не закрывай это окно. Как только найдём игрока, начнётся матч.</p><div class="pill">ПОИСК ИГРОКА</div><button class="btn btn-outline full" id="cancelDuel">Отменить поиск</button>`;
      $('cancelDuel').onclick = () => { duelSocket?.close(); duelSocket=null; showView('home'); };
    } else if (data.type === 'matched') {
      panel.innerHTML = `<div class="duel-vs">⚔️</div><span class="eyebrow">СОПЕРНИК НАЙДЕН</span><h3>${esc(data.players?.[0]?.name || 'Игрок')} vs ${esc(data.players?.[1]?.name || 'Игрок')}</h3><p>Матч состоит из 10 вопросов. За правильный и быстрый ответ начисляется больше очков.</p><div class="pill">КОМНАТА ${esc(data.room_id)}</div>`;
    } else if (data.type === 'countdown') {
      panel.innerHTML = `<div class="countdown-num">${data.seconds}</div><h3>Приготовься!</h3><p>Битва начинается</p>`;
    } else if (data.type === 'question') {
      duelQuestion = data; duelAnswered = false;
      panel.innerHTML = `<div class="question-top"><span>ВОПРОС ${data.index} / ${data.total}</span><span id="duelTime">${data.time_limit} сек.</span></div><div class="timer-track"><span id="duelTimerBar"></span></div><h3 class="question-title">${esc(data.question)}</h3><div class="answer-list">${data.options.map((option,i)=>`<button class="answer-option" data-duel-answer="${i}"><span class="letter">${'ABCD'[i] || i+1}</span>${esc(option)}</button>`).join('')}</div><div class="explanation" id="duelFeedback">Выбери ответ. После ответа ждём второго игрока.</div>`;
      panel.querySelectorAll('[data-duel-answer]').forEach(b=>b.addEventListener('click',()=>submitDuelAnswer(Number(b.dataset.duelAnswer))));
      let remaining=data.time_limit; clearInterval(duelTimer); duelTimer=setInterval(()=>{remaining=Math.max(0,remaining-0.1); const t=$('duelTime'),bar=$('duelTimerBar'); if(t)t.textContent=`${Math.ceil(remaining)} сек.`; if(bar)bar.style.width=`${remaining/data.time_limit*100}%`; if(remaining<=0)clearInterval(duelTimer);},100);
    } else if (data.type === 'round_result') {
      clearInterval(duelTimer);
      panel.querySelectorAll('[data-duel-answer]').forEach((b,i)=>{b.disabled=true;if(i===data.correct_index)b.classList.add('correct');});
      const scores=(data.results||[]).map(r=>`${esc(r.name)}: ${r.score} очков`).join(' · ');
      const feedback=$('duelFeedback'); if(feedback) feedback.innerHTML=`<b>Правильный ответ: ${'ABCD'[data.correct_index] || data.correct_index+1}</b><br>${esc(data.explanation)}<br><br>${scores}`;
    } else if (data.type === 'match_end') {
      clearInterval(duelTimer);
      duelCompleted = true;
      const finishedSocket = duelSocket;
      duelSocket = null;
      try { finishedSocket?.close(); } catch (_) {}
      const ownId = me?.user_id || me?.id;
      let headline = data.winner_id === null ? 'Ничья!' : (data.winner_id === ownId ? 'Ты победил! 🏆' : 'Матч завершён');
      panel.innerHTML = `<div class="placeholder-icon">${data.winner_id===ownId?'🏆':'⚔️'}</div><span class="eyebrow">MATCH COMPLETE</span><h3>${headline}</h3><p>${esc(data.reason || '')}</p><div class="result-score">${data.scores?.[ownId] ?? '—'}</div><p>Твои очки</p><button class="btn btn-primary full" id="duelAgain">Найти нового соперника</button><button class="btn btn-outline full" id="duelHome">На главную</button>`;
      $('duelAgain').onclick=startDuel; $('duelHome').onclick=()=>{duelSocket=null;showView('home');};
      loadProfile();
    } else if (data.type === 'error') toast(data.message || 'Ошибка матча');
  }
  function submitDuelAnswer(answerIndex) {
    if (duelAnswered || !duelSocket || duelSocket.readyState !== WebSocket.OPEN || !duelQuestion) return;
    duelAnswered=true; haptic();
    duelSocket.send(JSON.stringify({action:'answer',question_id:duelQuestion.question_id,answer_index:answerIndex}));
    $('duelFeedback').textContent='Ответ принят. Ожидаем соперника…';
    $('duelPanel').querySelectorAll('[data-duel-answer]').forEach(b=>b.disabled=true);
  }
  // Original ambient soundtrack generated locally with Web Audio (no external music files).
  const audioPrefs = { music: localStorage.getItem('qa_music') === '1', sfx: localStorage.getItem('qa_sfx') !== '0', volume: Number(localStorage.getItem('qa_volume') ?? 30) / 100 };
  let audioContext = null;
  const musicAudio = $('backgroundMusic');
  function ensureAudio() { const Ctx=window.AudioContext||window.webkitAudioContext; if(!Ctx)return null; if(!audioContext)audioContext=new Ctx(); if(audioContext.state==='suspended')audioContext.resume(); return audioContext; }
  function stopMusic() { if (musicAudio) { musicAudio.pause(); } }
  function startMusic() { if (!musicAudio || !audioPrefs.music) return; musicAudio.volume = Math.max(0, Math.min(1, audioPrefs.volume)); musicAudio.play().catch(() => toast('Нажми на значок музыки ещё раз, чтобы разрешить воспроизведение.')); }
  function playSfx(kind) { if(!audioPrefs.sfx)return; const ctx=ensureAudio(); if(!ctx)return; const now=ctx.currentTime; const notes={click:[520],correct:[660,880],wrong:[220,196],combo:[523,659,784],victory:[523,659,784,1047]}; (notes[kind]||[440]).forEach((hz,i)=>{const osc=ctx.createOscillator(),gain=ctx.createGain();osc.type='sine';osc.frequency.setValueAtTime(hz,now+i*0.075);gain.gain.setValueAtTime(0.0001,now+i*0.075);gain.gain.linearRampToValueAtTime(0.07,now+i*0.075+0.015);gain.gain.exponentialRampToValueAtTime(0.0001,now+i*0.075+0.22);osc.connect(gain);gain.connect(ctx.destination);osc.start(now+i*0.075);osc.stop(now+i*0.075+0.24);}); }
  function syncSoundControls() { const check=$('musicCheck'),sfx=$('sfxCheck'),btn=$('soundButton'),volume=$('musicVolume'); if(check)check.checked=audioPrefs.music;if(sfx)sfx.checked=audioPrefs.sfx;if(volume)volume.value=Math.round(audioPrefs.volume*100);if($('volumeValue'))$('volumeValue').textContent=`${Math.round(audioPrefs.volume*100)}%`;if(btn){btn.classList.toggle('sound-on',audioPrefs.music);btn.textContent=audioPrefs.music?'♫':'♪';} }
  function setMusic(enabled) { audioPrefs.music=enabled;localStorage.setItem('qa_music',enabled?'1':'0');if(enabled)startMusic();else stopMusic();syncSoundControls(); }
  function updateDailyQuest() { const today=new Date().toLocaleDateString('sv-SE');const done=localStorage.getItem(`qa_daily_${today}`)==='1';const text=$('dailyQuestText'),percent=$('dailyQuestPercent'),bar=$('dailyQuestBar'),status=$('dailyQuestStatus');if(text)text.textContent=done?'1 / 1 тренировка':'0 / 1 тренировка';if(percent)percent.textContent=done?'100%':'0%';if(bar)bar.style.width=done?'100%':'0%';if(status){status.textContent=done?'ВЫПОЛНЕНО':'В ПРОЦЕССЕ';status.classList.toggle('completed',done);} }
  function recordDailyTraining() { const today=new Date().toLocaleDateString('sv-SE');localStorage.setItem(`qa_daily_${today}`,'1');updateDailyQuest(); }
  function renderAchievements(profile) { const items=[['🎯','Первый шаг','Заверши тренировку',profile.games>=1],['🏅','Новичок арены','Сыграй 5 игр',profile.games>=5],['🔥','На серии','Выиграй 3 матча',profile.wins>=3],['👑','Чемпион','Одержи 10 побед',profile.wins>=10],['⚡','Энергия знаний','Набери 1000 XP',profile.xp>=1000]];const target=$('achievementGrid');if(!target)return;const unlocked=items.filter(x=>x[3]).length;$('achievementCount').textContent=`${unlocked} / ${items.length}`;target.innerHTML=items.map(([icon,title,desc,ready])=>`<div class="achievement-card ${ready?'unlocked':'locked'}"><span>${icon}</span><b>${title}</b><small>${desc}</small><em>${ready?'ОТКРЫТО':'ЗАКРЫТО'}</em></div>`).join(''); }
  function initSoundSettings() { syncSoundControls();$('soundButton').addEventListener('click',()=>{setMusic(!audioPrefs.music);playSfx('click');});$('settingsButton').addEventListener('click',()=>{$('soundModal').classList.add('open');$('soundModal').setAttribute('aria-hidden','false');syncSoundControls();});const close=()=>{$('soundModal').classList.remove('open');$('soundModal').setAttribute('aria-hidden','true');};$('closeSoundModal').addEventListener('click',close);$('soundModal').addEventListener('click',e=>{if(e.target===$('soundModal'))close();});$('musicCheck').addEventListener('change',e=>setMusic(e.target.checked));$('sfxCheck').addEventListener('change',e=>{audioPrefs.sfx=e.target.checked;localStorage.setItem('qa_sfx',audioPrefs.sfx?'1':'0');playSfx('click');});$('musicVolume').addEventListener('input',e=>{audioPrefs.volume=Number(e.target.value)/100;localStorage.setItem('qa_volume',e.target.value);if(musicAudio)musicAudio.volume=audioPrefs.volume;syncSoundControls();});$('dailyStart').addEventListener('click',beginPractice);document.addEventListener('visibilitychange',()=>{if(document.hidden){if(audioContext&&audioContext.state==='running')audioContext.suspend();stopMusic();}else if(audioPrefs.music){startMusic();}});if(audioPrefs.music){document.addEventListener('pointerdown',()=>{if(audioPrefs.music)startMusic();},{once:true});} }
  async function init() {
    renderCategories(); initSoundSettings(); updateDailyQuest();
    $('quickPlay').onclick=beginPractice;
    $('categoryPractice').onclick=beginPractice;
    $('brandHome').onclick=()=>showView('home');
    $('profileShortcut').onclick=()=>showView('profile');
    $('findOpponent').onclick=startDuel;
    $('main').querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',()=>{
      const action=b.dataset.action;
      if(action==='duel') startDuel(); else if(action==='practice') beginPractice(); else showView(action);
    }));
    document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.go)));
    document.querySelectorAll('[data-nav]').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.nav)));
    try { const data=await api('/api/me'); setProfile(data.profile); }
    catch(error){ toast(error.message); }
  }
  init();
})();
