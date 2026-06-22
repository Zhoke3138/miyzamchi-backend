// ═══════════════════════════════════════════════════════════════════
// OnlyOfficeEditor.jsx — Изолированная песочница (Этап 2 миграции)
// Заменяет <SuperDocEditor> из @superdoc-dev/react.
//
// Props:
//   fileId       {string}  — ID файла в storage/documents/
//   documentKey  {string}  — Уникальный ключ версии (меняется после каждого сохранения)
//   onSaved      {func}    — Вызывается с новым documentKey после callback status=2
// ═══════════════════════════════════════════════════════════════════

import { useEffect, useRef, useCallback } from 'react';

const BACKEND_URL   = import.meta.env.VITE_BACKEND_URL   || 'https://miyzamchi-backend.onrender.com';
const ONLYOFFICE_URL = import.meta.env.VITE_ONLYOFFICE_URL || 'http://localhost:8080';

let _scriptLoaded  = false;
let _scriptLoading = false;
const _pendingCallbacks = [];

function loadDocsApiScript(onLoaded) {
    if (_scriptLoaded) { onLoaded(); return; }
    _pendingCallbacks.push(onLoaded);
    if (_scriptLoading) return;
    _scriptLoading = true;

    const script = document.createElement('script');
    script.src = `${ONLYOFFICE_URL}/web-apps/apps/api/documents/api.js`;
    script.onload = () => {
        _scriptLoaded = true;
        _scriptLoading = false;
        _pendingCallbacks.forEach(cb => cb());
        _pendingCallbacks.length = 0;
    };
    script.onerror = () => {
        _scriptLoading = false;
        console.error('[OnlyOffice] Не удалось загрузить api.js с', ONLYOFFICE_URL);
    };
    document.head.appendChild(script);
}

export function OnlyOfficeEditor({ fileId, documentKey, onSaved }) {
    const containerRef = useRef(null);
    const editorRef    = useRef(null);
    const containerId  = `oo-editor-${fileId}`;

    const destroyEditor = useCallback(() => {
        if (editorRef.current) {
            try { editorRef.current.destroyEditor(); } catch (_) {}
            editorRef.current = null;
        }
    }, []);

    useEffect(() => {
        if (!fileId) return;

        loadDocsApiScript(async () => {
            if (!window.DocsAPI) {
                console.error('[OnlyOffice] DocsAPI недоступен после загрузки скрипта');
                return;
            }

            destroyEditor();

            // Получаем конфиг с бэкенда (уже подписанный JWT)
            let config;
            try {
                const resp = await fetch(`${BACKEND_URL}/api/files/${fileId}/config`);
                if (!resp.ok) throw new Error(`config fetch: ${resp.status}`);
                config = await resp.json();
            } catch (err) {
                console.error('[OnlyOffice] Не удалось получить config:', err.message);
                return;
            }

            // Переопределяем key если передан свежий documentKey
            if (documentKey) {
                config.document.key = documentKey;
            }

            // Подписка на событие сохранения (для обновления key в родителе)
            config.events = {
                onDocumentStateChange: (event) => {
                    if (event.data === false && typeof onSaved === 'function') {
                        // Документ сохранён — запрашиваем актуальный config с новым key
                        fetch(`${BACKEND_URL}/api/files/${fileId}/config`)
                            .then(r => r.json())
                            .then(c => onSaved(c.document?.key))
                            .catch(() => {});
                    }
                }
            };

            editorRef.current = new window.DocsAPI.DocEditor(containerId, config);
        });

        return destroyEditor;
    }, [fileId, documentKey]);

    return (
        <div
            id={containerId}
            ref={containerRef}
            style={{ width: '100%', height: '100%', minHeight: '600px' }}
        />
    );
}
