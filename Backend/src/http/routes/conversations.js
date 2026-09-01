'use strict';

const express = require('express');
const { buildTimeline } = require('../timeline');

function invalidUuid(error) {
  return error instanceof TypeError && error.message === 'Invalid UUID.';
}

function createRouter({ conversations, runs }) {
  const router = express.Router();

  router.route('/')
    .post(async (req, res, next) => {
      try {
        const title = String(req.body?.title || 'New Conversation').trim();
        if (!title || title.length > 512) {
          return res.status(400).json({ error: 'invalid_title' });
        }

        const conversation = await conversations.create(req.auth.visitorId, title);
        return res.status(201).json({
          conversationId: conversation.publicId,
          title: conversation.title,
          created_at: conversation.createdUnixMs
        });
      } catch (error) {
        return next(error);
      }
    })
    .get(async (req, res, next) => {
      try {
        return res.json(await conversations.list(req.auth.visitorId));
      } catch (error) {
        return next(error);
      }
    });

  router.get('/messages', async (req, res, next) => {
    try {
      const conversationId = String(req.query?.conversationId || '').trim();
      if (!conversationId) return res.status(400).json({ error: 'conversation_id_required' });

      const conversation = await conversations.findOwned(conversationId, req.auth.visitorId);
      if (!conversation) return res.status(404).json({ error: 'conversation_not_found' });
      const [messages, conversationRuns] = await Promise.all([
        conversations.listMessages(conversation.id),
        runs.listForConversation(conversation.id)
      ]);
      return res.json(buildTimeline(messages, conversationRuns));
    } catch (error) {
      if (invalidUuid(error)) return res.status(400).json({ error: 'invalid_conversation_id' });
      return next(error);
    }
  });

  return router;
}

module.exports = { createRouter };
