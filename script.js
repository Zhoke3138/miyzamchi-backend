// ============================================
// MIYZAMCHI FRONTEND v2.0 — Redesign
// ============================================
// НЕ ТРОНУТО: SSE, fetch, localStorage, toGeminiHistory, markdown, BACKEND_URL

const chatContainer = document.getElementById('chat-container');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const newChatBtn = document.getElementById('new-chat-btn');
const historyList = document.getElementById('history-list');
const inputBox = document.getElementById('input-box');

let conversations = JSON.parse(localStorage.getItem('miyzamchi_chats')) || [];
let currentChatId = null;
let streamStickToBottom = true;
let isStreamingResponse = false;
let currentAbortController = null;
let streamingRequestId = 0;

// ============================================
// ICON RENDER BATCHING (lucide.createIcons coalescing)
// ============================================
// lucide.createIcons() сканирует весь document — дорого. Батчим вызовы
// в один проход за кадр, чтобы стрим и загрузка истории не лагали.
let _pendingIconRender = false;
let _suppressIconRender = false;
function scheduleIconRender() {
    if (_suppressIconRender) return;
    if (_pendingIconRender || !window.lucide) return;
    _pendingIconRender = true;
    requestAnimationFrame(() => {
        _pendingIconRender = false;
        try { lucide.createIcons(); } catch (e) {}
    });
}
function flushIconRender() {
    _pendingIconRender = false;
    if (window.lucide) {
        try { lucide.createIcons(); } catch (e) {}
    }
}

// ============================================
// THEME (Light/Dark)
// ============================================
const themeToggle = document.getElementById('theme-toggle');
const themeIcon = document.getElementById('theme-icon');
const headerStatusDot = document.getElementById('header-status-dot');
const daynightBg = document.getElementById('daynight-bg');
const daynightStars = daynightBg ? daynightBg.querySelector('.layer.stars') : null;
const shootingStarsLayer = document.getElementById('shooting-stars');
const ENABLE_THEME_WAVE = false;
const themeWaveGroups = [
    {
        name: 'header',
        selectors: [
            '.app-header',
            '#menu-btn',
            '#header-mode-icon',
            '.header-logo .logo-text',
            '.header-logo .logo-smile',
            '#theme-toggle'
        ]
    },
    {
        name: 'sidebar',
        selectors: [
            '#sidebar',
            '.sidebar-header',
            '.brand-logo',
            '.brand-name',
            '.chat-history',
            '.history-container',
            '.history-group-label',
            '.history-item',
            '.sidebar-games',
            '.new-chat-btn',
            '.sidebar-games .game-link'
        ]
    },
    {
        name: 'input',
        selectors: [
            '#mode-trigger',
            '#send-btn',
            '.attach-btn'
        ]
    }
];
let themeWaveItems = [];

function initDayNightStars() {
    if (!daynightStars) return;
    const targetStars = 130;
    while (daynightStars.children.length < targetStars) {
        daynightStars.appendChild(document.createElement('div'));
    }
    const stars = daynightStars.children;
    for (let i = 0; i < stars.length; i += 1) {
        const star = stars[i];
        const x = Math.random() * 100;
        const y = Math.random() * 100;
        const scale = 0.25 + Math.random() * 1.6;
        const glow = 0.5 + Math.random() * 4.5;
        const alpha = 0.25 + Math.random() * 0.75;
        star.style.transform = `translate(${x}vw, ${y}vh) scale(${scale.toFixed(2)})`;
        star.style.boxShadow = `0 0 ${glow.toFixed(2)}px #fff`;
        star.style.opacity = alpha.toFixed(2);
    }
}

function initShootingStars() {
    if (!shootingStarsLayer) return;
    shootingStarsLayer.innerHTML = '';
    const count = 10;
    for (let i = 0; i < count; i += 1) {
        const star = document.createElement('div');
        star.className = 'shooting-star';
        const startX = -12 - Math.random() * 20;
        const startY = 4 + Math.random() * 42;
        const dx = 92 + Math.random() * 42;
        const dy = 14 + Math.random() * 34;
        const angle = Math.atan2(dy, dx) * (180 / Math.PI);
        const delay = Math.random() * 7.5;
        const duration = 8.8 + Math.random() * 4.6;
        const trail = 120 + Math.random() * 170;
        star.style.setProperty('--sx', `${startX}vw`);
        star.style.setProperty('--sy', `${startY}vh`);
        star.style.setProperty('--dx', `${dx}vw`);
        star.style.setProperty('--dy', `${dy}vh`);
        star.style.setProperty('--angle', `${angle.toFixed(2)}deg`);
        star.style.setProperty('--d', `${duration.toFixed(2)}s`);
        star.style.setProperty('--delay', `${delay.toFixed(2)}s`);
        star.style.setProperty('--trail', `${trail.toFixed(0)}px`);
        shootingStarsLayer.appendChild(star);
    }
}

function syncDayNightBackground(theme) {
    if (!daynightBg) return;
    daynightBg.classList.toggle('night', theme === 'dark');
}

function initThemeWaveItems() {
    themeWaveItems.forEach((item) => {
        item.el.classList.remove('theme-wave-item');
        item.el.style.removeProperty('--theme-wave-delay');
        item.el.style.removeProperty('--tw-start');
        item.el.style.removeProperty('--tw-span');
    });
    const seen = new Set();
    themeWaveItems = [];
    themeWaveGroups.forEach((group) => {
        group.selectors.forEach((selector) => {
            document.querySelectorAll(selector).forEach((el) => {
                if (!seen.has(el)) {
                    seen.add(el);
                    el.classList.add('theme-wave-item');
                    themeWaveItems.push({ el, group: group.name });
                }
            });
        });
    });
}

function startThemeWave(targetTheme) {
    if (!themeWaveItems.length) initThemeWaveItems();
    document.body.classList.remove('theme-to-dark', 'theme-to-light', 'theme-wave-active');
    document.body.classList.add('theme-switching', targetTheme === 'dark' ? 'theme-to-dark' : 'theme-to-light');
    const stepMs = 100;
    const groupStart = {
        header: 0,
        sidebar: 520,
        input: 1220
    };
    const groupIndex = {
        header: 0,
        sidebar: 0,
        input: 0
    };
    let maxDelay = 0;
    themeWaveItems.forEach((item) => {
        const idx = groupIndex[item.group] || 0;
        const delay = (groupStart[item.group] || 0) + (idx * stepMs);
        if (delay > maxDelay) maxDelay = delay;
        item.el.style.setProperty('--theme-wave-delay', `${delay}ms`);
        groupIndex[item.group] = idx + 1;
    });
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            document.body.classList.add('theme-wave-active');
        });
    });
}

function stopThemeWave() {
    document.body.classList.remove('theme-switching', 'theme-to-dark', 'theme-to-light', 'theme-wave-active');
    themeWaveItems.forEach((item) => {
        item.el.style.removeProperty('--theme-wave-delay');
    });
}

initDayNightStars();
initShootingStars();
if (ENABLE_THEME_WAVE) initThemeWaveItems();

function setTheme(theme, options = {}) {
    const isInitial = !!options.initial;
    const apply = () => {
        if (theme === 'light') {
            document.body.classList.add('light-mode');
            if (themeIcon) { themeIcon.innerHTML = '<i data-lucide="sun" width="18" height="18"></i>'; }
        } else {
            document.body.classList.remove('light-mode');
            if (themeIcon) { themeIcon.innerHTML = '<i data-lucide="moon" width="18" height="18"></i>'; }
        }
        syncDayNightBackground(theme);
        scheduleIconRender();
        try { localStorage.setItem('miyzamchi_theme', theme); } catch(e) {}
    };

    apply();
    if (ENABLE_THEME_WAVE && !isInitial) stopThemeWave();
}

