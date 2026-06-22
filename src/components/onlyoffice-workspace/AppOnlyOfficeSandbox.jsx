// ═══════════════════════════════════════════════════════════════════
// AppOnlyOfficeSandbox.jsx — Тестовый клон App.jsx с ONLYOFFICE
// Этап 2 миграции: изолированная песочница, App.jsx не трогаем.
//
// Чтобы переключиться на этот компонент для тестирования,
// в src/main.jsx замените <App /> на <AppOnlyOfficeSandbox />.
// ═══════════════════════════════════════════════════════════════════

import { useState, useCallback, useRef } from 'react';
import { OnlyOfficeEditor } from './OnlyOfficeEditor.jsx';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'https://miyzamchi-backend.onrender.com';

// ── Toast (уведомления) ────────────────────────────────────────────
let _tid = 0;
function useToasts() {
    const [toasts, setToasts] = useState([]);
    const add = useCallback((icon, text, dur = 3) => {
        const id = ++_tid;
        setToasts(p => [...p.slice(-4), { id, icon, text }]);
        setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), dur * 1000);
    }, []);
    return [toasts, add];
}

const ICONS = { file:'📄', plus:'➕', save:'💾', trash:'🗑', warning:'⚠️', law:'⚖️', ok:'✅', spin:'⏳' };

// ── Загрузка файла на бэкенд ───────────────────────────────────────
async function uploadDocx(file) {
    const form = new FormData();
    form.append('file', file, file.name);
    const resp = await fetch(`${BACKEND_URL}/api/files/upload`, { method: 'POST', body: form });
    if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
    return resp.json(); // { fileId, documentKey, filename, config }
}

