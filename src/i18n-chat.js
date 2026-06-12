// ═══ Локализация лендинг-чата (ChatMZ): KY | RU | EN ═══
// Работает ПОВЕРХ легаси script.js, НЕ трогая его логику (SSE, история,
// режимы — святое). Переводим только статические элементы разметки через
// data-атрибуты:
//   data-i18n="key"             → textContent
//   data-i18n-placeholder="key" → атрибут placeholder
//   data-i18n-prompt="key"      → атрибут data-prompt (welcome-карточки,
//                                 script.js читает его в момент клика)
// Язык шарится с Workspace через localStorage['app_language'].
import { t, getAppLang, setAppLang, subscribeLang } from './translations.js';

const apply = (lang) => {
  document.documentElement.setAttribute('lang', lang);
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'), lang);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'), lang));
  });
  document.querySelectorAll('[data-i18n-prompt]').forEach(el => {
    el.setAttribute('data-prompt', t(el.getAttribute('data-i18n-prompt'), lang));
  });
  document.querySelectorAll('.lang-switch-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
  });
};

document.querySelectorAll('.lang-switch-btn').forEach(btn => {
  btn.addEventListener('click', () => setAppLang(btn.getAttribute('data-lang')));
});

subscribeLang(apply);
apply(getAppLang());