if (themeToggle) {
    themeToggle.onclick = () => {
        const isLight = document.body.classList.contains('light-mode');
        setTheme(isLight ? 'dark' : 'light');
    };
}

(function restoreTheme() {
    const saved = localStorage.getItem('miyzamchi_theme') || 'dark';
    setTheme(saved, { initial: true });
})();

async function updateHeaderStatusDot() {
    if (!headerStatusDot) return;
    headerStatusDot.classList.remove('is-online', 'is-offline', 'is-checking');
    headerStatusDot.classList.add('is-checking');
    try {
        const res = await fetch('https://miyzamchi-backend.onrender.com/ping', { method: 'GET', cache: 'no-store' });
        if (res.ok) {
            headerStatusDot.classList.remove('is-checking');
            headerStatusDot.classList.add('is-online');
            headerStatusDot.title = 'Сервис онлайн';
            return;
        }
        throw new Error('ping failed');
    } catch (e) {
        headerStatusDot.classList.remove('is-checking');
        headerStatusDot.classList.add('is-offline');
        headerStatusDot.title = 'Сервис недоступен';
    }
}

updateHeaderStatusDot();
setInterval(updateHeaderStatusDot, 30000);

// ============================================
// MODE SELECTOR (fast / thinking)
// ============================================
let currentMode = 'fast';

const modeTrigger   = document.getElementById('mode-trigger');
const modeDropdown  = document.getElementById('mode-dropdown');
const modeStatusPill = document.getElementById('mode-status-pill');

function sanitizeHtml(html) {
    // Слой 1: DOMPurify (если загружен) — индустриальный стандарт против XSS.
    if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
        return window.DOMPurify.sanitize(html, {
            ALLOWED_TAGS: ['a','b','blockquote','br','code','div','em','h1','h2','h3','h4','h5','h6',
                           'hr','i','li','mark','ol','p','pre','span','strong','sub','sup','table',
                           'tbody','td','th','thead','tr','u','ul'],
            ALLOWED_ATTR: ['href','title','class','target','rel'],
            FORBID_TAGS: ['style','script','iframe','object','embed','form','input','meta','link'],
            FORBID_ATTR: ['style','onerror','onload','onclick','onmouseover','onfocus','onblur']
        });
    }
    // Слой 2 (fallback): ручная санитизация — если DOMPurify не загрузился.
    const template = document.createElement('template');
    template.innerHTML = html;

    const blockedTags = ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'style'];
    blockedTags.forEach((tag) => {
        template.content.querySelectorAll(tag).forEach((node) => node.remove());
    });

    template.content.querySelectorAll('*').forEach((el) => {
        [...el.attributes].forEach((attr) => {
            const name = attr.name.toLowerCase();
            const value = attr.value.trim().toLowerCase();
            if (name.startsWith('on')) {
                el.removeAttribute(attr.name);
            } else if ((name === 'href' || name === 'src') && value.startsWith('javascript:')) {
                el.removeAttribute(attr.name);
            }
        });
    });

    return template.innerHTML;
}

function safeParseMarkdown(text) {
    const rawHtml = marked.parse(text);
    const safe = sanitizeHtml(rawHtml);
    return highlightLegalCitations(safe);
}

function highlightLegalCitations(html) {
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const walker = document.createTreeWalker(wrap, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);

    const citePattern = /(ст\.?\s*\d+(?:[-–]\d+)?(?:\s*,\s*\d+(?:[-–]\d+)?)*|стат(?:ья|ьи|ье|ью|ьей|ьею|ей|ьям|ьях|ьями)\s+\d+(?:[-–]\d+)?(?:\s*,\s*\d+(?:[-–]\d+)?)*|закон(?:а|ом|е)?\s+кыргызской\s+республики)/gi;
    nodes.forEach((node) => {
        const parentTag = node.parentElement ? node.parentElement.tagName.toLowerCase() : '';
        if (!node.nodeValue || !node.nodeValue.trim()) return;
        if (['code', 'pre', 'a'].includes(parentTag)) return;
        const text = node.nodeValue;
        if (!citePattern.test(text)) return;
        citePattern.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let last = 0;
        text.replace(citePattern, (m, _g, idx) => {
            if (idx > last) frag.appendChild(document.createTextNode(text.slice(last, idx)));
            const mark = document.createElement('mark');
            mark.className = 'legal-cite';
            mark.textContent = m;
            frag.appendChild(mark);
            last = idx + m.length;
            return m;
        });
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
    });
    return wrap.innerHTML;
}

function isNearBottom(threshold = 120) {
    const distance = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight;
    return distance <= threshold;
}

function ensureJumpToBottomButton() {
    let btn = document.getElementById('jump-to-bottom-btn');
    if (btn) return btn;

    btn = document.createElement('button');
    btn.id = 'jump-to-bottom-btn';
    btn.className = 'jump-to-bottom-btn';
    btn.type = 'button';
    btn.innerHTML = '<i data-lucide="arrow-down" width="14" height="14"></i><span>В конец</span>';
    btn.addEventListener('click', () => {
        streamStickToBottom = true;
        scrollToBottom(true);
        updateJumpToBottomVisibility();
    });
    document.body.appendChild(btn);
    scheduleIconRender();
    return btn;
}

function updateJumpToBottomVisibility() {
    const btn = ensureJumpToBottomButton();
    btn.classList.toggle('visible', isStreamingResponse && !isNearBottom(140));
}

const MODE_CONFIG = {
  fast: {
    icon: 'zap', label: 'Быстрый',
    statusLabel: 'Быстрый режим',
    triggerClass: 'fast', pillClass: 'fast'
  },
  thinking: {
    icon: 'brain-circuit', label: 'Думающий',
    statusLabel: 'Думающий режим',
    triggerClass: 'thinking', pillClass: 'thinking'
  }
};

const THINKING_STEPS = [
    { key: 'systematize', label: 'Систематизация базы' },
    { key: 'analyze', label: 'Юридический анализ' },
    { key: 'compose', label: 'Формирование' }
];

function detectThinkingStep(statusText = '') {
    const text = statusText.toLowerCase();
    if (/систематизац|баз/.test(text)) return 1;
    if (/анализ|разбор|интерпр|logic|reason|коллиз/.test(text)) return 2;
    if (/вердикт|ответ|формир|готов|compose|draft/.test(text)) return 3;
    return 2;
}

function renderThinkingTimeline(statusDiv, statusText, forcedStep = null) {
    const activeStep = forcedStep || detectThinkingStep(statusText);
    const iconByStep = {
        systematize: 'book-open',
        analyze: 'brain-circuit',
        compose: 'pen-line'
    };

    const stepsHtml = THINKING_STEPS.map((step, idx) => {
        const stepNum = idx + 1;
        let stateClass = 'step-idle';
        let icon = iconByStep[step.key] || 'circle';
        if (stepNum === activeStep) {
            stateClass = 'step-active';
        }
        return `<span class="timeline-step ${stateClass}" data-step="${stepNum}" aria-label="${step.label}"><i data-lucide="${icon}" width="14" height="14"></i></span>`;
    }).join('<span class="timeline-divider" aria-hidden="true"></span>');

    statusDiv.innerHTML = `<div class="thinking-timeline">${stepsHtml}</div><span class="status-text">${statusText}</span>`;
}

