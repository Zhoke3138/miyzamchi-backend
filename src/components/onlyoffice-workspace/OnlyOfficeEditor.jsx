// ═══════════════════════════════════════════════════════════════════
// OnlyOfficeEditor.jsx — Компонент редактора ONLYOFFICE
//
// АРХИТЕКТУРНОЕ РЕШЕНИЕ: ONLYOFFICE (DocsAPI.DocEditor) заменяет/перемещает
// контейнерный div в DOM, из-за чего React падает с insertBefore NotFoundError
// при следующей reconciliation. Решение: контейнер создаётся IMPERATIVELY
// через useEffect/appendChild — React его никогда не видит в своём fiber-дереве
// и не пытается вставлять/удалять относительно него.
// ═══════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react';

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
export function OnlyOfficeEditor({ fileId, onSaved, onError }) {
    const hostRef   = useRef(null); // React управляет только этим div; детей внутри нет
    const editorRef = useRef(null);
    const [status, setStatus] = useState('loading');
    const [errMsg, setErrMsg] = useState('');

    useEffect(() => {
        if (!fileId || !hostRef.current) return;
        let cancelled = false;
        const containerId = `oo-editor-${fileId}`;

        // Создаём контейнер IMPERATIVELY — React его не видит и не трогает.
        // DocsAPI может делать с ним что угодно (заменять, перемещать) без
        // конфликта с reconciler'ом.
        const container = document.createElement('div');
        container.id = containerId;
        container.style.cssText = 'width:100%;height:100%;';
        hostRef.current.appendChild(container);

        async function init() {
            try {
                await ensureDocsApi();
                if (cancelled) return;
                if (!window.DocsAPI) throw new Error('DocsAPI недоступен после загрузки');

                const resp = await fetch(`${BACKEND_URL}/api/files/${fileId}/config`);
                if (!resp.ok) throw new Error(`Конфиг: HTTP ${resp.status}`);
                const config = await resp.json();
                if (cancelled) return;

                config.events = {
                    onAppReady: () => {
                        if (!cancelled) setStatus('ready');
                    },
                    onError: ({ data }) => {
                        const msg = data?.errorDescription || 'Ошибка редактора';
                        if (!cancelled) { setStatus('error'); setErrMsg(msg); }
                        onError?.(msg);
                    },
                    onDocumentStateChange: (event) => {
                        if (event.data === false) {
                            fetch(`${BACKEND_URL}/api/files/${fileId}/config`)
                                .then(r => r.json())
                                .then(c => { if (!cancelled) onSaved?.(c.document?.key); })
                                .catch(() => {});
                        }
                    }
                };

                if (editorRef.current) {
                    try { editorRef.current.destroyEditor(); } catch (_) {}
                }
                editorRef.current = new window.DocsAPI.DocEditor(containerId, config);
            } catch (err) {
                if (!cancelled) {
                    setStatus('error');
                    setErrMsg(err.message);
                    onError?.(err.message);
                }
            }
        }

        init();

        return () => {
            cancelled = true;
            if (editorRef.current) {
                try { editorRef.current.destroyEditor(); } catch (_) {}
                editorRef.current = null;
            }
            if (container.parentNode) container.remove();
        };
    }, [fileId]);

    // ── Render ──────────────────────────────────────────────────────
    // Структура: внешний div (position:relative) содержит:
    //   1. Overlay'ы загрузки/ошибки — React-managed, absolute поверх
    //   2. hostRef div — React-managed, НО без React-детей.
    //      ONLYOFFICE container создаётся внутри него imperatively через useEffect.
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
                        Убедитесь что DocServer доступен: <code>{ONLYOFFICE_URL}</code>
                    </p>
                </div>
            )}

            {/* HOST: React не рендерит сюда детей — ONLYOFFICE пишет сюда imperatively.
                visibility управляет видимостью без DOM-конфликтов. */}
            <div
                ref={hostRef}
                style={{
                    position: 'absolute',
                    inset: 0,
                    visibility: status === 'ready' ? 'visible' : 'hidden',
                    overflow: 'hidden',
                }}
            />
        </div>
    );
}

const styles = {
    overlay: {
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        background: '#f8f8f8', zIndex: 10,
    },
    overlayText: { marginTop: 16, color: '#555', fontFamily: 'sans-serif', fontSize: 14 },
    spinner: {
        width: 36, height: 36,
        border: '3px solid #ddd',
        borderTop: '3px solid #0069ff',
        borderRadius: '50%',
        animation: 'oo-spin 0.8s linear infinite',
    },
};

// Инжектируем keyframes один раз
if (typeof document !== 'undefined' && !document.getElementById('oo-spin-style')) {
    const s = document.createElement('style');
    s.id = 'oo-spin-style';
    s.textContent = '@keyframes oo-spin { to { transform: rotate(360deg); } }';
    document.head.appendChild(s);
}
