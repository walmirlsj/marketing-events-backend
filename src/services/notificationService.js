const nodemailer = require('nodemailer');
const db = require('../config/database');

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: parseInt(process.env.EMAIL_PORT, 10),
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

async function createInAppNotification({ userId, eventId, type, title, message }) {
  await db.query(
    `INSERT INTO notifications (user_id, event_id, type, title, message)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, eventId, type, title, message]
  );
}

async function sendEmail({ to, subject, html }) {
  if (!process.env.EMAIL_USER) return;
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to, subject, html,
    });
  } catch (err) {
    console.error('[NotificationService] Email error:', err.message);
  }
}

async function notifyEventApproved({ eventId, eventName, userEmail, userName, userId }) {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

  await createInAppNotification({
    userId, eventId,
    type: 'event_approved',
    title: '✅ Evento aprovado!',
    message: `Seu evento "${eventName}" foi aprovado e incluído na Base Oficial.`,
  });

  await sendEmail({
    to: userEmail,
    subject: `✅ Evento aprovado: ${eventName}`,
    html: `<div style="font-family: Arial, sans-serif; max-width: 600px;">
      <div style="background: #1D9E75; padding: 24px; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; margin: 0;">Evento Aprovado!</h1>
      </div>
      <div style="background: #f9f9f9; padding: 24px; border-radius: 0 0 8px 8px;">
        <p>Olá, <strong>${userName}</strong>!</p>
        <p>Seu evento <strong>"${eventName}"</strong> foi aprovado e está na Base Oficial.</p>
        <a href="${frontendUrl}/events/${eventId}"
           style="display: inline-block; background: #1D9E75; color: white;
                  padding: 12px 24px; border-radius: 6px; text-decoration: none;">
          Ver Evento
        </a>
      </div>
    </div>`,
  });
}

async function notifyEventRejected({ eventId, eventName, userEmail, userName, userId, reason }) {
  await createInAppNotification({
    userId, eventId,
    type: 'event_rejected',
    title: '❌ Evento não aprovado',
    message: `Seu evento "${eventName}" não foi aprovado.${reason ? ` Motivo: ${reason}` : ''}`,
  });

  await sendEmail({
    to: userEmail,
    subject: `Atualização sobre seu evento: ${eventName}`,
    html: `<div style="font-family: Arial, sans-serif; max-width: 600px;">
      <div style="background: #993C1D; padding: 24px; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; margin: 0;">Evento não aprovado</h1>
      </div>
      <div style="background: #f9f9f9; padding: 24px; border-radius: 0 0 8px 8px;">
        <p>Olá, <strong>${userName}</strong>.</p>
        <p>Seu evento <strong>"${eventName}"</strong> não foi aprovado.</p>
        ${reason ? `<p><strong>Motivo:</strong> ${reason}</p>` : ''}
      </div>
    </div>`,
  });
}

async function getUserNotifications(userId, limit = 20) {
  const { rows } = await db.query(
    `SELECT n.*, e.name as event_name
     FROM notifications n
     LEFT JOIN events e ON n.event_id = e.id
     WHERE n.user_id = $1
     ORDER BY n.created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

async function markAsRead(userId, notificationIds) {
  await db.query(
    `UPDATE notifications SET read = TRUE
     WHERE user_id = $1 AND id = ANY($2::int[])`,
    [userId, notificationIds]
  );
}

module.exports = {
  notifyEventApproved,
  notifyEventRejected,
  getUserNotifications,
  markAsRead,
  createInAppNotification,
};
