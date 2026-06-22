'use strict';

// ═══════════════════════════════════════════════════════════════════
// lib/docxGenerator.js — Этап 4 миграции ONLYOFFICE
//
// Конвертирует массив блоков /api/v2/draft-document → .docx файл
// через npm-пакет `docx` (уже в зависимостях).
// Сохраняет в storage/documents/:fileId.docx.
// Регистрирует файл в fileRegistry routes/onlyoffice.js.
//
// Схема блока (normalizeBlock из analyzeV2.js):
//   { kind, align?, runs: [{t, bold?, italic?, underline?}], left?, right? }
//
// Поддерживаемые kind:
//   section_heading | demand_heading | attachment_heading
//   paragraph | list_group | table | signature | requisites_table | spacer
// ═══════════════════════════════════════════════════════════════════

const {
    Document, Packer, Paragraph, TextRun,
    HeadingLevel, AlignmentType, UnderlineType,
    Table, TableRow, TableCell, WidthType,
    BorderStyle, ShadingType,
} = require('docx');

const fs   = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const STORAGE_DIR = path.join(__dirname, '..', 'storage', 'documents');

// ── Гарантируем директорию ──────────────────────────────────────────
fs.mkdir(STORAGE_DIR, { recursive: true }).catch(() => {});

// ── Шрифт документа ────────────────────────────────────────────────
const FONT      = 'Times New Roman';
const SIZE_BODY = 24; // half-points: 24 = 12pt
const SIZE_H1   = 28; // 14pt
const SIZE_H2   = 26; // 13pt
const SIZE_H3   = 24; // 12pt

// ── Выравнивание ───────────────────────────────────────────────────
function toAlign(s) {
    const map = { center: AlignmentType.CENTER, right: AlignmentType.RIGHT,
                  justify: AlignmentType.JUSTIFIED, left: AlignmentType.LEFT };
    return map[String(s || '').toLowerCase()] || AlignmentType.JUSTIFIED;
}

// ── TextRun из run-объекта {t, bold, italic, underline} ────────────
function makeRun(run, extraProps = {}) {
    return new TextRun({
        text:      String(run.t || ''),
        font:      FONT,
        size:      SIZE_BODY,
        bold:      !!run.bold,
        italics:   !!run.italic,
        underline: run.underline ? { type: UnderlineType.SINGLE } : undefined,
        ...extraProps,
    });
}

// ── runs[] → TextRun[] (пустой массив даёт пробел чтобы абзац не схлопнулся) ──
function runsToTextRuns(runs, extraProps = {}) {
    if (!Array.isArray(runs) || !runs.length) {
        return [new TextRun({ text: '', font: FONT, size: SIZE_BODY })];
    }
    return runs.map(r => makeRun(r, extraProps));
}

// ── Markdown-таблица → строки ячеек ────────────────────────────────
function parseMarkdownTable(text) {
    const lines = String(text || '').split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('|') && !/^\|[\s|:-]+\|$/.test(l)); // убираем разделитель

    return lines.map(l =>
        l.replace(/^\||\|$/g, '').split('|').map(c => c.trim())
    );
}