function getThinkingStatusView(rawStatus, fallbackStep) {
    const text = String(rawStatus || '').toLowerCase();

    if (/систематизац|баз/.test(text)) {
        return { displayText: 'Систематизация базы', forcedStep: 1 };
    }

    if (/проверка коллизий|коллиз|анализ|разбор|интерпр/.test(text)) {
        return { displayText: 'Юридический анализ', forcedStep: 2 };
    }

    if (/написание вердикта|вердикт|формир.*ответ|подготовка ответа/.test(text)) {
        return { displayText: 'Написание вердикта', forcedStep: 3, verdictPhase: true };
    }

    const normalized = Math.max(1, Math.min(fallbackStep, THINKING_STEPS.length));
    if (normalized === 1) return { displayText: 'Систематизация базы', forcedStep: 1 };
    if (normalized === 2) return { displayText: 'Юридический анализ', forcedStep: 2 };
    return { displayText: 'Написание вердикта', forcedStep: 3 };
}

function applyMode(mode) {
  mode = 'fast';
  currentMode = mode;
  const cfg = MODE_CONFIG[mode];

  if(document.getElementById('mode-trigger-icon')) document.getElementById('mode-trigger-icon').innerHTML  = `<i data-lucide="${cfg.icon}" width="16" height="16"></i>`;
  if(document.getElementById('mode-trigger-label')) document.getElementById('mode-trigger-label').textContent = cfg.label;
  if(modeTrigger) modeTrigger.className = `mode-trigger ${cfg.triggerClass}`;

  if(document.getElementById('mode-status-icon')) document.getElementById('mode-status-icon').innerHTML  = `<i data-lucide="${cfg.icon}" width="16" height="16"></i>`;
  if(document.getElementById('mode-status-label')) document.getElementById('mode-status-label').textContent = cfg.statusLabel;
  if(modeStatusPill) modeStatusPill.className = `mode-status-pill ${cfg.pillClass}`;

  const headerModeIcon = document.getElementById('header-mode-icon');
  if (headerModeIcon) {
    headerModeIcon.classList.remove('header-mode-fast', 'header-mode-thinking');
    if (mode === 'fast') {
      headerModeIcon.classList.add('header-mode-fast');
      headerModeIcon.innerHTML = `<i data-lucide="zap" width="18" height="18"></i>`;
      headerModeIcon.title = 'Быстрый режим';
    } else {
      headerModeIcon.classList.add('header-mode-thinking');
      headerModeIcon.innerHTML = `<i data-lucide="brain-circuit" width="18" height="18"></i>`;
      headerModeIcon.title = 'Думающий режим';
    }
  }

  if(document.getElementById('check-fast')) document.getElementById('check-fast').style.display     = mode === 'fast'     ? '' : 'none';
  if(document.getElementById('check-thinking')) document.getElementById('check-thinking').style.display = mode === 'thinking' ? '' : 'none';
  document.querySelectorAll('.mode-option[data-mode]').forEach((opt) => {
    opt.setAttribute('aria-selected', String(opt.dataset.mode === mode));
  });

  document.body.classList.remove('mode-fast', 'mode-thinking');
  document.body.classList.add(`mode-${mode}`);

  try { localStorage.setItem('miyzamchi_mode', mode); } catch(e) {}
  scheduleIconRender();
}

if(modeTrigger) {
  modeTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !modeDropdown.hidden;
    modeDropdown.hidden = isOpen;
    modeTrigger.classList.toggle('open', !isOpen);
    modeTrigger.setAttribute('aria-expanded', String(!isOpen));
  });
}

document.querySelectorAll('.mode-option[data-mode]').forEach(btn => {
  btn.addEventListener('click', () => {
    applyMode(btn.dataset.mode);
    if(modeDropdown) modeDropdown.hidden = true;
    if(modeTrigger) modeTrigger.classList.remove('open');
    if(modeTrigger) modeTrigger.setAttribute('aria-expanded', 'false');
  });
});

document.addEventListener('click', () => {
  if(modeDropdown && !modeDropdown.hidden) {
    modeDropdown.hidden = true;
    if(modeTrigger) modeTrigger.classList.remove('open');
    if(modeTrigger) modeTrigger.setAttribute('aria-expanded', 'false');
  }
});

(function restoreMode() {
  const saved = localStorage.getItem('miyzamchi_mode') || 'fast';
  applyMode(saved);
})();

// ============================================
// SEND BUTTON — disabled when empty
// ============================================
function updateSendBtn() {
    if (userInput.value.trim()) {
        sendBtn.classList.remove('disabled');
        sendBtn.disabled = false;
    } else {
        sendBtn.classList.add('disabled');
        sendBtn.disabled = true;
    }
}

function updateInputBoxLayout() {
    if (!inputBox || !userInput) return;
    const isExpanded = userInput.scrollHeight > 54;
    inputBox.classList.toggle('input-box--expanded', isExpanded);
}

userInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 200) + 'px';
    updateInputBoxLayout();
    updateSendBtn();
});

updateSendBtn();
updateInputBoxLayout();

// ============================================
// WELCOME SCREEN
// ============================================
function showWelcomeScreen() {
    chatContainer.innerHTML = '';
    const ws = document.createElement('div');
    ws.id = 'welcome-screen';
    ws.className = 'welcome-screen';
    ws.innerHTML = `
        <div class="welcome-logo">
            <span class="welcome-tunduk"><i data-lucide="scale" width="40" height="40"></i></span>
            <h1 class="welcome-title">Мыйзамчы</h1>
            <p class="welcome-subtitle">Юридический помощник по законодательству Кыргызстана</p>
            <div class="welcome-hints" aria-label="Как формулировать запрос">
                <span class="welcome-hint">Укажите город и ведомство</span>
                <span class="welcome-hint">Добавьте дату и сроки</span>
                <span class="welcome-hint">Опишите сторону спора</span>
            </div>
        </div>
        <div class="welcome-cards">
            <button class="welcome-card" data-prompt="Как подать исковое заявление в суд?">
                <span class="welcome-card-icon"><i data-lucide="scale" width="24" height="24"></i></span>
                <span class="welcome-card-text">Как подать иск в суд?</span>
            </button>
            <button class="welcome-card" data-prompt="Какие у меня трудовые права при увольнении?">
                <span class="welcome-card-icon"><i data-lucide="briefcase" width="24" height="24"></i></span>
                <span class="welcome-card-text">Мои права при увольнении</span>
            </button>
            <button class="welcome-card" data-prompt="Составь жалобу на действия работодателя">
                <span class="welcome-card-icon"><i data-lucide="file-text" width="24" height="24"></i></span>
                <span class="welcome-card-text">Составить жалобу</span>
            </button>
            <button class="welcome-card" data-prompt="Объясни что такое исковая давность простыми словами">
                <span class="welcome-card-icon"><i data-lucide="search" width="24" height="24"></i></span>
                <span class="welcome-card-text">Что такое исковая давность?</span>
            </button>
        </div>`;
    chatContainer.appendChild(ws);
    scheduleIconRender();
    bindWelcomeCards();
}

function hideWelcomeScreen() {
    const ws = document.getElementById('welcome-screen');
    if (ws) ws.classList.add('hidden');
}

function bindWelcomeCards() {
    document.querySelectorAll('.welcome-card').forEach(card => {
        card.onclick = () => {
            const prompt = card.dataset.prompt;
            if (prompt) {
                userInput.value = prompt;
                updateSendBtn();
                hideWelcomeScreen();
                sendMessage();
            }
        };
    });
}

// ============================================
// SKELETON LOADER
// ============================================
function createSkeleton() {
    const div = document.createElement('div');
    div.className = 'skeleton-loader';
    div.innerHTML = '<div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div>';
    return div;
}

// ============================================
// CHAT MANAGEMENT
// ============================================
function init() {
    renderHistory();
    if (conversations.length > 0) loadChat(conversations[0].id);
    else {
        currentChatId = Date.now();
        showWelcomeScreen();
    }
}

function startNewChat() {
    currentChatId = Date.now();
    showWelcomeScreen();
    userInput.value = '';
    userInput.style.height = '26px';
    updateInputBoxLayout();
    updateSendBtn();
    renderHistory();
}

