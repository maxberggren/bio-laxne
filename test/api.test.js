import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import request from 'supertest';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bio-laxne-test-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = tempDir;
process.env.ADMIN_PASSWORD = 'test-secret';
const { app, db } = await import('../server.js');
const agent = request.agent(app);
let screeningId;
let ticketToken;

after(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('health endpoint responds', async () => {
  const response = await request(app).get('/api/health').expect(200);
  assert.equal(response.body.status, 'ok');
});

test('admin authentication rejects a bad password and accepts the configured password', async () => {
  await agent.post('/api/admin/login').send({ password: 'wrong' }).expect(401);
  const response = await agent.post('/api/admin/login').send({ password: 'test-secret' }).expect(200);
  assert.match(response.headers['set-cookie'][0], /bio_admin=/);
});

test('admin can publish a screening with an uploaded poster', async () => {
  const startsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const response = await agent.post('/api/admin/screenings')
    .field('title', 'Testfilmen')
    .field('synopsis', 'Ett test bakom ridån.')
    .field('startsAt', startsAt)
    .field('runtime', '90')
    .field('price', '120')
    .attach('poster', Buffer.from('fake image data'), { filename: 'poster.png', contentType: 'image/png' })
    .expect(201);
  screeningId = response.body.id;
  assert.ok(screeningId);

  const list = await request(app).get('/api/screenings').expect(200);
  assert.equal(list.body[0].title, 'Testfilmen');
  assert.equal(list.body[0].price, 120);
  assert.deepEqual(list.body[0].bookedSeats, []);
});

test('booking is created with a QR ticket and the same seat cannot be double-booked', async () => {
  const response = await request(app).post('/api/bookings').send({ screeningId, seat: 2, guestName: 'Ada Lovelace' }).expect(201);
  ticketToken = response.body.ticketToken;
  assert.match(response.body.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(response.body.seat, 2);
  assert.equal(response.body.screening.price, 120);

  const conflict = await request(app).post('/api/bookings').send({ screeningId, seat: 2, guestName: 'Grace Hopper' }).expect(409);
  assert.match(conflict.body.error, /stolen/);
});

test('ticket validation requires admin and consumes a ticket once', async () => {
  await request(app).post('/api/admin/validate').send({ token: ticketToken }).expect(401);
  const valid = await agent.post('/api/admin/validate').send({ token: ticketToken }).expect(200);
  assert.equal(valid.body.status, 'valid');
  assert.equal(valid.body.booking.guestName, 'Ada Lovelace');

  const used = await agent.post('/api/admin/validate').send({ token: ticketToken }).expect(409);
  assert.equal(used.body.status, 'used');
});

test('a push subscription can be linked to an existing booking for reminders', async () => {
  const subscription = { endpoint: 'https://push.example/subscription', keys: { p256dh: 'key', auth: 'auth' } };
  await request(app).post('/api/push/subscribe').send({ subscription }).expect(201);
  const linked = await request(app).post('/api/push/link-bookings').send({ endpoint: subscription.endpoint, tokens: [ticketToken] }).expect(200);
  assert.equal(linked.body.linked, 1);
  assert.equal(db.prepare('SELECT subscription_endpoint FROM bookings WHERE ticket_token = ?').get(ticketToken).subscription_endpoint, subscription.endpoint);
});

test('a saved ticket token can fetch the ticket again', async () => {
  const response = await request(app).post('/api/tickets/recover').send({ tokens: [ticketToken] }).expect(200);
  assert.equal(response.body.length, 1);
  assert.equal(response.body[0].guestName, 'Ada Lovelace');
  assert.equal(response.body[0].screening.price, 120);
  assert.match(response.body[0].qrDataUrl, /^data:image\/png;base64,/);
});

test('unknown tickets are invalid', async () => {
  const response = await agent.post('/api/admin/validate').send({ token: 'not-a-real-ticket' }).expect(404);
  assert.equal(response.body.status, 'invalid');
});
