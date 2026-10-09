const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { RtcTokenBuilder, RtcRole } = require('agora-token');
require('dotenv').config();

const serviceAccount = require('./azaan-service-account.json');
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const messaging = getMessaging();

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// ── Helper: Generate Agora Token ──────────────────
function generateAgoraToken(agoraChannel, role) {
  const expireAt = Math.floor(Date.now() / 1000) + 7200; // 2 hour token
  const agoraRole = role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
  return RtcTokenBuilder.buildTokenWithUid(
    process.env.AGORA_APP_ID,
    process.env.AGORA_APP_CERTIFICATE,
    agoraChannel, 0, agoraRole, expireAt
  );
}

// ── Helper: Send FCM Push to Channel Subscribers ──
async function notifySubscribers(channelId, channelName, speakerName) {
  const subsSnap = await db.collection('subscriptions')
    .where('channelId', '==', channelId).get();
  if (subsSnap.empty) return 0;

  let sent = 0;
  for (const subDoc of subsSnap.docs) {
    const userId = subDoc.data().userId;
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) continue;

    const user = userDoc.data();
    if (!user.fcmToken) continue;

    const level = user.notificationLevel || 3;

    // FCM message — data payload wakes the app for all levels
    const message = {
      token: user.fcmToken,
      android: { priority: 'high' },
      data: {
        type: 'CHANNEL_LIVE',
        channelId,
        channelName,
        speakerName,
        notificationLevel: String(level),
        agoraAppId: process.env.AGORA_APP_ID
      }
    };

    // Level 1 and 2 also get a visible notification banner
    if (level <= 2) {
      message.notification = {
        title: `🕌 ${channelName} is live`,
        body: `${speakerName} is speaking now`
      };
      message.android.notification = {
        channelId: 'azaan_live',
        priority: 'max',
        sound: 'default',
        // Level 2: show action button
        ...(level === 2 && {
          actions: [{ action: 'LISTEN', title: '▶ Listen Now' }]
        })
      };
    }

    try {
      await messaging.send(message);
      sent++;
    } catch (err) {
      // Remove expired tokens
      if (['messaging/invalid-registration-token',
           'messaging/registration-token-not-registered'].includes(err.code)) {
        await db.collection('users').doc(userId).update({ fcmToken: null });
      }
    }
  }
  return sent;
}

// ══════════════════════════════════════════════════
// REST API
// ══════════════════════════════════════════════════