newChatBtn.onclick = startNewChat;

// --- toGeminiHistory: НЕ ТРОНУТО ---
function toGeminiHistory(messages) {
    return messages
        .filter(m => m.text && m.text.trim())
        .map(m => ({
            role: m.role === 'bot' ? 'model' : 'user',
            parts: [{ text: m.text }]
        }));
}

// ============================================
// SEND MESSAGE — SSE STREAMING (НЕ ТРОНУТО)
// ============================================
function setInputStreamingUI(active) {
    if (!inputBox) return;
    inputBox.classList.toggle('input-box--streaming', !!active);
}

function setSendBtnToSend() {
    if (!sendBtn) return;
    sendBtn.setAttribute('aria-label', 'Отправить запрос');
    sendBtn.classList.remove('send-active');
    sendBtn.innerHTML = '<i data-lucide="arrow-up" width="19" height="19" stroke-width="2.5"></i>';
    scheduleIconRender();
}

function setSendBtnToStop() {
    if (!sendBtn) return;
    sendBtn.setAttribute('aria-label', 'Остановить ответ');
    sendBtn.disabled = false; // пока стримим, кнопка должна стопать
    sendBtn.classList.remove('disabled');
    sendBtn.classList.add('send-active');
    sendBtn.innerHTML = '<i data-lucide="stop-circle" width="19" height="19" stroke-width="2.5"></i>';
    scheduleIconRender();
}

function stopResponse() {
    if (!isStreamingResponse) return;
    try {
        currentAbortController?.abort();
    } catch (e) {}
    // Мгновенно возвращаем UI (чтобы можно было сразу продолжать, как в Gemini)
    isStreamingResponse = false;
    setInputStreamingUI(false);
    setSendBtnToSend();
    document.body.classList.remove('asking');
    updateJumpToBottomVisibility();
    updateSendBtn();
}

