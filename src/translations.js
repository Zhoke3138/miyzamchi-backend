// ═══ Единый словарь локализации Miyzamchi: KY | RU | EN ═══
// Используется ОБЕИМИ страницами MPA:
//   • лендинг-чат (/)                    — src/i18n-chat.js (vanilla, data-i18n)
//   • Legal Workspace (/workspace.html)  — src/App.jsx (хук useI18n)
// Выбранный язык живёт в localStorage['app_language'] и переживает переход
// между страницами. Первый визит без сохранённого языка: берём язык браузера
// (ky → кыргызча, en → English, иначе ru) — модераторы Google For Startups
// с en-локалью сразу видят английский интерфейс.

const STORAGE_KEY = 'app_language';
export const LANGS = ['ky', 'ru', 'en'];

const detectLang = () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (LANGS.includes(saved)) return saved;
  } catch (e) {}
  const nav = ((typeof navigator !== 'undefined' && navigator.language) || '').toLowerCase();
  if (nav.startsWith('ky')) return 'ky';
  if (nav.startsWith('en')) return 'en';
  return 'ru';
};

let current = detectLang();
const listeners = new Set();

export const getAppLang = () => current;
export const setAppLang = (lang) => {
  if (!LANGS.includes(lang) || lang === current) return;
  current = lang;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) {}
  listeners.forEach(fn => { try { fn(lang); } catch (e) {} });
};
export const subscribeLang = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export const TRANSLATIONS = {
  ru: {
    // ── Лендинг-чат (/) ──
    welcome_tagline: 'Добро пожаловать в Miyzamchi — AI-экосистема LegalTech и интеллектуальный ассистент по законодательству Кыргызской Республики',
    chat_subtitle: 'Юридический помощник по законодательству Кыргызстана',
    open_workspace: 'Открыть Workspace',
    input_placeholder: 'Введите юридический запрос...',
    footer_disclaimer: 'Мыйзамчы — образовательный инструмент. Перед принятием решений проконсультируйтесь с юристом.',
    new_chat: 'Новый чат',
    recent_cases: 'Недавние дела',
    game_swipe: 'Свайп правосудия',
    game_lawyer: 'Стать юристом',
    hint_city: 'Укажите город и ведомство',
    hint_date: 'Добавьте дату и сроки',
    hint_party: 'Опишите сторону спора',
    card_court: 'Как подать иск в суд?',
    card_court_prompt: 'Как подать исковое заявление в суд?',
    card_dismissal: 'Мои права при увольнении',
    card_dismissal_prompt: 'Какие у меня трудовые права при увольнении?',
    card_complaint: 'Составить жалобу',
    card_complaint_prompt: 'Составь жалобу на действия работодателя',
    card_limitation: 'Что такое исковая давность?',
    card_limitation_prompt: 'Объясни что такое исковая давность простыми словами',
    // ── Workspace: меню ──
    menu_file: 'Файл', menu_edit: 'Правка', menu_view: 'Вид', menu_go: 'Перейти',
    menu_draft: 'Черновик', menu_law: 'Право', menu_help: 'Справка',
    mi_new_doc: 'Новый документ', mi_open_file: 'Открыть файл...', mi_open_folder: 'Открыть папку...',
    mi_save: 'Сохранить', mi_export_pdf: 'Экспорт в PDF', mi_export_word: 'Экспорт в Word (.docx)',
    mi_close_editor: 'Закрыть редактор', mi_close_all: 'Закрыть всё',
    mi_undo: 'Отменить', mi_redo: 'Повторить', mi_find: 'Найти',
    mi_left_panel: 'Левая панель', mi_ai_panel: 'Панель ИИ', mi_split_editor: 'Разделить редактор',
    mi_theme: 'Сменить тему', mi_palette: 'Палитра команд', mi_outline: 'Структура',
    // ── Workspace: статус-pills и шапка ──
    pill_saved: 'Сохранено', pill_unsaved: 'Несохранено',
    pill_analyzing: 'Анализ…', pill_ready: 'Готово к анализу',
    to_chat: 'В чат',
    // ── Workspace: AI-чат ──
    apply: 'Применить', reject: 'Отклонить',
    ws_ph_selection: '✨ Улучшить выделенный текст...',
    ws_ph_doc: 'Спросить о документе…',
    ws_ph_legal: 'Задать юридический вопрос…',
    pane_npa: 'Просмотр НПА', pane_chat: 'ИИ Чат',
    // ── Премиум-лендинг (/) ──
    lp_badge: 'AI-экосистема LegalTech · Кыргызская Республика',
    lp_title: 'Miyzamchi. Искусственный интеллект для законодательства Кыргызской Республики',
    lp_subtitle: 'AI-экосистема LegalTech и интеллектуальный ассистент по законодательству КР. Анализ документов, поиск противоречий с НПА и профессиональный редактор — в одном месте.',
    lp_cta: 'Открыть ИИ-ассистента',
    lp_signin: 'Войти',
    lp_section_title: 'Единая экосистема',
    lp_section_subtitle: 'Три инструмента, которые закрывают весь цикл работы юриста.',
    lp_card1_desc: 'Профессиональный редактор юридических документов на SuperDoc: правки в режиме рецензирования, экспорт в Word и PDF, AI-агент прямо в тексте.',
    lp_card2_desc: 'Мультиагентная RAG-система по законодательству КР: поиск противоречий с НПА, цитаты со ссылками на статьи, аудит договоров и исков.',
    lp_card3_desc: 'Автоматизация работы с клиентами: приём заявок, выставление счетов и напоминания прямо в WhatsApp — без ручной рутины.',
    lp_footer: 'Юридический ИИ-ассистент Кыргызской Республики'
  },
  ky: {
    // ── Лендинг-чат (/) ──
    welcome_tagline: 'Miyzamchi-ге кош келиңиз — Кыргыз Республикасынын мыйзамдары боюнча AI-негизделген LegalTech экосистемасы жана акылдуу жардамчы',
    chat_subtitle: 'КР мыйзамдары боюнча юридикалык жардамчы',
    open_workspace: 'Workspace-ти ачуу',
    input_placeholder: 'Сурооңузду жазыңыз...',
    footer_disclaimer: 'Мыйзамчы — окутуу куралы. Чечим кабыл алуудан мурда юрист менен кеңешиңиз.',
    new_chat: 'Жаңы маек',
    recent_cases: 'Акыркы иштер',
    game_swipe: 'Адилеттик свайпы',
    game_lawyer: 'Юрист болуу',
    hint_city: 'Шаарды жана мекемени көрсөтүңүз',
    hint_date: 'Датаны жана мөөнөттөрдү кошуңуз',
    hint_party: 'Талаштын тарабын сүрөттөңүз',
    card_court: 'Сотко доону кантип берүү керек?',
    card_court_prompt: 'Сотко доо арызды кантип берсе болот?',
    card_dismissal: 'Жумуштан бошотуудагы укуктарым',
    card_dismissal_prompt: 'Жумуштан бошотулганда менин эмгек укуктарым кандай?',
    card_complaint: 'Даттануу түзүү',
    card_complaint_prompt: 'Иш берүүчүнүн аракеттерине даттануу түзүп бер',
    card_limitation: 'Доонун эскириши деген эмне?',
    card_limitation_prompt: 'Доонун эскириши эмне экенин жөнөкөй сөз менен түшүндүрүп бер',
    // ── Workspace: меню ──
    menu_file: 'Файл', menu_edit: 'Оңдоо', menu_view: 'Көрүнүш', menu_go: 'Өтүү',
    menu_draft: 'Долбоор', menu_law: 'Укук', menu_help: 'Жардам',
    mi_new_doc: 'Жаңы документ', mi_open_file: 'Файл ачуу...', mi_open_folder: 'Папка ачуу...',
    mi_save: 'Сактоо', mi_export_pdf: 'PDF форматына экспорт', mi_export_word: 'Word (.docx) форматына экспорт',
    mi_close_editor: 'Редакторду жабуу', mi_close_all: 'Баарын жабуу',
    mi_undo: 'Артка кайтаруу', mi_redo: 'Кайталоо', mi_find: 'Издөө',
    mi_left_panel: 'Сол панель', mi_ai_panel: 'AI панели', mi_split_editor: 'Редакторду бөлүү',
    mi_theme: 'Теманы алмаштыруу', mi_palette: 'Командалар палитрасы', mi_outline: 'Түзүм',
    // ── Workspace: статус-pills и шапка ──
    pill_saved: 'Сакталды', pill_unsaved: 'Сакталган жок',
    pill_analyzing: 'Талдоо…', pill_ready: 'Талдоого даяр',
    to_chat: 'Маекке',
    // ── Workspace: AI-чат ──
    apply: 'Колдонуу', reject: 'Четке кагуу',
    ws_ph_selection: '✨ Белгиленген текстти жакшыртуу...',
    ws_ph_doc: 'Документ жөнүндө суроо…',
    ws_ph_legal: 'Юридикалык суроо берүү…',
    pane_npa: 'ЧУА көрүү', pane_chat: 'AI маек',
    // ── Премиум-лендинг (/) ──
    lp_badge: 'AI LegalTech экосистемасы · Кыргыз Республикасы',
    lp_title: 'Miyzamchi. Кыргыз Республикасынын мыйзамдары үчүн жасалма интеллект',
    lp_subtitle: 'КР мыйзамдары боюнча AI LegalTech экосистемасы жана акылдуу жардамчы. Документтерди талдоо, ЧУА менен карама-каршылыктарды издөө жана кесипкөй редактор — бир жерде.',
    lp_cta: 'ИИ-жардамчыны ачуу',
    lp_signin: 'Кирүү',
    lp_section_title: 'Бирдиктүү экосистема',
    lp_section_subtitle: 'Юристтин бардык иш циклин камтыган үч курал.',
    lp_card1_desc: 'SuperDoc негизинде юридикалык документтердин кесипкөй редактору: рецензиялоо режиминде оңдоолор, Word жана PDF форматына экспорт, текстте AI-агент.',
    lp_card2_desc: 'КР мыйзамдары боюнча көп агенттик RAG-система: ЧУА менен карама-каршылыктарды издөө, беренелерге шилтемелер менен цитаталар, келишимдерди жана доолорду текшерүү.',
    lp_card3_desc: 'Кардарлар менен иштөөнү автоматташтыруу: арыздарды кабыл алуу, эсеп коюу жана эскертүүлөр түз эле WhatsApp\'та — кол менен иштебестен.',
    lp_footer: 'Кыргыз Республикасынын юридикалык ИИ-жардамчысы'
  },
  en: {
    // ── Landing chat (/) ──
    welcome_tagline: 'Welcome to Miyzamchi — An AI-powered LegalTech ecosystem and intelligent assistant for the legislation of the Kyrgyz Republic',
    chat_subtitle: 'AI Legal Assistant for the legislation of the Kyrgyz Republic',
    open_workspace: 'Open Legal Workspace',
    input_placeholder: 'Type your prompt...',
    footer_disclaimer: 'Miyzamchi is an educational tool. Consult a qualified lawyer before making decisions.',
    new_chat: 'New chat',
    recent_cases: 'Recent cases',
    game_swipe: 'Justice Swipe',
    game_lawyer: 'Become a Lawyer',
    hint_city: 'Mention the city and authority',
    hint_date: 'Add dates and deadlines',
    hint_party: 'Describe your side of the dispute',
    card_court: 'How do I file a lawsuit?',
    card_court_prompt: 'How do I file a statement of claim in court?',
    card_dismissal: 'My rights upon dismissal',
    card_dismissal_prompt: 'What are my labor rights upon dismissal?',
    card_complaint: 'Draft a complaint',
    card_complaint_prompt: "Draft a complaint about my employer's actions",
    card_limitation: 'What is the statute of limitations?',
    card_limitation_prompt: 'Explain the statute of limitations in simple terms',
    // ── Workspace: menus ──
    menu_file: 'File', menu_edit: 'Edit', menu_view: 'View', menu_go: 'Go',
    menu_draft: 'Draft', menu_law: 'Law', menu_help: 'Help',
    mi_new_doc: 'New document', mi_open_file: 'Open file...', mi_open_folder: 'Open folder...',
    mi_save: 'Save', mi_export_pdf: 'Export to PDF', mi_export_word: 'Export to Word (.docx)',
    mi_close_editor: 'Close editor', mi_close_all: 'Close all',
    mi_undo: 'Undo', mi_redo: 'Redo', mi_find: 'Find',
    mi_left_panel: 'Left panel', mi_ai_panel: 'AI panel', mi_split_editor: 'Split editor',
    mi_theme: 'Toggle theme', mi_palette: 'Command palette', mi_outline: 'Outline',
    // ── Workspace: status pills & header ──
    pill_saved: 'Saved', pill_unsaved: 'Unsaved',
    pill_analyzing: 'Analyzing…', pill_ready: 'Ready for analysis',
    to_chat: 'To chat',
    // ── Workspace: AI chat ──
    apply: 'Apply', reject: 'Reject',
    ws_ph_selection: '✨ Improve the selected text...',
    ws_ph_doc: 'Ask about the document…',
    ws_ph_legal: 'Ask a legal question…',
    pane_npa: 'NLA viewer', pane_chat: 'AI Chat',
    // ── Premium landing (/) ──
    lp_badge: 'AI-powered LegalTech ecosystem · Kyrgyz Republic',
    lp_title: 'Miyzamchi. Artificial intelligence for the legislation of the Kyrgyz Republic',
    lp_subtitle: 'An AI-powered LegalTech ecosystem and intelligent assistant for the legislation of the Kyrgyz Republic. Document analysis, contradiction detection against laws, and a professional editor — all in one place.',
    lp_cta: 'Open the AI assistant',
    lp_signin: 'Sign in',
    lp_section_title: 'A unified ecosystem',
    lp_section_subtitle: "Three tools that cover a lawyer's entire workflow.",
    lp_card1_desc: 'A professional legal document editor built on SuperDoc: track-changes editing, export to Word and PDF, and an AI agent right inside the text.',
    lp_card2_desc: 'A multi-agent RAG system for Kyrgyz law: detects contradictions with regulations, cites articles with references, audits contracts and claims.',
    lp_card3_desc: 'Client workflow automation: intake requests, issue invoices, and send reminders right in WhatsApp — no manual routine.',
    lp_footer: 'AI legal assistant for the Kyrgyz Republic'
  }
};

export const t = (key, lang) => {
  const l = lang || current;
  const v = TRANSLATIONS[l] && TRANSLATIONS[l][key];
  if (v != null) return v;
  const ru = TRANSLATIONS.ru[key];
  return ru != null ? ru : key;
};