app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ── Get all channels ──────────────────────────────
app.get('/api/channels', async (req, res) => {
  try {
    const snap = await db.collection('channels')
      .orderBy('createdAt', 'desc').get();
    const channels = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, channels });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Create a channel (speaker does this once) ─────
app.post('/api/channels', async (req, res) => {
  try {
    const { name, speakerName, speakerId, emoji, bio } = req.body;
    if (!name || !speakerName || !speakerId)
      return res.status(400).json({ success: false, error: 'Missing required fields' });

    const ref = await db.collection('channels').add({
      name, speakerName, speakerId,
      emoji: emoji || '🎙️',
      bio: bio || '',
      isLive: false,
      sessionCount: 0,
      subscriberCount: 0,
      createdAt: FieldValue.serverTimestamp()
    });
    res.json({ success: true, channelId: ref.id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Speaker goes live ─────────────────────────────
app.post('/api/go-live', async (req, res) => {
  try {
    const { channelId, speakerId } = req.body;

    const channelDoc = await db.collection('channels').doc(channelId).get();
    if (!channelDoc.exists)
      return res.status(404).json({ success: false, error: 'Channel not found' });

    const channel = channelDoc.data();
    if (channel.speakerId !== speakerId)
      return res.status(403).json({ success: false, error: 'Not your channel' });

    // Check 5-session daily limit
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todaySessions = await db.collection('sessions')
      .where('channelId', '==', channelId)
      .where('startedAt', '>=', todayStart).get();

    if (todaySessions.size >= 5)
      return res.status(429).json({ success: false, error: 'Maximum 5 sessions per day reached. Come back tomorrow.' });

    // Generate Agora token for speaker
    const agoraChannel = `azaan_${channelId}`;
    const agoraToken = generateAgoraToken(agoraChannel, 'publisher');

    // Create session record
    const sessionRef = await db.collection('sessions').add({
      channelId, speakerId, agoraChannel,
      startedAt: FieldValue.serverTimestamp(),
      endedAt: null, autoEnded: false, listenerCount: 0
    });

    // Update channel to live
    await channelDoc.ref.update({
      isLive: true,
      currentSessionId: sessionRef.id,
      agoraChannel,
      liveStartedAt: FieldValue.serverTimestamp(),
      sessionCount: FieldValue.increment(1)
    });

    // Push notifications to subscribers
    const notified = await notifySubscribers(
      channelId, channel.name, channel.speakerName
    );

    console.log(`[🎙️] "${channel.name}" went live → ${notified} notified`);

    res.json({
      success: true,
      sessionId: sessionRef.id,
      agoraToken,
      agoraChannel,
      agoraAppId: process.env.AGORA_APP_ID,
      notifiedCount: notified,
      sessionsToday: todaySessions.size + 1,
      sessionsRemaining: 4 - todaySessions.size
    });
  } catch (err) {
    console.error('[go-live error]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Speaker ends session ──────────────────────────
app.post('/api/end-live', async (req, res) => {
  try {
    const { channelId, sessionId } = req.body;

    await db.collection('sessions').doc(sessionId).update({
      endedAt: FieldValue.serverTimestamp()
    });
    await db.collection('channels').doc(channelId).update({
      isLive: false, currentSessionId: null, agoraChannel: null
    });

    io.to(channelId).emit('session:ended', { channelId, reason: 'speaker_ended' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Get Agora token for listener ──────────────────
app.post('/api/listener-token', async (req, res) => {
  try {
    const { channelId } = req.body;
    const channelDoc = await db.collection('channels').doc(channelId).get();

    if (!channelDoc.exists || !channelDoc.data().isLive)
      return res.status(404).json({ success: false, error: 'Channel is not live' });

    const channel = channelDoc.data();
    const agoraToken = generateAgoraToken(channel.agoraChannel, 'subscriber');

    res.json({
      success: true,
      agoraToken,
      agoraChannel: channel.agoraChannel,
      agoraAppId: process.env.AGORA_APP_ID,
      channelName: channel.name,
      speakerName: channel.speakerName
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Register user / update FCM token ─────────────
app.post('/api/users/register', async (req, res) => {
  try {
    const { userId, fcmToken, displayName, notificationLevel } = req.body;
    await db.collection('users').doc(userId).set({
      fcmToken, displayName: displayName || 'User',
      notificationLevel: notificationLevel || 3,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Update notification level ─────────────────────
app.post('/api/users/notification-level', async (req, res) => {
  try {
    const { userId, level } = req.body;
    await db.collection('users').doc(userId).update({ notificationLevel: level });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Subscribe / Unsubscribe ───────────────────────
app.post('/api/subscribe', async (req, res) => {
  try {
    const { userId, channelId } = req.body;
    const existing = await db.collection('subscriptions')
      .where('userId', '==', userId).where('channelId', '==', channelId).get();
    if (!existing.empty) return res.json({ success: true, alreadySubscribed: true });

    await db.collection('subscriptions').add({
      userId, channelId,
      subscribedAt: FieldValue.serverTimestamp()
    });
    await db.collection('channels').doc(channelId).update({
      subscriberCount: FieldValue.increment(1)
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/unsubscribe', async (req, res) => {
  try {
    const { userId, channelId } = req.body;
    const snap = await db.collection('subscriptions')
      .where('userId', '==', userId).where('channelId', '==', channelId).get();
    await Promise.all(snap.docs.map(d => d.ref.delete()));
    await db.collection('channels').doc(channelId).update({
      subscriberCount: FieldValue.increment(-1)
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/subscriptions/:userId', async (req, res) => {
  try {
    const snap = await db.collection('subscriptions')
      .where('userId', '==', req.params.userId).get();
    res.json({ success: true, channelIds: snap.docs.map(d => d.data().channelId) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════
// SOCKET.IO — Real-time updates to app
// ══════════════════════════════════════════════════
io.on('connection', (socket) => {
  socket.on('watch:channel', ({ channelId }) => socket.join(channelId));
  socket.on('unwatch:channel', ({ channelId }) => socket.leave(channelId));
});

// ══════════════════════════════════════════════════
// AUTO-END sessions that exceed 7 minutes
// ══════════════════════════════════════════════════
setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 7 * 60 * 1000);
    const snap = await db.collection('channels')
      .where('isLive', '==', true)
      .where('liveStartedAt', '<=', cutoff).get();

    for (const doc of snap.docs) {
      const ch = doc.data();
      await doc.ref.update({ isLive: false, currentSessionId: null, agoraChannel: null });
      if (ch.currentSessionId) {
        await db.collection('sessions').doc(ch.currentSessionId).update({
          endedAt: FieldValue.serverTimestamp(), autoEnded: true
        });
      }
      io.to(doc.id).emit('session:ended', { channelId: doc.id, reason: 'time_limit' });
      console.log(`[⏱️] Auto-ended: "${ch.name}"`);
    }
  } catch (err) {
    console.error('[auto-end]', err.message);
  }
}, 30000); // check every 30 seconds

// ── Start ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n🕌  Azaan server → http://localhost:${PORT}`);
  console.log(`    Health check → http://localhost:${PORT}/health\n`);
});