async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;

    hideWelcomeScreen();
    document.body.classList.add('asking');
    isStreamingResponse = true;
    currentAbortController = new AbortController();
    const myRequestId = ++streamingRequestId;
    setInputStreamingUI(true);
    setSendBtnToStop();
    streamStickToBottom = isNearBottom(140);
    updateJumpToBottomVisibility();

    appendMessage('user', text);
    userInput.value = '';
    userInput.style.height = '26px';
    updateInputBoxLayout();
    updateSendBtn();
    setSendBtnToStop(); // updateSendBtn() может отключить кнопку — во время стрима она должна быть стопом
    scrollToBottom(streamStickToBottom);

    let chat = conversations.find(c => c.id === currentChatId);
    if (!chat) {
        chat = { id: currentChatId, title: text.substring(0, 30) + '...', messages: [] };
        conversations.unshift(chat);
    }

    const ts = Date.now();
    chat.messages.push(
        { role: 'user', text: text, ts, mode: currentMode },
        { role: 'bot', text: '', ts, mode: currentMode }
    );
    const botMessage = chat.messages[chat.messages.length - 1];
    localStorage.setItem('miyzamchi_chats', JSON.stringify(conversations));

    // === ПОДГОТОВКА BUBBLE ОТВЕТА ===
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('message', 'bot-message');
    msgDiv.classList.add(currentMode === 'fast' ? 'bot-message--fast' : 'bot-message--thinking');
    msgDiv.classList.add('bot-message--streaming');

    // Skeleton loader вместо текста статуса
    const skeletonDiv = createSkeleton();

    // Контейнер статуса/мыслей
    const statusDiv = document.createElement('div');
    statusDiv.classList.add('protocol-status-container');
    statusDiv.style.display = 'none';

    // Контейнер текста
    const contentDiv = document.createElement('div');
    contentDiv.classList.add('message-content');
    contentDiv.style.display = 'none';

    const metaDiv = document.createElement('div');
    metaDiv.className = 'message-meta';
    metaDiv.textContent = formatMessageMeta({ ts, mode: currentMode }) || '';

    msgDiv.appendChild(skeletonDiv);
    msgDiv.appendChild(statusDiv);
    msgDiv.appendChild(contentDiv);
    msgDiv.appendChild(metaDiv);

    chatContainer.appendChild(msgDiv);
    scrollToBottom(streamStickToBottom);

    try {
        const BACKEND_URL = 'https://miyzamchi-backend.onrender.com/api/chat';

        const _chatHeaders = { 'Content-Type': 'application/json' };
        if (window.__CLIENT_TOKEN) _chatHeaders['X-Client-Token'] = window.__CLIENT_TOKEN;
        const response = await fetch(BACKEND_URL, {
            method: 'POST',
            headers: _chatHeaders,
            signal: currentAbortController?.signal,
            body: JSON.stringify({
                message: text,
                history: toGeminiHistory(chat.messages),
                mode: currentMode
            })
        });

        if (!response.ok) {
            let errorText = "Произошла ошибка связи с сервером.";
            try {
                const data = await response.json();
                errorText = data.reply || data.answer || data.error || JSON.stringify(data);
            } catch (e) {
                errorText = await response.text();
            }
            skeletonDiv.remove();
            statusDiv.style.display = 'none';
            contentDiv.style.display = 'block';
            contentDiv.innerHTML = "Ошибка: " + errorText;
            botMessage.text = "Ошибка: " + errorText;
            localStorage.setItem('miyzamchi_chats', JSON.stringify(conversations));
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let botResponseText = "";
        let buffer = "";
        let accumulatedSources = null;
        let accumulatedMetadata = null;
        let textHasStarted = false;
        let timelineStep = 0;
        let lastProtocolStatus = '';
        let statusPhaseTimer = null;
        let statusPhaseTimer2 = null;
        let statusVersion = 0;

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            let lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine === '') continue;

                if (trimmedLine.startsWith('data: ')) {
                    const raw = trimmedLine.slice(6).trim();

                    if (raw === '[DONE]') {
                        skeletonDiv.remove();
                        statusDiv.style.display = 'none';
                        msgDiv.classList.remove('bot-message--streaming');
                        break;
                    }

                    let parsed;
                    try {
                        parsed = JSON.parse(raw);
                    } catch(e) {
                        continue; // Игнорируем только битый JSON сети
                    }

                    try {
                        if (parsed.protocolStatus) {
                            skeletonDiv.remove();
                            // Показываем статусы, только если текст еще не начал печататься
                            if (!textHasStarted) {
                                statusDiv.style.display = 'inline-flex';
                            }
                            const currentStatus = String(parsed.protocolStatus).trim();
                            statusVersion += 1;
                            if (statusPhaseTimer) {
                                clearTimeout(statusPhaseTimer);
                                statusPhaseTimer = null;
                            }
                            if (statusPhaseTimer2) {
                                clearTimeout(statusPhaseTimer2);
                                statusPhaseTimer2 = null;
                            }
                            if (currentStatus && currentStatus !== lastProtocolStatus) {
                                timelineStep = Math.min(timelineStep + 1, THINKING_STEPS.length);
                                lastProtocolStatus = currentStatus;
                            } else if (timelineStep === 0) {
                                timelineStep = 1;
                            }
                            const statusView = getThinkingStatusView(parsed.protocolStatus, timelineStep);
                            if (statusView.verdictPhase) {
                                const localVersion = statusVersion;
                                // Этап вердикта: последовательный показ 3 фаз
                                renderThinkingTimeline(statusDiv, 'Систематизация базы', 1);
                                statusPhaseTimer = setTimeout(() => {
                                    if (localVersion !== statusVersion) return;
                                    renderThinkingTimeline(statusDiv, 'Юридический анализ', 2);
                                    scheduleIconRender();
                                }, 700);
                                statusPhaseTimer2 = setTimeout(() => {
                                    if (localVersion !== statusVersion) return;
                                    renderThinkingTimeline(statusDiv, 'Написание вердикта', 3);
                                    scheduleIconRender();
                                }, 1000);
                            } else {
                                renderThinkingTimeline(statusDiv, statusView.displayText, statusView.forcedStep);
                            }
                            statusDiv.classList.remove('status-update-anim');
                            void statusDiv.offsetWidth;
                            statusDiv.classList.add('status-update-anim');
                            scheduleIconRender();
                            if (streamStickToBottom && !isNearBottom(220)) streamStickToBottom = false;
                            scrollToBottom(streamStickToBottom);
                            updateJumpToBottomVisibility();
                        }

                        if (parsed.text) {
                            if (!textHasStarted) {
                                textHasStarted = true;
                                skeletonDiv.remove();
                                statusDiv.style.display = 'none'; // Явно скрываем статусы (timeline)
                                contentDiv.style.display = 'block';
                            }
                            botResponseText += parsed.text;
                            let cleanText = botResponseText.replace(/\s*\[\d+\]/g, '');
                        
                        let htmlContent = safeParseMarkdown(cleanText);
                        // Вставляем каретку внутрь последнего блока (абзаца, пункта списка), чтобы избежать переноса на новую строку
                        if (htmlContent.match(/<\/(p|li|h[1-6]|td)>\s*$/)) {
                            htmlContent = htmlContent.replace(/(<\/(?:p|li|h[1-6]|td)>)\s*$/, '<span class="streaming-cursor"></span>$1');
                        } else {
                            htmlContent += '<span class="streaming-cursor"></span>';
                        }
                        contentDiv.innerHTML = htmlContent;
                        
                            if (streamStickToBottom && !isNearBottom(220)) streamStickToBottom = false;
                            scrollToBottom(streamStickToBottom);
                            updateJumpToBottomVisibility();
                        }

                        if (parsed.sources && parsed.sources.length) {
                             accumulatedSources = parsed.sources;
                        }
                        if (parsed.metadata && Array.isArray(parsed.metadata) && parsed.metadata.length) {
                             accumulatedMetadata = parsed.metadata;
                             msgDiv.dataset.lastMetadata = JSON.stringify(parsed.metadata);
                        }

                    } catch(renderError) {
                        console.error('Ошибка рендеринга Markdown:', renderError);
                        // Бронежилет: если парсер сломался на незаконченном теге, 
                        // все равно показываем сырой текст, чтобы он не пропадал
                        if (parsed.text) {
                            contentDiv.style.display = 'block';
                            contentDiv.innerText = botResponseText;
                        }
                    }
                }
            }
        }

        skeletonDiv.remove();
        statusDiv.style.display = 'none';
        msgDiv.classList.remove('bot-message--streaming');

        let finalSources = [];
        let finalMetadata = [];
        if (accumulatedSources && accumulatedSources.length) {
            finalSources = accumulatedSources;
            finalMetadata = accumulatedMetadata || [];
        }

        if (finalSources.length > 0) {
            renderSources(msgDiv, finalSources, finalMetadata);
            botMessage.sources = finalSources;
            botMessage.metadata = finalMetadata;
        } else {
            const existingContainer = msgDiv.querySelector('.sources-container');
            if (existingContainer) {
                existingContainer.remove();
            }
        }
        if (statusPhaseTimer) {
            clearTimeout(statusPhaseTimer);
            statusPhaseTimer = null;
        }
        if (statusPhaseTimer2) {
            clearTimeout(statusPhaseTimer2);
            statusPhaseTimer2 = null;
        }

        let cleanText = botResponseText.replace(/\s*\[\d+\]/g, '');
        contentDiv.style.display = 'block'; // Железобетонно показываем блок в финале
        contentDiv.innerHTML = safeParseMarkdown(cleanText);
        scrollToBottom(streamStickToBottom);
        addQuickActions(msgDiv, cleanText);
        addCopyButton(msgDiv, cleanText);
        if (currentMode === 'thinking') addDocBuildButton(msgDiv, cleanText);

        if (currentMode === 'fast') {
            const retryBtn = document.createElement('button');
            retryBtn.className = 'retry-thinking-btn';
            retryBtn.innerHTML = '<i data-lucide="brain-circuit" width="14" height="14"></i><span>Переспросить в Думающем режиме</span>';
            retryBtn.onclick = () => {
                const triggerThinking = document.querySelector('.mode-option[data-mode="thinking"]');
                if (triggerThinking) {
                   triggerThinking.click();
                   userInput.value = text;
                   updateSendBtn();
                   sendMessage();
                }
            };
            msgDiv.appendChild(retryBtn);
            scheduleIconRender();
        }

        botMessage.text = botResponseText;
        localStorage.setItem('miyzamchi_chats', JSON.stringify(conversations));
        renderHistory();

    } catch (e) {
        const aborted = currentAbortController?.signal?.aborted || e?.name === 'AbortError';
        if (aborted) {
            if (myRequestId !== streamingRequestId) return;
            skeletonDiv.remove();
            statusDiv.style.display = 'none';
            contentDiv.style.display = 'block';
            msgDiv.classList.remove('bot-message--streaming');

            // Сохраняем частичный ответ в историю (если он успел отрисоваться)
            const partialText = (contentDiv.innerText || contentDiv.textContent || '').trim();
            if (chat && chat.messages.length > 0 && partialText) {
                botMessage.text = partialText;
                localStorage.setItem('miyzamchi_chats', JSON.stringify(conversations));
                renderHistory();
            }
            return;
        }

        console.error("Fetch Error:", e);
        skeletonDiv.remove();
        statusDiv.style.display = 'none';
        contentDiv.style.display = 'block';
        contentDiv.innerHTML = "Нет связи с сервером. Пожалуйста, попробуйте позже.";
        if (chat && chat.messages.length > 0) {
            botMessage.text = "Нет связи с сервером. Пожалуйста, попробуйте позже.";
            localStorage.setItem('miyzamchi_chats', JSON.stringify(conversations));
        }
    } finally {
        if (myRequestId !== streamingRequestId) return;
        isStreamingResponse = false;
        updateJumpToBottomVisibility();
        setInputStreamingUI(false);
        setSendBtnToSend();
        document.body.classList.remove('asking');
        currentAbortController = null;
        updateSendBtn();
    }
}

function isSourceUsed(responseText, srcText, meta) {
    const textLower = String(responseText || '').toLowerCase();
    
    const npaTitle = String(meta?.npa_title || '').trim();
    if (npaTitle) {
        const cleanNpa = npaTitle.replace(/Закон КР «|»|КОДЕКС КЫРГЫЗСКОЙ РЕСПУБЛИКИ|КЫРГЫЗСКОЙ РЕСПУБЛИКИ/gi, '').trim().toLowerCase();
        if (cleanNpa.length > 3 && textLower.includes(cleanNpa)) {
            return true;
        }
        
        const words = cleanNpa.split(/\s+/).filter(w => w.length > 4);
        for (const word of words) {
            if (word !== 'закон' && word !== 'кодекс' && textLower.includes(word)) {
                return true;
            }
        }
    }
    
    const articleTitle = String(meta?.article_title || '').trim();
    if (articleTitle) {
        const artNumMatch = articleTitle.match(/статья\s+(\d+)/i) || articleTitle.match(/ст\.\s+(\d+)/i);
        if (artNumMatch) {
            const num = artNumMatch[1];
            const artRegex = new RegExp('(стать|ст\\.|ст\\s+)' + num + '\\b', 'i');
            if (artRegex.test(textLower)) {
                return true;
            }
        }
    }
    
    const fullText = String(meta?.full_text || '').trim();
    if (fullText && fullText.length > 30) {
        const cleanText = fullText.toLowerCase().replace(/[^а-яёa-z0-9\s]/gi, '');
        const cleanResp = textLower.replace(/[^а-яёa-z0-9\s]/gi, '');
        
        const words = cleanText.split(/\s+/).filter(w => w.length > 2);
        const chunkSize = 4;
        for (let i = 0; i <= words.length - chunkSize; i += 2) {
            const chunk = words.slice(i, i + chunkSize).join(' ');
            if (chunk.length > 15 && cleanResp.includes(chunk)) {
                return true;
            }
        }
    }
    
    return false;
}

