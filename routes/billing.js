'use strict';
// routes/billing.js — подписки и тарифы Мыйзамчы AI
// Эндпоинты:
//   GET  /api/billing/me       — статус подписки + остатки лимитов
//   POST /api/billing/history  — история транзакций (заглушка для Phase 4)

const express = require('express');

const PLAN_LIMITS = {
    basic:    { ai: 50,  docs: 20  },
    standard: { ai: 150, docs: 60  },
    pro:      { ai: 400, docs: 150 }
};

module.exports = function createBillingRouter({ SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, verifySupabaseJWT }) {
    const router = express.Router();

    const sbHeaders = () => ({
        'apikey':        SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json'
    });

    // ── GET /api/billing/me ───────────────────────────────────────────────
    // Возвращает профиль подписки текущего пользователя.
    // Если подписка истекла (expires_at < NOW) — автоматически помечает expired.
    router.get('/me', verifySupabaseJWT, async (req, res) => {
        if (!SUPABASE_SERVICE_ROLE_KEY) {
            // Dev-режим без Supabase: возвращаем фейковый активный профиль
            return res.json({
                subscription_plan: 'pro', subscription_status: 'active',
                ai_requests_used: 0, ai_requests_limit: 999,
                documents_used: 0, documents_limit: 999,
                email: req.userEmail || 'dev@localhost'
            });
        }

        try {
            const r = await fetch(
                `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${req.userId}&select=*&limit=1`,
                { headers: sbHeaders() }
            );
            const rows = await r.json();
            const profile = Array.isArray(rows) ? rows[0] : null;

            if (!profile) {
                return res.status(404).json({ error: 'Profile not found' });
            }

            // Автоматически expire если срок вышел
            if (
                profile.subscription_status === 'active' &&
                profile.subscription_expires_at &&
                new Date(profile.subscription_expires_at) < new Date()
            ) {
                await fetch(
                    `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${req.userId}`,
                    {
                        method: 'PATCH',
                        headers: sbHeaders(),
                        body: JSON.stringify({ subscription_status: 'expired', updated_at: new Date().toISOString() })
                    }
                );
                profile.subscription_status = 'expired';
            }

            res.json({
                subscription_plan:       profile.subscription_plan,
                subscription_status:     profile.subscription_status,
                subscription_expires_at: profile.subscription_expires_at,
                ai_requests_used:        profile.ai_requests_used,
                ai_requests_limit:       profile.ai_requests_limit,
                documents_used:          profile.documents_used,
                documents_limit:         profile.documents_limit,
                email:                   profile.email,
                full_name:               profile.full_name,
                avatar_url:              profile.avatar_url
            });
        } catch (err) {
            console.error('[Billing] /me error:', err.message);
            res.status(500).json({ error: 'Failed to fetch profile' });
        }
    });

    // ── GET /api/billing/history ──────────────────────────────────────────
    router.get('/history', verifySupabaseJWT, async (req, res) => {
        if (!SUPABASE_SERVICE_ROLE_KEY) return res.json([]);
        try {
            const r = await fetch(
                `${SUPABASE_URL}/rest/v1/payment_transactions?user_id=eq.${req.userId}&select=id,plan,amount_som,status,created_at,paid_at&order=created_at.desc`,
                { headers: sbHeaders() }
            );
            const rows = await r.json();
            res.json(Array.isArray(rows) ? rows : []);
        } catch (err) {
            console.error('[Billing] /history error:', err.message);
            res.status(500).json({ error: 'Failed to fetch history' });
        }
    });

    // ── POST /api/billing/activate (admin helper — вручную активировать тариф) ──
    // Временный эндпоинт для ручной активации первых клиентов (до интеграции MBank).
    // Защищён ADMIN_SECRET. Удалить/убрать после подключения MBank.
    router.post('/activate', async (req, res) => {
        const ADMIN_SECRET = process.env.ADMIN_SECRET;
        if (!ADMIN_SECRET) return res.status(403).json({ error: 'Admin endpoint disabled' });
        const provided = req.headers['x-admin-secret'];
        if (provided !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });

        const { user_id, plan } = req.body || {};
        if (!user_id || !PLAN_LIMITS[plan]) {
            return res.status(400).json({ error: 'user_id and valid plan required' });
        }
        const limits = PLAN_LIMITS[plan];
        const now = new Date();
        const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

        try {
            const r = await fetch(
                `${SUPABASE_URL}/rest/v1/user_profiles?id=eq.${user_id}`,
                {
                    method: 'PATCH',
                    headers: sbHeaders(),
                    body: JSON.stringify({
                        subscription_plan:       plan,
                        subscription_status:     'active',
                        subscription_started_at: now.toISOString(),
                        subscription_expires_at: expires.toISOString(),
                        ai_requests_limit:       limits.ai,
                        ai_requests_used:        0,
                        documents_limit:         limits.docs,
                        documents_used:          0,
                        updated_at:              now.toISOString()
                    })
                }
            );
            if (!r.ok) {
                const err = await r.text();
                return res.status(500).json({ error: err });
            }
            res.json({ ok: true, user_id, plan, expires: expires.toISOString() });
        } catch (err) {
            console.error('[Billing] /activate error:', err.message);
            res.status(500).json({ error: 'Activation failed' });
        }
    });

    return router;
};