// ── AI Chat (SSE) ─────────────────────────────────────────────────
function useMiyzamchiChat() {
    const [messages, setMessages] = useState([]);
    const [loading, setLoading] = useState(false);
    const abortRef = useRef(null);

    const send = useCallback(async (text, selectedText = '') => {
        const userMsg = selectedText
            ? `Контекст из документа:\n"${selectedText}"\n\nВопрос: ${text}`
            : text;

        setMessages(p => [...p, { role: 'user', content: text }]);
        setLoading(true);

        let answer = '';
        setMessages(p => [...p, { role: 'ai', content: '', loading: true }]);

        try {
            abortRef.current?.abort();
            abortRef.current = new AbortController();

            const resp = await fetch(`${BACKEND_URL}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: userMsg, mode: 'fast', agentMode: false }),
                signal: abortRef.current.signal
            });

            const reader  = resp.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                for (const line of decoder.decode(value).split('\n')) {
                    if (!line.startsWith('data: ')) continue;
                    try {
                        const d = JSON.parse(line.slice(6));
                        if (d.type === 'text') {
                            answer += d.content;
                            setMessages(p => p.map((m, i) =>
                                i === p.length - 1 ? { ...m, content: answer } : m
                            ));
                        }
                        if (d.type === '[DONE]' || d === '[DONE]') break;
                    } catch (_) {}
                }
            }
        } catch (e) {
            if (e.name !== 'AbortError') {
                setMessages(p => p.map((m, i) =>
                    i === p.length - 1 ? { ...m, content: '⚠ Ошибка: ' + e.message, loading: false } : m
                ));
            }
        } finally {
            setLoading(false);
            setMessages(p => p.map((m, i) =>
                i === p.length - 1 ? { ...m, loading: false } : m
            ));
        }
    }, []);

    return { messages, loading, send };
}

// ── Главный компонент ─────────────────────────────────────────────
export default function AppOnlyOfficeSandbox() {
    const [toasts, addToast] = useToasts();
    const [dark, setDark]    = useState(false);
    const [tabs, setTabs]    = useState([]); // { id, name, fileId, documentKey }
    const [activeTab, setActiveTab] = useState(null);
    const [rightOpen, setRightOpen] = useState(true);
    const [chatInput, setChatInput] = useState('');
    const { messages, loading: chatLoading, send: sendChat } = useMiyzamchiChat();
    const inputRef = useRef(null);

    const bg   = dark ? '#1a1a2e' : '#f0f2f5';
    const surf  = dark ? '#16213e' : '#ffffff';
    const text  = dark ? '#e0e0e0' : '#222222';
    const border = dark ? '#2a2a4a' : '#e0e0e0';
    const accent = '#0069ff';

    const currentTab = tabs.find(t => t.id === activeTab);

    // ── Открыть DOCX ──────────────────────────────────────────────
    const openFile = useCallback(async () => {
        let file;
        if (window.showOpenFilePicker) {
            try {
                const [handle] = await window.showOpenFilePicker({
                    types: [{ description: 'Word документ', accept: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] } }]
                });
                file = await handle.getFile();
            } catch (e) {
                if (e.name !== 'AbortError') addToast('warning', 'Не удалось открыть файл');
                return;
            }
        } else {
            file = await new Promise(resolve => {
                const inp = document.createElement('input');
                inp.type = 'file'; inp.accept = '.docx';
                inp.onchange = () => resolve(inp.files?.[0] || null);
                inp.click();
            });
            if (!file) return;
        }

        addToast('spin', 'Загружаем ' + file.name + '…');
        try {
            const { fileId, documentKey } = await uploadDocx(file);
            const id = 'tab_' + fileId;
            setTabs(p => [...p, { id, name: file.name, fileId, documentKey }]);
            setActiveTab(id);
            addToast('ok', 'Открыт: ' + file.name);
        } catch (e) {
            addToast('warning', 'Ошибка загрузки: ' + e.message);
        }
    }, [addToast]);

    // ── Создать пустой документ ───────────────────────────────────
    const newDoc = useCallback(async () => {
        // Создаём пустой .docx в памяти через Blob (минимальный OOXML)
        addToast('spin', 'Создаём документ…');
        try {
            const resp = await fetch(`${BACKEND_URL}/api/files/upload`, {
                method: 'POST',
                body: (() => {
                    const fd = new FormData();
                    // Минимальный валидный .docx — 1 пустой абзац
                    const emptyDocx = new Blob([''], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
                    fd.append('file', emptyDocx, 'Новый_документ.docx');
                    return fd;
                })()
            });
            if (!resp.ok) throw new Error(resp.status);
            const { fileId, documentKey } = await resp.json();
            const name = 'Новый_документ_' + tabs.length + '.docx';
            const id   = 'tab_' + fileId;
            setTabs(p => [...p, { id, name, fileId, documentKey }]);
            setActiveTab(id);
            addToast('plus', 'Создан документ');
        } catch (e) {
            addToast('warning', 'Ошибка создания: ' + e.message);
        }
    }, [addToast, tabs.length]);

    const closeTab = useCallback(id => {
        setTabs(p => {
            const next = p.filter(t => t.id !== id);
            if (activeTab === id) setActiveTab(next[next.length - 1]?.id || null);
            return next;
        });
    }, [activeTab]);

    const onSaved = useCallback(newKey => {
        if (!newKey || !activeTab) return;
        setTabs(p => p.map(t => t.id === activeTab ? { ...t, documentKey: newKey } : t));
        addToast('save', 'Документ сохранён');
    }, [activeTab, addToast]);

    const sendMessage = useCallback(() => {
        const text = chatInput.trim();
        if (!text || chatLoading) return;
        setChatInput('');
        sendChat(text);
    }, [chatInput, chatLoading, sendChat]);

    // ── Render ────────────────────────────────────────────────────
    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: bg, color: text, fontFamily: 'system-ui, sans-serif' }}>

            {/* ── TopBar ── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', height: 44, background: surf, borderBottom: `1px solid ${border}`, flexShrink: 0 }}>
                <span style={{ fontWeight: 700, fontSize: 15, color: accent, marginRight: 8 }}>⚖ Мыйзамчы</span>
                <span style={{ fontSize: 11, color: '#888', marginRight: 8 }}>ONLYOFFICE Sandbox</span>
                <button onClick={openFile} style={btnStyle(accent)}>📂 Открыть</button>
                <button onClick={newDoc}  style={btnStyle('#28a745')}>➕ Создать</button>
                <div style={{ flex: 1 }} />
                <button onClick={() => setDark(d => !d)} style={btnStyle('#555')}>
                    {dark ? '☀ Светлая' : '🌙 Тёмная'}
                </button>
                <button onClick={() => setRightOpen(p => !p)} style={btnStyle('#555')}>
                    {rightOpen ? '▶ Скрыть чат' : '◀ Чат'}
                </button>
            </div>

            {/* ── Tabs ── */}
            {tabs.length > 0 && (
                <div style={{ display: 'flex', background: surf, borderBottom: `1px solid ${border}`, overflowX: 'auto', flexShrink: 0 }}>
                    {tabs.map(tab => (
                        <div key={tab.id} onClick={() => setActiveTab(tab.id)}
                            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap',
                                borderBottom: tab.id === activeTab ? `2px solid ${accent}` : '2px solid transparent',
                                color: tab.id === activeTab ? accent : text,
                                background: tab.id === activeTab ? (dark ? '#0a0a1e' : '#f0f6ff') : 'transparent' }}>
                            📄 {tab.name}
                            <span onClick={e => { e.stopPropagation(); closeTab(tab.id); }}
                                style={{ marginLeft: 4, color: '#999', cursor: 'pointer' }}>×</span>
                        </div>
                    ))}
                </div>
            )}

            {/* ── Main area ── */}
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

                {/* Редактор */}
                <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
                    {currentTab ? (
                        <OnlyOfficeEditor
                            key={currentTab.id}
                            fileId={currentTab.fileId}
                            documentKey={currentTab.documentKey}
                            onSaved={onSaved}
                            onError={msg => addToast('warning', msg)}
                        />
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#aaa' }}>
                            <div style={{ fontSize: 48, marginBottom: 16 }}>📄</div>
                            <p style={{ fontSize: 14 }}>Откройте или создайте документ</p>
                            <p style={{ fontSize: 12, color: '#bbb' }}>Поддерживается формат .docx</p>
                        </div>
                    )}
                </div>

                {/* AI Chat Panel */}
                {rightOpen && (
                    <div style={{ width: 340, display: 'flex', flexDirection: 'column', borderLeft: `1px solid ${border}`, background: surf, flexShrink: 0 }}>

                        {/* Header */}
                        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${border}`, fontWeight: 600, fontSize: 13 }}>
                            ⚖ Мыйзамчы AI
                        </div>

                        {/* Messages */}
                        <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {messages.length === 0 && (
                                <p style={{ color: '#aaa', fontSize: 12, textAlign: 'center', marginTop: 24 }}>
                                    Задайте вопрос по праву КР или откройте документ для анализа
                                </p>
                            )}
                            {messages.map((msg, i) => (
                                <div key={i} style={{
                                    alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                                    maxWidth: '85%', padding: '8px 12px', borderRadius: 12,
                                    background: msg.role === 'user' ? accent : (dark ? '#2a2a4a' : '#f0f4ff'),
                                    color: msg.role === 'user' ? '#fff' : text,
                                    fontSize: 13, lineHeight: 1.5
                                }}>
                                    {msg.loading && !msg.content ? '⏳ Думаю…' : msg.content}
                                </div>
                            ))}
                        </div>

                        {/* Input */}
                        <div style={{ padding: 10, borderTop: `1px solid ${border}`, display: 'flex', gap: 8 }}>
                            <input
                                ref={inputRef}
                                value={chatInput}
                                onChange={e => setChatInput(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
                                placeholder="Вопрос по праву КР…"
                                disabled={chatLoading}
                                style={{ flex: 1, padding: '6px 10px', borderRadius: 8, border: `1px solid ${border}`, background: dark ? '#0a0a1e' : '#fff', color: text, fontSize: 13, outline: 'none' }}
                            />
                            <button onClick={sendMessage} disabled={chatLoading}
                                style={{ ...btnStyle(accent), padding: '6px 12px', opacity: chatLoading ? 0.6 : 1 }}>
                                →
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* Toasts */}
            <div style={{ position: 'fixed', bottom: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 8, zIndex: 9999 }}>
                {toasts.map(t => (
                    <div key={t.id} style={{ background: '#333', color: '#fff', padding: '8px 14px', borderRadius: 8, fontSize: 13, display: 'flex', gap: 8, alignItems: 'center', boxShadow: '0 4px 12px rgba(0,0,0,0.3)', animation: 'fadeIn 0.2s ease' }}>
                        <span>{ICONS[t.icon] || t.icon}</span>
                        <span>{t.text}</span>
                    </div>
                ))}
            </div>

            <style>{`@keyframes fadeIn { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:none } }`}</style>
        </div>
    );
}

function btnStyle(bg) {
    return {
        padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
        background: bg, color: '#fff', fontSize: 12, fontWeight: 500,
        transition: 'opacity 0.15s',
    };
}