// ============================================
// SOURCES (expandable)
// ============================================
function renderSources(msgDiv, sources, metadata) {
    let container = msgDiv.querySelector('.sources-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'sources-container';
        const title = document.createElement('button');
        title.type = 'button';
        title.className = 'sources-title';
        title.setAttribute('aria-expanded', 'false');
        title.innerHTML = `
            <span class="sources-title-left">
                <span class="sources-title-icon"><i data-lucide="book-open" width="14" height="14"></i></span>
                <span class="sources-title-text">Источники</span>
            </span>
            <span class="sources-title-right">
                <span class="sources-count">${sources.length}</span>
                <i data-lucide="chevron-down" class="sources-chevron" width="16" height="16"></i>
            </span>
        `;
        title.onclick = () => {
            const isExpanded = container.classList.toggle('expanded');
            title.setAttribute('aria-expanded', String(isExpanded));
            scheduleIconRender();
        };
        container.appendChild(title);

        const list = document.createElement('div');
        list.className = 'sources-list';
        container.appendChild(list);

        msgDiv.appendChild(container);
        scheduleIconRender();
    }

    const list = container.querySelector('.sources-list');
    if (!list) return;
    list.innerHTML = '';

    // Подхватываем metadata из аргумента или из dataset (если пришла раньше отдельным event)
    let md = Array.isArray(metadata) ? metadata : null;
    if (!md && msgDiv.dataset.lastMetadata) {
        try { md = JSON.parse(msgDiv.dataset.lastMetadata); } catch (_) { md = null; }
    }
    md = Array.isArray(md) ? md : [];

    sources.forEach((src, i) => {
        const raw = String(src || '').trim();
        if (!raw) return;

        const meta = md[i] || {};
        const npaTitle = String(meta.npa_title || '').trim();
        const articleTitle = String(meta.article_title || '').trim();
        const fullText = String(meta.full_text || '').trim();
        const hasMetaText = fullText.length > 0;
        const preview = hasMetaText
            ? (fullText.length > 240 ? fullText.slice(0, 240).trim() + '…' : fullText)
            : '';

        const item = document.createElement('div');
        item.className = 'source-item';

        // ── URL — простая ссылка (без metadata-расширения) ──
        if (/^https?:\/\/\S+$/i.test(raw)) {
            const a = document.createElement('a');
            a.className = 'source-link';
            a.href = raw;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = raw;
            item.appendChild(a);
            list.appendChild(item);
            return;
        }

        // ── Есть metadata — расширенная карточка ──
        if (hasMetaText) {
            item.classList.add('source-item-rich');

            const header = document.createElement('button');
            header.type = 'button';
            header.className = 'source-item-header';
            header.setAttribute('aria-expanded', 'false');
            // Заголовок: НПА + (опционально) название статьи
            const titleHtml = npaTitle
                ? `<strong>${escapeHTML(npaTitle)}</strong>` +
                  (articleTitle ? `<span class="source-item-art"> · ${escapeHTML(articleTitle)}</span>` : '')
                : `<strong>${escapeHTML(raw)}</strong>`;
            header.innerHTML = `
                <span class="source-item-icon"><i data-lucide="book" width="12" height="12"></i></span>
                <span class="source-item-title">${titleHtml}</span>
                <span class="source-item-chev"><i data-lucide="chevron-down" width="12" height="12"></i></span>
            `;
            item.appendChild(header);

            // Превью (видно когда свёрнут)
            if (preview) {
                const previewDiv = document.createElement('div');
                previewDiv.className = 'source-item-preview';
                previewDiv.textContent = preview;
                item.appendChild(previewDiv);
            }

            // Полный текст (видно когда раскрыт)
            const body = document.createElement('div');
            body.className = 'source-item-body';
            const textDiv = document.createElement('div');
            textDiv.className = 'source-item-text';
            textDiv.textContent = fullText;
            body.appendChild(textDiv);
            item.appendChild(body);

            header.onclick = () => {
                const isOpen = item.classList.toggle('is-open');
                header.setAttribute('aria-expanded', String(isOpen));
                scheduleIconRender();
            };

            list.appendChild(item);
            return;
        }

        // ── Нет metadata — fallback: просто текст ссылки ──
        const text = document.createElement('div');
        text.className = 'source-text';
        text.textContent = raw;
        item.appendChild(text);
        list.appendChild(item);
    });

    scheduleIconRender();
}