// ── Список: список строк из runs или текста блока ──────────────────
function extractListItems(block) {
    const raw = (block.runs || []).map(r => r.t).join('');
    return raw.split('\n')
        .map(l => l.replace(/^[\s\-–—•*]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
        .filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════
// Конвертация блока → docx-элемент(ы)
// Возвращает массив (один блок может дать несколько Paragraph/Table).
// ═══════════════════════════════════════════════════════════════════

function blockToDocxElements(block) {
    const { kind, align, runs = [], left, right } = block;

    // ── section_heading ─────────────────────────────────────────────
    if (kind === 'section_heading') {
        return [new Paragraph({
            heading: HeadingLevel.HEADING_1,
            alignment: toAlign(align || 'center'),
            spacing: { before: 240, after: 120 },
            children: runsToTextRuns(runs, { bold: true, size: SIZE_H1 }),
        })];
    }

    // ── demand_heading ──────────────────────────────────────────────
    if (kind === 'demand_heading') {
        return [new Paragraph({
            heading: HeadingLevel.HEADING_2,
            alignment: toAlign(align || 'left'),
            spacing: { before: 200, after: 80 },
            children: runsToTextRuns(runs, { bold: true, size: SIZE_H2 }),
        })];
    }

    // ── attachment_heading ──────────────────────────────────────────
    if (kind === 'attachment_heading') {
        return [new Paragraph({
            heading: HeadingLevel.HEADING_3,
            alignment: toAlign(align || 'right'),
            spacing: { before: 160, after: 80 },
            children: runsToTextRuns(runs, { size: SIZE_H3 }),
        })];
    }

    // ── paragraph ───────────────────────────────────────────────────
    if (kind === 'paragraph') {
        return [new Paragraph({
            alignment: toAlign(align || 'justify'),
            indent: { firstLine: 720 }, // 0.5 дюйма красная строка
            spacing: { before: 0, after: 80, line: 360 },
            children: runsToTextRuns(runs),
        })];
    }

    // ── list_group ──────────────────────────────────────────────────
    if (kind === 'list_group') {
        const items = extractListItems(block);
        if (!items.length) return [];
        return items.map(item => new Paragraph({
            alignment: AlignmentType.JUSTIFIED,
            indent: { left: 720, hanging: 360 },
            spacing: { before: 40, after: 40 },
            bullet: { level: 0 },
            children: [new TextRun({ text: item, font: FONT, size: SIZE_BODY })],
        }));
    }

    // ── table ────────────────────────────────────────────────────────
    if (kind === 'table') {
        const raw = (runs || []).map(r => r.t).join('');
        const rows = parseMarkdownTable(raw);
        if (!rows.length) return [];

        const colCount = Math.max(...rows.map(r => r.length));

        const tableRows = rows.map((cells, ri) => new TableRow({
            children: cells.map((cell, ci) => new TableCell({
                width: { size: Math.floor(9000 / colCount), type: WidthType.DXA },
                shading: ri === 0 ? { type: ShadingType.SOLID, color: 'D9E1F2', fill: 'D9E1F2' } : undefined,
                children: [new Paragraph({
                    alignment: AlignmentType.LEFT,
                    children: [new TextRun({
                        text: String(cell || ''),
                        font: FONT,
                        size: SIZE_BODY,
                        bold: ri === 0,
                    })],
                })],
            })),
        }));

        return [new Table({
            width: { size: 9000, type: WidthType.DXA },
            rows: tableRows,
        })];
    }

    // ── requisites_table ─────────────────────────────────────────────
    if (kind === 'requisites_table') {
        const leftLines  = String(left  || '').split('\n');
        const rightLines = String(right || '').split('\n');
        const maxLines   = Math.max(leftLines.length, rightLines.length);
        const tRows = [];

        for (let i = 0; i < maxLines; i++) {
            const lText = leftLines[i]  || '';
            const rText = rightLines[i] || '';
            const isBold = i === 0; // первая строка — название стороны

            tRows.push(new TableRow({
                children: [
                    new TableCell({
                        width: { size: 4500, type: WidthType.DXA },
                        borders: {
                            top:    { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
                            left:   { style: BorderStyle.NONE }, right:  { style: BorderStyle.NONE },
                        },
                        children: [new Paragraph({
                            children: [new TextRun({ text: lText, font: FONT, size: SIZE_BODY, bold: isBold })],
                        })],
                    }),
                    new TableCell({
                        width: { size: 4500, type: WidthType.DXA },
                        borders: {
                            top:    { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE },
                            left:   { style: BorderStyle.NONE }, right:  { style: BorderStyle.NONE },
                        },
                        children: [new Paragraph({
                            children: [new TextRun({ text: rText, font: FONT, size: SIZE_BODY, bold: isBold })],
                        })],
                    }),
                ],
            }));
        }

        return [new Table({
            width: { size: 9000, type: WidthType.DXA },
            rows: tRows,
        })];
    }

    // ── signature ────────────────────────────────────────────────────
    if (kind === 'signature') {
        const raw = (runs || []).map(r => r.t).join('\n');
        return raw.split('\n').filter(Boolean).map(line =>
            new Paragraph({
                alignment: AlignmentType.LEFT,
                spacing: { before: 40, after: 40 },
                children: [new TextRun({ text: line, font: FONT, size: SIZE_BODY })],
            })
        );
    }

    // ── spacer ───────────────────────────────────────────────────────
    if (kind === 'spacer') {
        return [new Paragraph({
            children: [new TextRun({ text: '', font: FONT, size: SIZE_BODY })],
            spacing: { before: 120, after: 0 },
        })];
    }

    // Неизвестный kind → paragraph как fallback
    return [new Paragraph({
        alignment: AlignmentType.JUSTIFIED,
        children: runsToTextRuns(runs),
    })];
}

// ═══════════════════════════════════════════════════════════════════
// buildDocx(blocks, opts) — публичный API
//
// @param {Array}  blocks   — нормализованные блоки из draft-document
// @param {object} opts
//   @param {string} [opts.title]    — заголовок документа (метаданные)
//   @param {string} [opts.docType]  — тип документа (для логов)
//   @param {string} [opts.fileId]   — переиспользовать fileId (для пересборки)
//
// @returns {Promise<{fileId, filePath, bytes}>}
// ═══════════════════════════════════════════════════════════════════
async function buildDocx(blocks, opts = {}) {
    const fileId  = opts.fileId || crypto.randomBytes(12).toString('hex');
    const outPath = path.join(STORAGE_DIR, `${fileId}.docx`);

    // Конвертируем все блоки
    const children = [];
    for (const block of (blocks || [])) {
        if (!block || typeof block !== 'object') continue;
        try {
            children.push(...blockToDocxElements(block));
        } catch (e) {
            console.warn(`[docxGenerator] block kind="${block.kind}" ошибка:`, e.message);
        }
    }

    if (!children.length) {
        children.push(new Paragraph({
            children: [new TextRun({ text: ' ', font: FONT, size: SIZE_BODY })],
        }));
    }

    const doc = new Document({
        creator: 'Мыйзамчы AI',
        title:   opts.title   || 'Документ',
        subject: opts.docType || '',
        styles: {
            default: {
                document: {
                    run: { font: FONT, size: SIZE_BODY },
                },
            },
        },
        sections: [{
            properties: {
                page: {
                    margin: {
                        top:    1701, // 3 см
                        right:  992,  // 1.75 см
                        bottom: 1134, // 2 см
                        left:   1701, // 3 см
                    },
                },
            },
            children,
        }],
    });

    const buffer = await Packer.toBuffer(doc);
    await fsP_write(outPath, buffer);

    console.log(`[docxGenerator] saved: fileId=${fileId} | kind=${opts.docType} | ${buffer.length} bytes | ${blocks.length} blocks`);
    return { fileId, filePath: outPath, bytes: buffer.length };
}

// ═══════════════════════════════════════════════════════════════════
// addRiskComments — добавить комментарии к рискам в существующий .docx
// (используется при режиме Аудит → разметка в ONLYOFFICE)
//
// Примечание: стандарт OOXML (docx) поддерживает комментарии через
// word/comments.xml. Пакет `docx` не экспортирует Comments API в
// стабильной версии v8+, поэтому этот метод создаёт НОВЫЙ документ
// с inline-аннотациями (риск вставляется жирным курсивом в скобках).
// Полноценные комментарии реализуются через ONLYOFFICE Plugin SDK
// (см. onlyoffice-plugin/miyzamchi-ai/plugin.js).
//
// @param {string} srcFileId — fileId исходного .docx
// @param {Array}  risks     — [{fragment, risk, severity}]
// @returns {Promise<{fileId}>} — новый файл с аннотациями
// ═══════════════════════════════════════════════════════════════════
async function buildAnnotatedSummary(srcFileId, risks, opts = {}) {
    const fileId  = crypto.randomBytes(12).toString('hex');
    const outPath = path.join(STORAGE_DIR, `${fileId}.docx`);

    const children = [
        new Paragraph({
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: 'Аудит документа — Мыйзамчы AI', font: FONT, size: SIZE_H1, bold: true })],
        }),
        new Paragraph({ children: [new TextRun({ text: '', font: FONT })] }),
    ];

    for (const risk of (risks || [])) {
        const sev = String(risk.severity || 'medium').toUpperCase();
        const sevColor = sev === 'HIGH' ? 'FF0000' : sev === 'LOW' ? '008000' : 'FF8C00';

        children.push(new Paragraph({
            spacing: { before: 160, after: 40 },
            children: [
                new TextRun({ text: `[${sev}] `, font: FONT, size: SIZE_BODY, bold: true, color: sevColor }),
                new TextRun({ text: String(risk.risk || risk.detail || ''), font: FONT, size: SIZE_BODY }),
            ],
        }));

        if (risk.fragment) {
            children.push(new Paragraph({
                indent: { left: 720 },
                spacing: { before: 0, after: 80 },
                children: [new TextRun({
                    text: '«' + String(risk.fragment).slice(0, 200) + '»',
                    font: FONT, size: 20, italics: true, color: '555555',
                })],
            }));
        }

        if (risk.norm || risk.cited_articles) {
            const norm = risk.norm || (risk.cited_articles || []).join(', ');
            children.push(new Paragraph({
                indent: { left: 720 },
                spacing: { before: 0, after: 120 },
                children: [new TextRun({ text: '📌 ' + norm, font: FONT, size: 20, color: '0052CC' })],
            }));
        }
    }

    const doc = new Document({
        creator: 'Мыйзамчы AI',
        title:   opts.title || 'Аудит документа',
        sections: [{ children }],
    });

    const buffer = await Packer.toBuffer(doc);
    await fsP_write(outPath, buffer);

    console.log(`[docxGenerator] audit: fileId=${fileId} | ${risks.length} рисков | ${buffer.length} bytes`);
    return { fileId, filePath: outPath, bytes: buffer.length };
}

// fs.writeFile helper (именован чтобы не конфликтовать с require('fs'))
const fsP_write = require('fs/promises').writeFile;

module.exports = { buildDocx, buildAnnotatedSummary };
