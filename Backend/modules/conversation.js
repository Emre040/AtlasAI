'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');

const TBL_CONV = process.env.HPA_TBL_CONVERSATIONS;
const TBL_MSG = process.env.HPA_TBL_MESSAGES;

/**
 * Creates the router for all conversation-related endpoints.
 * @param {object} db - The database connection pool.
 * @returns {express.Router}
 */
exports.createRouter = function(db) {
    const router = express.Router();

    // Handles POST /conversations/ and GET /conversations/
    router.route('/')
        .post(async (req, res, next) => {
            try {
                const { cookieId, title } = req.body || {};
                if (!cookieId || typeof cookieId !== 'string') return res.status(400).json({ error: 'cookieId is required' });
                const convId = uuidv4();
                const safeTitle = (title && String(title).trim()) || 'New Conversation';
                await db.query('INSERT INTO ?? (uuid, cookie_value, title) VALUES (?, ?, ?)', [TBL_CONV, convId, cookieId.trim(), safeTitle]);
                res.status(201).json({ conversationId: convId, title: safeTitle });
            } catch (err) {
                next(err);
            }
        })
        .get(async (req, res, next) => {
            try {
                const { cookieId } = req.query || {};
                if (!cookieId || typeof cookieId !== 'string') return res.status(400).json({ error: 'cookieId query parameter is required' });
            const [conversations] = await db.query(
                `SELECT c.uuid as id, c.title, c.updated_at as date,
                        (SELECT m.text
                         FROM ?? m
                         WHERE m.conversation_uuid = c.uuid AND m.sender_type = 'user'
                         ORDER BY m.id ASC
                         LIMIT 1) AS preview
                 FROM ?? c
                 WHERE c.cookie_value = ?
                 ORDER BY c.updated_at DESC
                 LIMIT 200`,
                [TBL_MSG, TBL_CONV, cookieId.trim()]
            );
            res.json(conversations);
        } catch (err) {
            next(err);
        }
        });

    // Handles GET /conversations/messages
    router.get('/messages', async (req, res, next) => {
        try {
            const { cookieId, conversationId } = req.query || {};
            if (!cookieId || !conversationId) return res.status(400).json({ error: 'cookieId and conversationId query parameters are required' });
            const [[conv]] = await db.query('SELECT uuid FROM ?? WHERE uuid = ? AND cookie_value = ? LIMIT 1', [TBL_CONV, conversationId, cookieId.trim()]);
            if (!conv) return res.status(403).json({ error: 'Conversation not found or access denied.' });
            const [messages] = await db.query("SELECT id, sender_type AS type, text, created_at FROM ?? WHERE conversation_uuid = ? ORDER BY id ASC LIMIT 1000", [TBL_MSG, conversationId]);
            res.json(messages);
        } catch (err) {
            next(err);
        }
    });

    return router;
};