// Локальный HTML-escaper (на случай если в metadata пришли символы < > & ")
function escapeHTML(s) {
    return String(s || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================
// APPEND MESSAGE (with bot avatar)
// ============================================
function formatMessageMeta(meta) {
    if (!meta || (!meta.ts && !meta.mode)) return null;
    const t = meta.ts ? new Date(meta.ts) : null;
    const timeStr = t ? t.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
    const modeStr = meta.mode === 'thinking' ? 'Думающий' : (meta.mode === 'fast' ? 'Быстрый' : '');
    const parts = [modeStr, timeStr].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
}

function enableMobileActionsToggle(msgDiv) {
    if (!msgDiv) return;
    const isMobile = window.matchMedia && window.matchMedia('(max-width: 480px)').matches;
    if (!isMobile) return;
    if (msgDiv.dataset.mobileActionsToggleBound === '1') return;
    msgDiv.dataset.mobileActionsToggleBound = '1';

    msgDiv.addEventListener('click', (e) => {
        const target = e.target;
        if (!target) return;
        if (target.closest('button, a, code, pre, .sources-container')) return;
        msgDiv.classList.toggle('message-actions-open');
    });
}

function appendMessage(sender, text, animate = true, meta = null) {
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('message', sender === 'user' ? 'user-message' : 'bot-message');
    const contentDiv = document.createElement('div');
    contentDiv.classList.add('message-content');

    if (sender === 'bot') {
        let cleanText = text.replace(/\s*\[\d+\]/g, '');
        const parsedHtml = safeParseMarkdown(cleanText);
        msgDiv.appendChild(contentDiv);
        chatContainer.appendChild(msgDiv);

        if (animate) {
            typeEffect(contentDiv, parsedHtml).then(() => {
                addQuickActions(msgDiv, cleanText);
                addCopyButton(msgDiv, cleanText);
                if ((meta && meta.mode === 'thinking') || currentMode === 'thinking') addDocBuildButton(msgDiv, cleanText);
                enableMobileActionsToggle(msgDiv);
                
                if (meta && meta.sources && meta.sources.length) {
                    renderSources(msgDiv, meta.sources, meta.metadata || []);
                }
            });
        } else {
            contentDiv.innerHTML = parsedHtml;
            addQuickActions(msgDiv, cleanText);
            addCopyButton(msgDiv, cleanText);
            if ((meta && meta.mode === 'thinking') || currentMode === 'thinking') addDocBuildButton(msgDiv, cleanText);
            enableMobileActionsToggle(msgDiv);
            
            if (meta && meta.sources && meta.sources.length) {
                renderSources(msgDiv, meta.sources, meta.metadata || []);
            }
        }
        const metaText = formatMessageMeta(meta);
        if (metaText) {
            const metaDiv = document.createElement('div');
            metaDiv.className = 'message-meta';
            metaDiv.textContent = metaText;
            msgDiv.appendChild(metaDiv);
        }
        scrollToBottom();
        return;
    } else {
        contentDiv.innerText = text;
        msgDiv.appendChild(contentDiv);
        addCopyButton(msgDiv, text);
        enableMobileActionsToggle(msgDiv);
    }
    const metaText = formatMessageMeta(meta);
    if (metaText) {
        const metaDiv = document.createElement('div');
        metaDiv.className = 'message-meta';
        metaDiv.textContent = metaText;
        msgDiv.appendChild(metaDiv);
    }
    chatContainer.appendChild(msgDiv);
    scrollToBottom();
}

function addCopyButton(msgDiv, cleanText) {
    if (msgDiv.querySelector('.copy-btn')) return;
    const copyBtn = document.createElement('button');
    copyBtn.classList.add('copy-btn');
    copyBtn.innerHTML = '<i data-lucide="copy" width="14" height="14"></i> Копировать';
    scheduleIconRender();
    copyBtn.onclick = () => {
        navigator.clipboard.writeText(cleanText);
        copyBtn.innerHTML = '<i data-lucide="check" width="14" height="14"></i> Скопировано';
        scheduleIconRender();
        setTimeout(() => {
            copyBtn.innerHTML = '<i data-lucide="copy" width="14" height="14"></i> Копировать';
            scheduleIconRender();
        }, 2000);
    };
    const quickActions = msgDiv.querySelector('.quick-actions');
    if (quickActions && msgDiv.classList.contains('bot-message')) {
        copyBtn.classList.add('copy-btn-inline');
        quickActions.appendChild(copyBtn);
    } else {
        msgDiv.appendChild(copyBtn);
    }
}

function addQuickActions(msgDiv, cleanText) {
    if (!msgDiv || msgDiv.querySelector('.quick-actions')) return;
    if (!cleanText || !String(cleanText).trim()) return;

    const wrap = document.createElement('div');
    wrap.className = 'quick-actions';
    wrap.innerHTML = `
        <button type="button" class="quick-action" data-action="short">
            <i data-lucide="minimize-2" width="14" height="14"></i><span>Сжать</span>
        </button>
    `;

    // Mobile compression hook (currently only one action)
    const isMobileNarrow = window.matchMedia && window.matchMedia('(max-width: 480px)').matches;
    const isMobileTight = window.matchMedia && window.matchMedia('(max-width: 360px)').matches;
    if (isMobileNarrow) {
        wrap.classList.add('mobile-collapsed');
        if (isMobileTight) wrap.classList.add('mobile-collapsed-tight');
    }

    wrap.addEventListener('click', (e) => {
        const btn = e.target.closest('.quick-action');
        if (!btn) return;
        const action = btn.dataset.action;
        const base = String(cleanText).trim();

        let prompt = base;
        if (action === 'short') {
            prompt = `Сожми и упростить ответ в 5–7 буллетов. Без воды.\n\nОтвет:\n${base}`;
        }

        userInput.value = prompt;
        updateSendBtn();
        sendMessage();
    });

    msgDiv.appendChild(wrap);
    scheduleIconRender();
}

function addDocBuildButton(msgDiv, cleanText) {
    if (!msgDiv || msgDiv.querySelector('.doc-build-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'doc-build-btn';
    btn.innerHTML = '<i data-lucide="file-down" width="14" height="14"></i><span>Сформировать документ (.docx)</span><span class="doc-build-badge">Beta</span>';
    btn.onclick = () => {
        const original = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader-2" width="14" height="14"></i><span>Готовлю .docx…</span>';
        scheduleIconRender();
        exportDocxFromText(cleanText)
            .then(() => {
                btn.innerHTML = '<i data-lucide="check" width="14" height="14"></i><span>Скачано</span>';
                scheduleIconRender();
                setTimeout(() => { btn.disabled = false; btn.innerHTML = original; scheduleIconRender(); }, 1600);
            })
            .catch(() => {
                btn.innerHTML = '<i data-lucide="alert-circle" width="14" height="14"></i><span>Не удалось</span>';
                scheduleIconRender();
                setTimeout(() => { btn.disabled = false; btn.innerHTML = original; scheduleIconRender(); }, 1800);
            });
    };
    msgDiv.appendChild(btn);
    scheduleIconRender();
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2500);
}

function safeDocxFilename(prefix = 'document') {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
    return `${prefix}_${stamp}.docx`;
}

function markdownToDocxParagraphs(text) {
    const { Paragraph, TextRun, HeadingLevel } = docx;

    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let inCode = false;
    let codeBuf = [];

    const pushCode = () => {
        if (!codeBuf.length) return;
        const codeText = codeBuf.join('\n');
        out.push(new Paragraph({
            children: [new TextRun({ text: codeText, font: { name: 'JetBrains Mono' }, size: 22 })],
            spacing: { before: 160, after: 160 },
            shading: { fill: 'F2F4F8' },
        }));
        codeBuf = [];
    };

    for (const rawLine of lines) {
        const line = rawLine ?? '';
        if (line.trim().startsWith('```')) {
            if (inCode) { inCode = false; pushCode(); }
            else { inCode = true; }
            continue;
        }
        if (inCode) { codeBuf.push(line); continue; }

        const h = line.match(/^(#{1,3})\s+(.*)$/);
        if (h) {
            const level = h[1].length;
            const content = h[2].trim();
            out.push(new Paragraph({
                text: content,
                heading: level === 1 ? HeadingLevel.HEADING_1 : (level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3),
                spacing: { before: 220, after: 120 },
            }));
            continue;
        }

        const bullet = line.match(/^\s*[-*]\s+(.*)$/);
        if (bullet) {
            out.push(new Paragraph({
                text: bullet[1],
                bullet: { level: 0 },
                spacing: { before: 80, after: 40 },
            }));
            continue;
        }

        const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
        if (numbered) {
            out.push(new Paragraph({
                text: numbered[1],
                numbering: { reference: 'miyzamchy-numbering', level: 0 },
                spacing: { before: 80, after: 40 },
            }));
            continue;
        }

        if (!line.trim()) {
            out.push(new Paragraph({ text: '', spacing: { after: 80 } }));
            continue;
        }

        out.push(new Paragraph({
            children: [new TextRun({ text: line.trim(), font: { name: 'Inter' }, size: 24 })],
            spacing: { before: 80, after: 80 },
        }));
    }

    if (inCode) pushCode();
    return out;
}

async function exportDocxFromText(answerText) {
    if (!window.docx) throw new Error('docx library not loaded');

    const { Document, Packer, Paragraph } = docx;

    // Minimal numbering config (for 1., 2., ...)
    const doc = new Document({
        styles: {
            default: {
                document: {
                    run: { font: 'Inter', size: 24 },
                    paragraph: { spacing: { line: 320 } },
                },
            },
        },
        numbering: {
            config: [
                {
                    reference: 'miyzamchy-numbering',
                    levels: [
                        {
                            level: 0,
                            format: 'decimal',
                            text: '%1.',
                            alignment: 'left',
                        },
                    ],
                },
            ],
        },
        sections: [
            {
                properties: {},
                children: [
                    new Paragraph({ text: 'Мыйзамчы · Документ', spacing: { after: 200 } }),
                    ...markdownToDocxParagraphs(answerText),
                ],
            },
        ],
    });

    const blob = await Packer.toBlob(doc);
    downloadBlob(blob, safeDocxFilename('miyzamchy'));
}

// ============================================
// TYPE EFFECT (НЕ ТРОНУТО)
// ============================================
async function typeEffect(element, html, speed = 20) {
    const tokens = [];
    let i = 0;
    while (i < html.length) {
        if (html[i] === '<') {
            let j = html.indexOf('>', i);
            if (j !== -1) {
                tokens.push({ type: 'tag', value: html.substring(i, j + 1) });
                i = j + 1;
            } else {
                tokens.push({ type: 'word', value: html[i] });
                i++;
            }
        } else if (html[i] === '&') {
            let j = html.indexOf(';', i);
            if (j !== -1 && j - i < 10) {
                tokens.push({ type: 'word', value: html.substring(i, j + 1) });
                i = j + 1;
            } else {
                tokens.push({ type: 'word', value: html[i] });
                i++;
            }
        } else {
            let word = '';
            while (i < html.length && html[i] !== '<' && html[i] !== '&') {
                word += html[i];
                i++;
                if (html[i - 1] === ' ' || html[i - 1] === '\n') break;
            }
            tokens.push({ type: 'word', value: word });
        }
    }

    let buffer = '';
    for (const token of tokens) {
        buffer += token.value;
        if (token.type === 'word') {
            element.innerHTML = buffer;
            scrollToBottom();
            await new Promise(r => setTimeout(r, speed));
        }
    }
    element.innerHTML = buffer;
    scrollToBottom();
}

// ============================================
// CHAT HISTORY (with date groups)
// ============================================
function getDateGroup(timestamp) {
    const now = new Date();
    const date = new Date(timestamp);
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0 && now.getDate() === date.getDate()) return 'Сегодня';
    if (diffDays <= 1 && (now.getDate() - date.getDate() === 1 || (now.getDate() === 1 && diffDays === 1))) return 'Вчера';
    if (diffDays <= 7) return 'На этой неделе';
    return 'Ранее';
}

function renderHistory() {
    historyList.innerHTML = '';

    const groups = {};
    conversations.forEach(chat => {
        const group = getDateGroup(chat.id);
        if (!groups[group]) groups[group] = [];
        groups[group].push(chat);
    });

    const order = ['Сегодня', 'Вчера', 'На этой неделе', 'Ранее'];
    order.forEach(groupName => {
        if (!groups[groupName]) return;
        const label = document.createElement('li');
        label.className = 'history-group-label';
        label.textContent = groupName;
        historyList.appendChild(label);

        groups[groupName].forEach(chat => {
            const li = document.createElement('li');
            li.className = `history-item ${chat.id === currentChatId ? 'active' : ''}`;
            li.textContent = chat.title;
            li.onclick = () => loadChat(chat.id);
            historyList.appendChild(li);
        });
    });
    initThemeWaveItems();
}

function loadChat(id) {
    currentChatId = id;
    const chat = conversations.find(c => c.id === id);
    chatContainer.innerHTML = '';
    if (chat.messages && chat.messages.length > 0) {
        // Подавляем рендер иконок на время восстановления — иначе 50+ сообщений
        // дадут 150+ глобальных DOM-сканов через appendMessage → addCopyButton/addQuickActions/addDocBuildButton.
        _suppressIconRender = true;
        try {
            chat.messages.forEach(m => appendMessage(m.role, m.text, false, m));
        } finally {
            _suppressIconRender = false;
        }
        flushIconRender();
    }
    renderHistory();
    setTimeout(() => scrollToBottom(true), 50);
}

function scrollToBottom(force = false) {
    if (!force && !isNearBottom(120)) return;
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

chatContainer.addEventListener('scroll', () => {
    if (isNearBottom(100)) streamStickToBottom = true;
    updateJumpToBottomVisibility();
});

// ============================================
// MOBILE MENU
// ============================================
const sidebar = document.getElementById('sidebar');
const menuBtn = document.getElementById('menu-btn');
const closeBtn = document.getElementById('close-btn');
const sidebarOverlay = document.getElementById('sidebar-overlay');

function openMenu() {
    if (window.innerWidth <= 768) {
        sidebar.classList.add('open');
        sidebarOverlay.classList.add('active');
        return;
    }

    if (document.body.classList.contains('sidebar-collapsed')) {
        expandSidebar();
    } else {
        collapseSidebar();
    }
}

function closeMenu() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('active');
}

menuBtn.onclick = openMenu;
closeBtn.onclick = closeMenu;
sidebarOverlay.onclick = closeMenu;
newChatBtn.addEventListener('click', closeMenu);

let touchStartX = 0;
sidebar.addEventListener('touchstart', (e) => { touchStartX = e.changedTouches[0].screenX; });
sidebar.addEventListener('touchend', (e) => {
    if (touchStartX - e.changedTouches[0].screenX > 50) closeMenu();
});

// ============================================
// COLLAPSIBLE SIDEBAR (desktop)
// ============================================
const sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
const sidebarExpandBtn = document.getElementById('sidebar-expand-btn');

function collapseSidebar() {
    document.body.classList.add('sidebar-collapsed');
    try { localStorage.setItem('miyzamchi_sidebar', 'collapsed'); } catch(e) {}
}

function expandSidebar() {
    document.body.classList.remove('sidebar-collapsed');
    try { localStorage.setItem('miyzamchi_sidebar', 'expanded'); } catch(e) {}
}

if (sidebarCollapseBtn) sidebarCollapseBtn.onclick = collapseSidebar;
if (sidebarExpandBtn) sidebarExpandBtn.onclick = expandSidebar;

(function restoreSidebar() {
    const saved = localStorage.getItem('miyzamchi_sidebar');
    if (saved === 'collapsed') document.body.classList.add('sidebar-collapsed');
})();

// ============================================
// SEND HANDLERS
// ============================================
sendBtn.onclick = () => {
    if (isStreamingResponse) stopResponse();
    else sendMessage();
};
userInput.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (isStreamingResponse) stopResponse();
        else sendMessage();
    }
};

// ============================================
// ACCESSIBILITY — keyboard nav + mobile backdrop for mode dropdown
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    const trigger = document.getElementById('mode-trigger');
    const dropdown = document.getElementById('mode-dropdown');
    if (!trigger || !dropdown) return;

    let backdrop = null;

    function openMobileBackdrop() {
        if (window.innerWidth <= 768 && !backdrop) {
            backdrop = document.createElement('div');
            backdrop.className = 'mode-backdrop';
            document.body.appendChild(backdrop);
            backdrop.addEventListener('click', closeMobileBackdrop);
        }
    }

    function closeMobileBackdrop() {
        if (backdrop) {
            backdrop.remove();
            backdrop = null;
        }
    }

    // Watch dropdown state for mobile backdrop
    const dropdownObserver = new MutationObserver(() => {
        if (dropdown.hidden) {
            closeMobileBackdrop();
            trigger.setAttribute('aria-expanded', 'false');
        } else {
            openMobileBackdrop();
            trigger.setAttribute('aria-expanded', 'true');
            const firstOption = dropdown.querySelector('.mode-option:not(.mode-option--disabled)');
            if (firstOption) firstOption.focus();
        }
    });
    dropdownObserver.observe(dropdown, { attributes: true, attributeFilter: ['hidden'] });

    document.addEventListener('keydown', (e) => {
        if (!dropdown.hidden) {
            if (e.key === 'Escape') {
                dropdown.hidden = true;
                trigger.classList.remove('open');
                trigger.setAttribute('aria-expanded', 'false');
                trigger.focus();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const options = Array.from(dropdown.querySelectorAll('.mode-option:not(.mode-option--disabled)'));
                const currentIndex = options.indexOf(document.activeElement);
                let nextIndex = currentIndex;
                if (e.key === 'ArrowDown') {
                    nextIndex = (currentIndex + 1) % options.length;
                } else {
                    nextIndex = currentIndex <= 0 ? options.length - 1 : currentIndex - 1;
                }
                options[nextIndex].focus();
            }
        }
    });
});

// ============================================
// INIT
// ============================================
init();
