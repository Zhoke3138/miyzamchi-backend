import { useRef, useEffect, useCallback } from 'react';

const PaperclipIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
  </svg>
);

const MicIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" x2="12" y1="19" y2="22"/>
  </svg>
);

const ArrowUpIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 19V5"/>
    <path d="M5 12l7-7 7 7"/>
  </svg>
);

/* ── PromptBox ─────────────────────────────────────────────────────────
   Props:
     id           – textarea id (for external .focus() calls)
     value        – controlled value
     onChange     – (e) => void
     onSubmit     – () => void  called on Enter / send click
     placeholder  – string
     disabled     – bool  (disables send button)
     onAttach     – () => void  shows paperclip button when provided
     onVoice      – () => void  shows mic button when provided
     listening    – bool  mic active state
     attachmentsNode – JSX rendered inside the box above the textarea
     maxHeight    – number px, default 200
     className    – extra class on wrapper
   ──────────────────────────────────────────────────────────────────── */
export const PromptBox = ({
  id,
  value = '',
  onChange,
  onSubmit,
  placeholder = 'Введите сообщение…',
  disabled = false,
  onAttach,
  onVoice,
  listening = false,
  attachmentsNode,
  maxHeight = 200,
  className = '',
}) => {
  const taRef = useRef(null);

  /* '1px' trick: collapse first so scrollHeight = true content height,
     then expand. CSS max-height handles the cap + shows scrollbar. */
  const resize = useCallback((el) => {
    if (!el) return;
    el.style.height = '1px';
    const natural = el.scrollHeight;
    el.style.height = natural + 'px';
    /* Show scrollbar only when content exceeds cap */
    el.style.overflowY = natural >= maxHeight ? 'auto' : 'hidden';
  }, [maxHeight]);

  /* Resize when value changes externally (e.g. state set from outside) */
  useEffect(() => { resize(taRef.current); }, [value, resize]);

  const handleChange = (e) => {
    onChange?.(e);
    resize(e.target);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim() && !disabled) onSubmit?.();
    }
  };

  const hasContent = value.trim().length > 0;
  const sendDisabled = disabled || !hasContent;

  return (
    <div className={`myz-pb${className ? ` ${className}` : ''}`}>
      {attachmentsNode && (
        <div className="myz-pb-attach-preview">{attachmentsNode}</div>
      )}
      <textarea
        id={id}
        ref={taRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
        className="myz-pb-textarea"
      />
      <div className="myz-pb-footer">
        <div className="myz-pb-footer-left">
          {onAttach && (
            <button type="button" onClick={onAttach}
              className="myz-pb-icon-btn"
              title="Прикрепить файл (PDF / DOCX / TXT / изображение)">
              <PaperclipIcon size={16} />
            </button>
          )}
        </div>
        <div className="myz-pb-footer-right">
          {onVoice && (
            <button type="button" onClick={onVoice}
              className={`myz-pb-icon-btn${listening ? ' myz-pb-mic-active' : ''}`}
              title={listening ? 'Остановить запись' : 'Голосовой ввод (Web Speech API)'}>
              <MicIcon size={14} />
            </button>
          )}
          <button type="button" onClick={() => !sendDisabled && onSubmit?.()}
            disabled={sendDisabled}
            className={`myz-pb-send${!sendDisabled ? ' myz-pb-send--active' : ''}`}
            title="Отправить (Enter)">
            <ArrowUpIcon size={15} />
          </button>
        </div>
      </div>
    </div>
  );
};
