// ═══════════════════════════════════════════════════════════════════
// OnlyOfficeEditor.jsx — Компонент редактора ONLYOFFICE (Этап 2)
// Заменяет <SuperDocEditor> из @superdoc-dev/react.
//
// Props:
//   fileId       {string}   — ID файла в storage/documents/
//   documentKey  {string}   — Уникальный ключ версии
//   onSaved      {function} — (newKey: string) => void
//   onError      {function} — (msg: string) => void
// ═══════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState, useCallback } from 'react';

const BACKEND_URL    = import.meta.env.VITE_BACKEND_URL    || 'https://miyzamchi-backend.onrender.com';
const ONLYOFFICE_URL = import.meta.env.VITE_ONLYOFFICE_URL || 'http://localhost:8080';

// ── Синглтон: один <script> api.js на всё приложение ──────────────
let _apiState = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
const _apiWaiters = [];

function ensureDocsApi() {
    return new Promise((resolve, reject) => {
        if (_apiState === 'ready')  { resolve(); return; }
        if (_apiState === 'error')  { reject(new Error('api.js не загрузился')); return; }
        _apiWaiters.push({ resolve, reject });
        if (_apiState === 'loading') return;

        _apiState = 'loading';
        const script = document.createElement('script');
        script.src = `${ONLYOFFICE_URL}/web-apps/apps/api/documents/api.js`;
        script.onload = () => {
            _apiState = 'ready';
            _apiWaiters.forEach(w => w.resolve());
            _apiWaiters.length = 0;
        };
        script.onerror = () => {
            _apiState = 'error';
            const err = new Error(`Не удалось загрузить api.js с ${ONLYOFFICE_URL}`);
            _apiWaiters.forEach(w => w.reject(err));
            _apiWaiters.length = 0;
        };
        document.head.appendChild(script);
    });
}

// ── Компонент ──────────────────────────────────────────────────────
export function OnlyOfficeEditor({ fileId, documentKey, onSaved, onError }) {
    const containerRef = useRef(null);
    const editorRef    = useRef(null);
    const mountedRef   = useRef(true);
    const [status, setStatus] = useState('idle'); // 'idle'|'loading'|'ready'|'error'
    const [errMsg, setErrMsg] = useState('');

    const containerId = `oo-editor-${fileId}`;

    const destroyEditor = useCallback(() => {
        if (editorRef.current) {
            try { editorRef.current.destroyEditor(); } catch (_) {}
            editorRef.current = null;
        }
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    useEffect(() => {
        if (!fileId) return;
        let cancelled = false;

        async function init() {
            setStatus('loading');
            setErrMsg('');

            try {
                // 1. Убедиться что api.js загружен
                await ensureDocsApi();
                if (cancelled) return;

                if (!window.DocsAPI) throw new Error('DocsAPI недоступен после загрузки');

                // 2. Получить подписанный конфиг с бэкенда
                const resp = await fetch(`${BACKEND_URL}/api/files/${fileId}/config`);
                if (!resp.ok) throw new Error(`Конфиг: HTTP ${resp.status}`);
                const config = await resp.json();
                if (cancelled) return;

                // 3. Подменить key если передан свежий
                if (documentKey) config.document.key = documentKey;

                // 4. Привязать события
                config.events = {
                    onAppReady: () => {
                        if (mountedRef.current) setStatus('ready');
                    },
                    onError: ({ data }) => {
                        const msg = data?.errorDescription || 'Ошибка редактора';
                        if (mountedRef.current) { setStatus('error'); setErrMsg(msg); }
                        onError?.(msg);
                    },
                    // После успешного сохранения — обновить documentKey в родителе
                    onDocumentStateChange: (event) => {
                        if (event.data === false && typeof onSaved === 'function') {
                            fetch(`${BACKEND_URL}/api/files/${fileId}/config`)
                                .then(r => r.json())
                                .then(c => { if (mountedRef.current) onSaved(c.document?.key); })
                                .catch(() => {});
                        }
                    }
                };

                // 5. Уничтожить предыдущий экземпляр и создать новый
                destroyEditor();
                editorRef.current = new window.DocsAPI.DocEditor(containerId, config);

            } catch (err) {
                if (!cancelled && mountedRef.current) {
                    setStatus('error');
                    setErrMsg(err.message);
                    onError?.(err.message);
                }
            }
        }

        init();
        return () => {
            cancelled = true;
            destroyEditor();
        };
    }, [fileId, documentKey]);

    // ── Render ──────────────────────────────────────────────────────
    return (
        <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 600 }}>

            {/* Оверлей загрузки */}
            {status === 'loading' && (
                <div style={styles.overlay}>
                    <div style={styles.spinner} />
                    <p style={styles.overlayText}>Загрузка ONLYOFFICE…</p>
                </div>
            )}

            {/* Оверлей ошибки */}
            {status === 'error' && (
                <div style={{ ...styles.overlay, background: '#fff0f0' }}>
                    <p style={{ color: '#c00', fontFamily: 'sans-serif' }}>⚠ {errMsg}</p>
                    <p style={{ color: '#666', fontSize: 12, fontFamily: 'sans-serif' }}>
                        Убедитесь что DocServer доступен по адресу: <code>{ONLYOFFICE_URL}</code>
                    </p>
                </div>
            )}

            {/* Пустой экран если fileId не задан */}
            {!fileId && status === 'idle' && (
                <div style={styles.overlay}>
                    <p style={{ color: '#888', fontFamily: 'sans-serif' }}>
                        Откройте документ .docx для редактирования
                    </p>
                </div>
            )}

            {/* Контейнер DocEditor */}
            <div
                id={containerId}
                ref={containerRef}
                style={{ width: '100%', height: '100%', visibility: status === 'ready' ? 'visible' : 'hidden' }}
            />
        </div>
    );
}

const styles = {
    overlay: {
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: '#f8f8f8', zIndex: 10
    },
    overlayText: { marginTop: 16, color: '#555', fontFamily: 'sans-serif', fontSize: 14 },
    spinner: {
        width: 36, height: 36,
        border: '3px solid #ddd',
        borderTop: '3px solid #0069ff',
        borderRadius: '50%',
        animation: 'oo-spin 0.8s linear infinite'
    }
};

// Инжектируем keyframes один раз
if (typeof document !== 'undefined' && !document.getElementById('oo-spin-style')) {
    const s = document.createElement('style');
    s.id = 'oo-spin-style';
    s.textContent = '@keyframes oo-spin { to { transform: rotate(360deg); } }';
    document.head.appendChild(s);
}
